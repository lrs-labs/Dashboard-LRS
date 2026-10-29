const LEGACY_FIELDS = Object.freeze([
  "date", "period", "category", "client", "address", "activity", "caseName", "insurer", "limit", "report",
  "prv", "status", "observation", "returnStatus", "returnDate", "tp", "ta1", "ta2", "amountTP", "amountTA1",
  "amountTA2", "amountPRV", "subtotal", "reportStatus", "deliveredDate", "hours360", "inspectionHours", "workHours",
  "temperatures", "quality"
]);

function text(value) { return String(value ?? "").trim(); }
function status(value) {
  const normalized = text(value).toUpperCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (["COMPLETADO", "COMPLETE"].includes(normalized)) return "COMPLETED";
  if (["CANCELLED", "CANCELADO", "CANCELADA"].includes(normalized)) return "CANCELED";
  if (["PENDIENTE"].includes(normalized)) return "PENDING";
  if (["EN PROGRESO", "IN PROCESS", "INPROGRESS"].includes(normalized)) return "IN PROGRESS";
  return normalized;
}

export function normalizeDashboardRows(input) {
  if (!Array.isArray(input) || input.length > 20000) throw new TypeError("dashboard_rows_invalid");
  return input.map(row => {
    if (!Array.isArray(row) || row.length !== LEGACY_FIELDS.length) throw new TypeError("dashboard_row_invalid");
    return Object.fromEntries(LEGACY_FIELDS.map((field, index) => [field, row[index] ?? ""]));
  }).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(text(row.date)))
    .map(row => ({ ...row, date: text(row.date), period: text(row.period), status: status(row.status) }));
}

export function filterDashboardRows(input, filters = {}) {
  const rows = normalizeDashboardRows(input);
  const query = text(filters.query).toLocaleLowerCase("es");
  return rows.filter(row => {
    const year = row.date.slice(0, 4), month = row.date.slice(5, 7);
    const assigned = [row.tp, row.ta1, row.ta2].map(text).filter(Boolean);
    const queryMatch = !query || [row.client, row.address, row.activity, row.caseName, row.insurer].some(value => text(value).toLocaleLowerCase("es").includes(query));
    return (!filters.year || filters.year === "all" || year === String(filters.year)) &&
      (!filters.month || filters.month === "all" || month === String(filters.month).padStart(2, "0")) &&
      (!filters.status || filters.status === "all" || row.status === filters.status) &&
      (!filters.activity || row.activity === filters.activity) &&
      (!filters.technician || assigned.includes(filters.technician)) && queryMatch;
  });
}

export function summarizeDashboardRows(input) {
  const rows = normalizeDashboardRows(input);
  const counts = new Map();
  for (const row of rows) {
    if (row.activity) counts.set(row.activity, (counts.get(row.activity) || 0) + 1);
  }
  return {
    total: rows.length,
    completed: rows.filter(row => row.status === "COMPLETED").length,
    realized: rows.filter(row => row.status === "REALIZADO").length,
    inProgress: rows.filter(row => row.status === "IN PROGRESS").length,
    pending: rows.filter(row => row.status === "PENDING").length,
    activities: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "es"))
  };
}

function numeric(value) {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Number(raw.replace(/[^\d,.-]/g, "").replace(/,(?=\d{1,2}$)/, ".").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseSecureTabulator(input) {
  if (!Array.isArray(input) || input.length > 13000) return { blocks: [], fire: [], flood: null, notes: [] };
  const grid = new Map();
  for (const cell of input) {
    if (!Array.isArray(cell) || cell.length !== 3 || !Number.isInteger(cell[0]) || cell[0] < 0 || cell[0] >= 500 ||
        !Number.isInteger(cell[1]) || cell[1] < 0 || cell[1] >= 26 || typeof cell[2] !== "string" || cell[2].length > 500) continue;
    grid.set(`${cell[0]},${cell[1]}`, cell[2].trim());
  }
  const rows = [...grid.keys()].map(key => Number(key.split(",")[0]));
  const cols = [...grid.keys()].map(key => Number(key.split(",")[1]));
  if (!rows.length) return { blocks: [], fire: [], flood: null, notes: [] };
  const maxRow = Math.max(...rows), maxCol = Math.max(...cols);
  const at = (row, col) => grid.get(`${row},${col}`) || "";
  const blocks = [], fire = [], notes = [];
  let flood = null;
  for (let row = 0; row <= maxRow; row++) for (let col = 0; col <= maxCol; col++) {
    const value = at(row, col);
    if (value.length >= 80) notes.push(value.replace(/\s+/g, " "));
    if (/^CASO$/i.test(value)) {
      let name = "";
      for (let offset = 1; offset <= 3 && !name; offset++) name = at(row - offset, col);
      const prices = [];
      for (let next = row + 1; next <= maxRow; next++) {
        const item = at(next, col);
        if (!item || item.length >= 60) break;
        const tpText = at(next, col + 1), taText = at(next, col + 2), totalText = at(next, col + 3);
        if (/%/.test(tpText)) prices.push({ name: item, percentage: numeric(tpText) });
        else if (!tpText && !taText) {
          const total = numeric(totalText);
          prices.push(total == null ? { name: item, note: totalText || "Según proyecto" } : { name: item, total });
        } else prices.push({ name: item, tp: numeric(tpText), ta: numeric(taText), total: numeric(totalText) });
      }
      if (prices.length) blocks.push({ name: name || "BLOQUE", rows: prices });
    }
    if (/ZONAS EXTRAS/i.test(value)) {
      for (let next = row + 2; next <= maxRow; next++) {
        const name = at(next, col);
        if (!name || /^FLOOD$/i.test(name)) break;
        if (!at(next, col + 1)) continue;
        fire.push({ name, tp: numeric(at(next, col + 1)), ta: numeric(at(next, col + 2)) });
      }
    }
    if (/^FLOOD$/i.test(value)) {
      for (let next = row; next <= Math.min(maxRow, row + 2) && !flood; next++) {
        const tp = numeric(at(next, col + 2)), ta = numeric(at(next, col + 3));
        if (tp != null && ta != null) flood = { tp, ta };
      }
    }
  }
  return { blocks, fire, flood, notes };
}

export function calculateHourlyComparison(hours, tpRate, taRate) {
  const [quantity, tp, ta] = [hours, tpRate, taRate].map(Number);
  if (![quantity, tp, ta].every(Number.isFinite) || quantity < 0 || tp < 0 || ta < 0) return null;
  const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
  const tpTotal = round(quantity * tp), taTotal = round(quantity * ta);
  return { hours: quantity, tp: tpTotal, ta: taTotal, combined: round(tpTotal + taTotal) };
}
