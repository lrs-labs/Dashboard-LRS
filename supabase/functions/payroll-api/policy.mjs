export function authorizePayrollRead(access) {
  if (!access || access.is_active !== true || access.can_view_payroll !== true) {
    return { ok: false, reason: "not_authorized" };
  }
  if (access.scope_mode === "all") return { ok: true, scope: "all" };
  if (access.scope_mode === "selected" && Array.isArray(access.technician_ids) && access.technician_ids.length > 0) {
    return { ok: true, scope: "selected", technicianIds: [...new Set(access.technician_ids.filter(id => typeof id === "string" && id.trim()))] };
  }
  return { ok: false, reason: "scope_not_configured" };
}

export function authorizeDashboardRead(access) {
  if (!access || access.is_active !== true || access.can_view_dashboard !== true) {
    return { ok: false, reason: "not_authorized" };
  }
  if (access.scope_mode === "all") return { ok: true, scope: "all" };
  if (access.scope_mode === "selected" && Array.isArray(access.technician_ids) && access.technician_ids.length > 0) {
    // Existing rows contain display names but no stable technician ID. Never
    // use a name match to filter a role-limited user's authorization scope.
    return { ok: false, reason: "stable_technician_mapping_required" };
  }
  return { ok: false, reason: "scope_not_configured" };
}

export function isAllowedOrigin(configuredOrigin, requestOrigin) {
  return typeof configuredOrigin === "string" && configuredOrigin.startsWith("https://") &&
    typeof requestOrigin === "string" && requestOrigin === configuredOrigin;
}

export function dateOnly(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = Date.UTC(1899, 11, 30) + Math.round(value * 86400000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  const raw = String(value ?? "").trim();
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${String(us[1]).padStart(2, "0")}-${String(us[2]).padStart(2, "0")}`;
  return "";
}

const cell = (values, row, col = 0) => values?.[row]?.[col] ?? "";

export function mapPayrollRanges(valueRanges) {
  const byName = new Map((valueRanges || []).map(range => [range.range?.split("!").at(-1)?.replace(/\$|'/g, ""), range.values || []]));
  const ranges = ["B3:B", "F3:H", "J3:K", "P3:P", "U3:W", "X3:Z", "AF3:AH", "AI3:AI", "AO3:AO"];
  const values = Object.fromEntries(ranges.map(range => [range, byName.get(range) || []]));
  const length = Math.max(0, ...Object.values(values).map(rows => rows.length));
  const mapped = [];
  for (let i = 0; i < length; i++) {
    const row = {
      date: dateOnly(cell(values["B3:B"], i)),
      period: cell(values["F3:H"], i, 0),
      category: cell(values["F3:H"], i, 1),
      client: cell(values["F3:H"], i, 2),
      activity: cell(values["J3:K"], i, 0),
      caseName: cell(values["J3:K"], i, 1),
      status: cell(values["P3:P"], i),
      tp: cell(values["U3:W"], i, 0),
      ta1: cell(values["U3:W"], i, 1),
      ta2: cell(values["U3:W"], i, 2),
      amountTP: cell(values["X3:Z"], i, 0),
      amountTA1: cell(values["X3:Z"], i, 1),
      amountTA2: cell(values["X3:Z"], i, 2),
      paidTP: cell(values["AF3:AH"], i, 0),
      paidTA1: cell(values["AF3:AH"], i, 1),
      paidTA2: cell(values["AF3:AH"], i, 2),
      report: cell(values["AI3:AI"], i),
      project: cell(values["AO3:AO"], i)
    };
    if (row.date || row.tp || row.ta1 || row.ta2 || row.amountTP !== "" || row.amountTA1 !== "" || row.amountTA2 !== "") mapped.push(row);
  }
  return mapped;
}

const dashboardCell = (values, row, col = 0) => values?.[row]?.[col] ?? "";

export function mapDashboardRanges(valueRanges, tabCells = []) {
  const byName = new Map((valueRanges || []).map(range => [range.range?.split("!").at(-1)?.replace(/\$|'/g, ""), range.values || []]));
  const ranges = ["B3:B", "F3:H", "I3:I", "J3:K", "L3:O", "P3:P", "Q3:S", "U3:W", "X3:AA", "AE3:AE", "AI3:AN", "AU3:AU"];
  const values = Object.fromEntries(ranges.map(range => [range, byName.get(range) || []]));
  const length = Math.max(0, ...Object.values(values).map(rows => rows.length));
  const rows = [];
  for (let i = 0; i < length; i++) {
    const row = {
      date: dateOnly(dashboardCell(values["B3:B"], i)),
      period: dashboardCell(values["F3:H"], i, 0),
      category: dashboardCell(values["F3:H"], i, 1),
      client: dashboardCell(values["F3:H"], i, 2),
      address: dashboardCell(values["I3:I"], i),
      activity: dashboardCell(values["J3:K"], i, 0),
      caseName: dashboardCell(values["J3:K"], i, 1),
      insurer: dashboardCell(values["L3:O"], i, 0),
      limit: dashboardCell(values["L3:O"], i, 1),
      report: dashboardCell(values["L3:O"], i, 2),
      prv: dashboardCell(values["L3:O"], i, 3),
      status: dashboardCell(values["P3:P"], i),
      observation: dashboardCell(values["Q3:S"], i, 0),
      returnStatus: dashboardCell(values["Q3:S"], i, 1),
      returnDate: dateOnly(dashboardCell(values["Q3:S"], i, 2)),
      tp: dashboardCell(values["U3:W"], i, 0),
      ta1: dashboardCell(values["U3:W"], i, 1),
      ta2: dashboardCell(values["U3:W"], i, 2),
      amountTP: dashboardCell(values["X3:AA"], i, 0),
      amountTA1: dashboardCell(values["X3:AA"], i, 1),
      amountTA2: dashboardCell(values["X3:AA"], i, 2),
      amountPRV: dashboardCell(values["X3:AA"], i, 3),
      subtotal: dashboardCell(values["AE3:AE"], i),
      reportStatus: dashboardCell(values["AI3:AN"], i, 0),
      deliveredDate: dateOnly(dashboardCell(values["AI3:AN"], i, 1)),
      hours360: dashboardCell(values["AI3:AN"], i, 2),
      inspectionHours: dashboardCell(values["AI3:AN"], i, 3),
      workHours: dashboardCell(values["AI3:AN"], i, 4),
      temperatures: dashboardCell(values["AI3:AN"], i, 5),
      quality: dashboardCell(values["AU3:AU"], i)
    };
    if (row.date || row.activity || row.tp || row.ta1 || row.ta2) rows.push(row);
  }
  const cells = Array.isArray(tabCells) ? tabCells.filter(cell =>
    Array.isArray(cell) && cell.length === 3 &&
    Number.isInteger(cell[0]) && cell[0] >= 0 && cell[0] < 500 &&
    Number.isInteger(cell[1]) && cell[1] >= 0 && cell[1] < 26 &&
    typeof cell[2] === "string" && cell[2].length <= 500
  ) : [];
  return { rows, tabCells: cells };
}

const LEGACY_DASHBOARD_FIELDS = Object.freeze([
  "date", "period", "category", "client", "address", "activity", "caseName", "insurer", "limit", "report",
  "prv", "status", "observation", "returnStatus", "returnDate", "tp", "ta1", "ta2", "amountTP", "amountTA1",
  "amountTA2", "amountPRV", "subtotal", "reportStatus", "deliveredDate", "hours360", "inspectionHours", "workHours",
  "temperatures", "quality"
]);

export function dashboardToLegacyPayload(payload) {
  if (!payload || payload.schema !== 1 || !Array.isArray(payload.rows) || !Array.isArray(payload.tabCells)) {
    throw new TypeError("dashboard_payload_invalid");
  }
  if (payload.rows.length > 20000 || payload.tabCells.length > 13000) throw new RangeError("dashboard_payload_too_large");
  const rows = payload.rows.map(source => {
    if (!source || typeof source !== "object") throw new TypeError("dashboard_row_invalid");
    return LEGACY_DASHBOARD_FIELDS.map(field => source[field] ?? "");
  });
  return { schema: 1, readAt: payload.readAt || null, rows, tab: payload.tabCells };
}
