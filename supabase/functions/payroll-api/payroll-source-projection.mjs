import { calculateAssignmentHashes, resolveAssignmentIdentities } from "./assignment-identity.mjs";
import { sha256Hex } from "../../../stable-json.mjs";

const SOURCE_FIELDS = Object.freeze([
  "date", "period", "category", "client", "project", "activity", "caseName", "status",
  "tp", "ta1", "ta2", "amountTP", "amountTA1", "amountTA2", "report"
]);
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-Q[12]$/;

function text(value) { return String(value ?? "").normalize("NFC").replace(/\s+/g, " ").trim(); }
function nameKey(value) { return text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleUpperCase("en-US"); }
function scalar(value) {
  if (value == null) return "";
  if (typeof value === "string") return text(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  return "[unsupported-source-value]";
}

function periodFor(row, core) {
  const date = core.parseDate(row?.date);
  const half = core.parseHalf(row?.period);
  if (!date || !half) return null;
  return core.periodKey(Number(date.slice(0, 4)), Number(date.slice(5, 7)), half);
}

export async function computePeriodSourceRevision(rows, periodKey, core) {
  if (!core?.parseDate || !core?.parseHalf || !core?.periodKey || !PERIOD_PATTERN.test(periodKey || "")) throw new TypeError("period_source_revision_input_invalid");
  const records = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (periodFor(row, core) !== periodKey) continue;
    records.push(SOURCE_FIELDS.map(field => [field, scalar(row?.[field])]));
  }
  if (!records.length) throw new TypeError("period_source_revision_empty");
  records.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return sha256Hex({ schema: "lrs-payroll-source-v1", periodKey, records });
}

export async function contentAddressedPayrollEventRef(row, line) {
  const identityParts = {
    date: text(line.date), periodKey: text(line.periodKey), category: text(row.category),
    client: text(line.client), project: text(line.project), activity: text(line.activity), caseName: text(line.caseName)
  };
  if (Object.values(identityParts).some(value => !value)) return null;
  // Content-addressed event reference is independent of spreadsheet row position.
  // Exact duplicate source records remain ambiguous and must be reviewed.
  return `content:${await sha256Hex(identityParts)}`;
}

function buildTechnicianLookup(roster) {
  const byName = new Map();
  for (const item of Array.isArray(roster) ? roster : []) {
    if (!item || item.active !== true || !text(item.technicianId) || !text(item.displayName)) continue;
    const key = nameKey(item.displayName);
    const matches = byName.get(key) || [];
    matches.push(text(item.technicianId));
    byName.set(key, matches);
  }
  return name => {
    const matches = byName.get(nameKey(name)) || [];
    return matches.length === 1 ? matches[0] : null;
  };
}

/**
 * Maps Sheet rows to the private sidecar identity store. No row number is
 * persisted or used as identity. First-seen or changed content remains
 * review-only until a user verifies the sidecar mapping.
 */
export async function projectPayrollRowsWithAssignmentIds(rows, { core, roster, identityStore, createId } = {}) {
  if (!core?.buildAssignments || !core?.parseDate || !core?.parseHalf || !core?.periodKey) throw new TypeError("payroll_core_required");
  if (!identityStore) throw new TypeError("private_assignment_identity_store_required");
  if (!Array.isArray(rows)) throw new TypeError("source_rows_required");
  const findTechnicianId = buildTechnicianLookup(roster);
  const projectedRows = rows.map(row => ({ ...row, assignmentIds: {}, assignmentIdentityStates: {}, assignmentFingerprints: {}, assignmentTechnicianIds: {}, assignmentSheetMetadataIds: {} }));
  const candidates = [];
  for (let index = 0; index < rows.length; index++) {
    const source = rows[index] || {};
    const lineModel = core.buildAssignments([source]);
    const target = projectedRows[index];
    for (const line of lineModel.lines) {
      const technicianId = findTechnicianId(line.technician);
      if (!technicianId) {
        target.assignmentIdentityStates[line.role] = "unresolved";
        continue;
      }
      const eventRef = await contentAddressedPayrollEventRef(source, line);
      if (!eventRef) {
        target.assignmentIdentityStates[line.role] = "unresolved";
        continue;
      }
      candidates.push({ target, role: line.role, input: {
        eventRef, periodKey: line.periodKey, date: line.date, project: line.project, client: line.client,
        caseName: line.caseName, activity: line.activity, technicianId, role: line.role,
        amount: line.amount, jobStatus: line.jobStatus, cancellationFee: line.cancellationFee
      } });
    }
  }

  const results = await resolveAssignmentIdentities(candidates.map(item => item.input), { store: identityStore, createId });
  results.forEach((result, index) => {
    const candidate = candidates[index];
    candidate.target.assignmentIdentityStates[candidate.role] = result.state;
    if (result.state === "verified") {
      candidate.target.assignmentIds[candidate.role] = result.assignmentId;
      candidate.target.assignmentTechnicianIds[candidate.role] = candidate.input.technicianId;
      if (Number.isSafeInteger(result.sheetMetadataId) && result.sheetMetadataId > 0) {
        candidate.target.assignmentSheetMetadataIds[candidate.role] = result.sheetMetadataId;
      }
    }
    if (result.sourceFingerprintHash) candidate.target.assignmentFingerprints[candidate.role] = result.sourceFingerprintHash;
  });

  const sourceRevisions = {};
  const periods = new Set(rows.map(row => periodFor(row, core)).filter(Boolean));
  for (const periodKey of periods) sourceRevisions[periodKey] = await computePeriodSourceRevision(rows, periodKey, core);
  return { rows: projectedRows, sourceRevisions };
}

/**
 * A selected-scope user must not receive sibling slot names, rates or flags
 * from a row that also contains another technician. Only verified stable
 * assignments in the caller's scope survive projection.
 */
export function filterPayrollRowsByTechnicianScope(rows, technicianIds) {
  if (!Array.isArray(rows) || !Array.isArray(technicianIds) || technicianIds.length === 0) throw new TypeError("selected_payroll_scope_required");
  const allowed = new Set(technicianIds.filter(value => typeof value === "string" && value.trim()).map(value => value.trim()));
  if (!allowed.size) throw new TypeError("selected_payroll_scope_required");
  const slotDefs = [
    ["TP", "tp", "amountTP", "paidTP"],
    ["TA1", "ta1", "amountTA1", "paidTA1"],
    ["TA2", "ta2", "amountTA2", "paidTA2"]
  ];
  const selectedRows = [];
  for (const row of rows) {
    const visible = slotDefs.filter(([role]) => row?.assignmentIdentityStates?.[role] === "verified" &&
      allowed.has(row?.assignmentTechnicianIds?.[role]) && row?.assignmentIds?.[role]);
    if (!visible.length) continue;
    const selectedRoles = new Set(visible.map(([role]) => role));
    const copy = { ...row, assignmentIds: {}, assignmentIdentityStates: {}, assignmentFingerprints: {}, assignmentTechnicianIds: {}, assignmentSheetMetadataIds: {} };
    for (const [role, technicianField, amountField, paidField] of slotDefs) {
      if (selectedRoles.has(role)) {
        copy.assignmentIds[role] = row.assignmentIds[role];
        copy.assignmentIdentityStates[role] = "verified";
        copy.assignmentFingerprints[role] = row.assignmentFingerprints?.[role];
        copy.assignmentTechnicianIds[role] = row.assignmentTechnicianIds[role];
        if (Number.isSafeInteger(row.assignmentSheetMetadataIds?.[role])) copy.assignmentSheetMetadataIds[role] = row.assignmentSheetMetadataIds[role];
      } else {
        copy[technicianField] = "";
        copy[amountField] = "";
        copy[paidField] = undefined;
      }
    }
    selectedRows.push(copy);
  }
  return selectedRows;
}

export function createPayrollReadProjection({ core, identityStore, readRoster } = {}) {
  if (!core?.buildAssignments || !identityStore || typeof readRoster !== "function") throw new TypeError("payroll_projection_dependencies_required");
  return async function projectRead({ rows, scopeMode, technicianIds = [] } = {}) {
    if (!Array.isArray(rows)) throw new TypeError("payroll_source_rows_required");
    const roster = await readRoster();
    if (!Array.isArray(roster)) throw new TypeError("payroll_technician_roster_invalid");
    const projected = await projectPayrollRowsWithAssignmentIds(rows, { core, roster, identityStore });
    if (scopeMode === "all") return projected;
    if (scopeMode !== "selected") throw new TypeError("payroll_scope_invalid");
    const filtered = filterPayrollRowsByTechnicianScope(projected.rows, technicianIds);
    const periods = new Set(filtered.flatMap(row => [row.date && core.periodKey(Number(row.date.slice(0, 4)), Number(row.date.slice(5, 7)), core.parseHalf(row.period))].filter(Boolean)));
    const sourceRevisions = Object.fromEntries([...periods].filter(key => projected.sourceRevisions[key]).map(key => [key, projected.sourceRevisions[key]]));
    return { rows: filtered, sourceRevisions };
  };
}
