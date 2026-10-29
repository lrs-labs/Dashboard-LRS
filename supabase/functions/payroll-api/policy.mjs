export function authorizePayrollRead(access) {
  if (!access || access.is_active !== true || access.can_view_payroll !== true) {
    return { ok: false, reason: "not_authorized" };
  }
  if (access.scope_mode === "all") return { ok: true, scope: "all" };
  if (access.scope_mode === "selected" && Array.isArray(access.technician_ids) && access.technician_ids.length > 0) {
    // Source rows do not yet contain stable technician IDs. A name match is
    // not an authorization boundary, so selected scopes stay fail-closed.
    return { ok: false, reason: "stable_technician_mapping_required" };
  }
  return { ok: false, reason: "scope_not_configured" };
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
