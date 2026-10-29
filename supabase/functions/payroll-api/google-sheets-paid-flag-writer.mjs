import { calculateAssignmentHashes } from "./assignment-identity.mjs";
import { contentAddressedPayrollEventRef } from "./payroll-source-projection.mjs";

const SHEETS_API = "https://sheets.googleapis.com/v4";
const PAY_COLUMNS = Object.freeze({ TP: { field: "paidTP", column: "AF", index: 31 }, TA1: { field: "paidTA1", column: "AG", index: 32 }, TA2: { field: "paidTA2", column: "AH", index: 33 } });
const META_KEY = "lrs.payroll.assignment.v1";
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])-Q[12]$/;

function fail(code, reviewRequired = false, outcomeUnknown = false) {
  const error = new Error(code);
  error.reviewRequired = reviewRequired;
  error.outcomeUnknown = outcomeUnknown;
  return error;
}
function assertReady(config) {
  if (config?.enabled !== true || config?.writeEnabled !== true || config?.sourceWriteGuardVerified !== true ||
      config?.sourceTabName !== "REGISTRO_CASOS" || !config?.spreadsheetId || !Number.isInteger(config?.sourceTabId) ||
      typeof config?.getAccessToken !== "function") throw fail("google_sheets_paid_writer_disabled");
}
function cell(row, index) { return Array.isArray(row) && index < row.length ? row[index] : undefined; }
function sheetDate(value) {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(Date.UTC(1899, 11, 30) + Math.round(value * 86400000)).toISOString().slice(0, 10);
  const match = String(value ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || "";
}
function sourceRow(values) {
  if (!Array.isArray(values) || values.length < 41) throw fail("sheet_row_incomplete", true);
  return {
    date: sheetDate(cell(values, 1)), period: cell(values, 5) ?? "", category: cell(values, 6) ?? "", client: cell(values, 7) ?? "",
    activity: cell(values, 9) ?? "", caseName: cell(values, 10) ?? "", status: cell(values, 15) ?? "",
    tp: cell(values, 20) ?? "", ta1: cell(values, 21) ?? "", ta2: cell(values, 22) ?? "",
    amountTP: cell(values, 23) ?? "", amountTA1: cell(values, 24) ?? "", amountTA2: cell(values, 25) ?? "",
    paidTP: cell(values, 31), paidTA1: cell(values, 32), paidTA2: cell(values, 33),
    project: cell(values, 40) ?? ""
  };
}
function idRole(assignmentId, role) { return `${assignmentId}:${role}`; }

/**
 * Google Sheets has no cell-level compare-and-set. This writer therefore stays
 * disabled unless the deployment asserts the source mutation guard. It locates
 * rows by document metadata, pre-reads and fingerprints the row, sends a
 * DataFilter write with null placeholders (which Values API skips), and
 * verifies the same metadata row after the write. Only AF, AG, or AH receives
 * a non-null value. A mismatched/ambiguous row is never written.
 */
export function createGoogleSheetsPaidFlagWriter({ config = {}, fetcher = globalThis.fetch, core } = {}) {
  async function request(path, { method = "GET", body, outcomeUnknown = false } = {}) {
    assertReady(config);
    if (typeof fetcher !== "function" || !core?.buildAssignments || !core?.paidState) throw fail("google_sheets_paid_writer_not_configured");
    let token;
    try { token = await config.getAccessToken(); } catch (_) { throw fail("google_sheets_access_token_unavailable"); }
    if (typeof token !== "string" || !token.trim()) throw fail("google_sheets_access_token_unavailable");
    let response;
    try {
      response = await fetcher(`${SHEETS_API}${path}`, {
        method, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch (_) { throw fail("google_sheets_request_failed", false, outcomeUnknown); }
    if (!response.ok) throw fail(response.status === 412 ? "sheet_revision_conflict" : `google_sheets_http_${response.status}`, false, outcomeUnknown && (response.status >= 500 || response.status === 408 || response.status === 429));
    try { return await response.json(); } catch (_) { throw fail("google_sheets_response_invalid", false, outcomeUnknown); }
  }

  function spreadsheetPath(suffix) { return `/spreadsheets/${encodeURIComponent(config.spreadsheetId)}${suffix}`; }
  async function findMetadata(metadataId, assignmentId, role) {
    if (!Number.isSafeInteger(metadataId) || metadataId <= 0 || !/^[0-9a-f-]{36}$/i.test(assignmentId || "") || !PAY_COLUMNS[role]) throw fail("sheet_assignment_identity_invalid", true);
    const payload = await request(spreadsheetPath("/developerMetadata:search"), { method: "POST", body: {
      dataFilters: [{ developerMetadataLookup: { metadataId } }]
    } });
    const matches = Array.isArray(payload.matchedDeveloperMetadata) ? payload.matchedDeveloperMetadata : [];
    if (matches.length !== 1) throw fail("sheet_assignment_metadata_ambiguous", true);
    const record = matches[0]?.developerMetadata;
    const dimension = record?.location?.dimensionRange;
    if (record?.metadataId !== metadataId || record?.metadataKey !== META_KEY || record?.metadataValue !== idRole(assignmentId, role) ||
        record?.location?.locationType !== "ROW" || dimension?.sheetId !== config.sourceTabId ||
        !Number.isInteger(dimension?.startIndex) || dimension?.endIndex !== dimension.startIndex + 1) {
      throw fail("sheet_assignment_metadata_mismatch", true);
    }
    return { dataFilter: { developerMetadataLookup: { metadataId } }, dimension };
  }

  async function readAssignment({ assignmentId, technicianId, role, sheetMetadataId, sourceFingerprintHash, amount, periodKey }) {
    if (!PERIOD.test(periodKey || "") || !technicianId || !/^[a-f0-9]{64}$/.test(sourceFingerprintHash || "") || !Number.isFinite(amount) || amount < 0) {
      throw fail("sheet_assignment_snapshot_invalid", true);
    }
    const { dataFilter } = await findMetadata(sheetMetadataId, assignmentId, role);
    const response = await request(spreadsheetPath("/values:batchGetByDataFilter"), { method: "POST", body: {
      dataFilters: [dataFilter], majorDimension: "ROWS", valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER"
    } });
    const ranges = (response.valueRanges || []).map(item => item.valueRange).filter(Boolean);
    if (ranges.length !== 1 || !Array.isArray(ranges[0].values) || ranges[0].values.length !== 1) throw fail("sheet_assignment_data_ambiguous", true);
    const row = sourceRow(ranges[0].values[0]);
    const line = core.buildAssignments([row]).lines.find(item => item.role === role);
    if (!line) throw fail("sheet_assignment_source_mismatch", true);
    const eventRef = await contentAddressedPayrollEventRef(row, line);
    if (!eventRef) throw fail("sheet_assignment_source_mismatch", true);
    const hashRecord = await calculateAssignmentHashes({
      eventRef, periodKey: line.periodKey, date: line.date, project: line.project, client: line.client,
      caseName: line.caseName, activity: line.activity, technicianId, role: line.role,
      amount: line.amount, jobStatus: line.jobStatus, cancellationFee: line.cancellationFee
    });
    if (!hashRecord.sourceFingerprintHash || hashRecord.sourceFingerprintHash !== sourceFingerprintHash || line.periodKey !== periodKey ||
        line.amount !== amount || line.technician !== row[({ TP: "tp", TA1: "ta1", TA2: "ta2" })[role]]) {
      throw fail("sheet_assignment_fingerprint_mismatch", true);
    }
    const paidFlag = row[PAY_COLUMNS[role].field];
    return { dataFilter, row, line, paidFlag, paidState: core.paidState(paidFlag) };
  }

  async function preflightClosedSnapshot({ snapshot }) {
    assertReady(config);
    if (!snapshot || snapshot.state !== "closed" || snapshot.frozen !== true || !snapshot.snapshotDigest && !snapshot.digest ||
        !Array.isArray(snapshot.lines) || !snapshot.lines.length) return { state: "needs_review", reason: "closed_snapshot_required" };
    for (const line of snapshot.lines) {
      if (line.amount === 0) continue;
      if (line.paidFlag === true) continue;
      if (line.paidFlag !== false || !line.sheetMetadataId) return { state: "needs_review", reason: "payment_flag_or_row_metadata_missing" };
      let current;
      try { current = await readAssignment(line); } catch (_) { return { state: "needs_review", reason: "sheet_assignment_preflight_failed" }; }
      if (current.paidState !== "unpaid") return { state: "needs_review", reason: "manual_payment_conflict" };
    }
    return { state: "ready" };
  }

  async function setPaidFlagByStableAssignmentId(input) {
    assertReady(config);
    const { assignmentId, technicianId, role, sheetMetadataId, sourceFingerprintHash, amount, periodKey, expectedPaidFlag, paidFlag } = input || {};
    if (expectedPaidFlag !== false || paidFlag !== true || input.origin !== "automatic-calendar-policy" || !input.snapshotId || !input.idempotencyKey) {
      throw fail("sheet_paid_write_policy_invalid", true);
    }
    const current = await readAssignment({ assignmentId, technicianId, role, sheetMetadataId, sourceFingerprintHash, amount, periodKey });
    if (current.paidState === "paid") return { updated: false, conflict: true, reason: "manual_payment_conflict" };
    if (current.paidState !== "unpaid") throw fail("sheet_paid_flag_unknown", true);
    const column = PAY_COLUMNS[role];
    const values = Array(column.index + 1).fill(null);
    values[column.index] = true;
    const result = await request(spreadsheetPath("/values:batchUpdateByDataFilter"), { method: "POST", outcomeUnknown: true, body: {
      valueInputOption: "RAW",
      includeValuesInResponse: true,
      data: [{ dataFilter: current.dataFilter, majorDimension: "ROWS", values: [values] }]
    } });
    if (result.totalUpdatedCells !== 1 || result.totalUpdatedRows !== 1 || result.totalUpdatedSheets !== 1) throw fail("sheet_paid_write_result_unverified", false, true);
    const after = await readAssignment({ assignmentId, technicianId, role, sheetMetadataId, sourceFingerprintHash, amount, periodKey });
    if (after.paidState !== "paid") throw fail("sheet_paid_write_readback_failed", false, true);
    return { updated: true, verified: true, changedRange: `${column.column}`, origin: "automatic-calendar-policy", bankTransferVerified: false };
  }

  return Object.freeze({ preflightClosedSnapshot, setPaidFlagByStableAssignmentId });
}
