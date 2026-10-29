import { createSecureDashboardClient } from "./secure-dashboard-client.mjs";
import { loadPrivateAuthRuntime } from "./private-runtime-bootstrap.mjs";
import { calculateHourlyComparison, filterDashboardRows, normalizeDashboardRows, parseSecureTabulator, summarizeDashboardRows } from "./private-dashboard-view.mjs";

const runtime = await loadPrivateAuthRuntime();
const $ = id => document.getElementById(id);
const workspace = $("workspace");
const accessMessage = $("accessMessage");
const stateLabels = { unconfigured: "Sin conexión privada", signed_out: "Sesión no iniciada", authorizing: "Validando identidad", loading: "Leyendo el Sheet", ready: "Actualizado desde el Sheet", denied: "Acceso no autorizado", unavailable: "Servicio no disponible", error: "No se pudo actualizar", signing_out: "Cerrando sesión" };
const monthNames = new Intl.DateTimeFormat("es-US", { month: "long", timeZone: "UTC" });
const number = new Intl.NumberFormat("es-US");
const updatedFormatter = new Intl.DateTimeFormat("es-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });
let allRows = [];
let tabCells = [];
let tabModel = { blocks: [], fire: [], flood: null, notes: [] };

function setText(node, value) { node.textContent = value == null ? "" : String(value); }
function option(value, label) { const item = document.createElement("option"); item.value = value; item.textContent = label; return item; }
function replaceOptions(select, values, allLabel) {
  const old = select.value;
  select.replaceChildren(option("all", allLabel), ...values.map(value => option(value, value)));
  if (values.includes(old)) select.value = old;
}
function setFilters(rows) {
  const years = [...new Set(rows.map(row => row.date.slice(0, 4)))].sort().reverse();
  const months = [...new Set(rows.map(row => row.date.slice(5, 7)))].sort();
  $("yearFilter").replaceChildren(option("all", "Todos"), ...years.map(year => option(year, year)));
  $("monthFilter").replaceChildren(option("all", "Todos"), ...months.map(month => option(month, monthNames.format(new Date(Date.UTC(2020, Number(month) - 1, 1))))));
  replaceOptions($("statusFilter"), [...new Set(rows.map(row => row.status).filter(Boolean))].sort(), "Todos");
  replaceOptions($("activityFilter"), [...new Set(rows.map(row => String(row.activity || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es")), "Todas");
  replaceOptions($("technicianFilter"), [...new Set(rows.flatMap(row => [row.tp, row.ta1, row.ta2]).map(value => String(value || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es")), "Todos");
}
function currentFilters() {
  return { year: $("yearFilter").value, month: $("monthFilter").value, status: $("statusFilter").value, activity: $("activityFilter").value, technician: $("technicianFilter").value, query: $("searchFilter").value };
}
function statusClass(value) { return value === "COMPLETED" ? "completed" : value === "REALIZADO" ? "realized" : value === "PENDING" || value === "IN PROGRESS" ? "pending" : ""; }
function cell(row, value, className = "") { const item = document.createElement("td"); if (className) item.className = className; setText(item, value); row.append(item); return item; }
function renderProjects(rows) {
  const body = $("projectRows");
  body.replaceChildren();
  const display = rows.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 200);
  if (!display.length) {
    const row = document.createElement("tr"); const empty = cell(row, "No hay registros que coincidan con estos filtros."); empty.colSpan = 6; empty.className = "empty"; body.append(row); return;
  }
  for (const item of display) {
    const row = document.createElement("tr");
    cell(row, item.date);
    cell(row, item.client || "Sin dato");
    cell(row, item.caseName || "Sin dato");
    cell(row, item.activity || "Sin dato");
    cell(row, [item.tp, item.ta1, item.ta2].map(value => String(value || "").trim()).filter(Boolean).join(" · ") || "Sin asignación");
    const statusCell = cell(row, item.status || "Sin estado");
    const badge = document.createElement("span"); badge.className = `badge ${statusClass(item.status)}`; badge.textContent = item.status || "Sin estado";
    statusCell.replaceChildren(badge);
    body.append(row);
  }
}
function renderActivity(rows) {
  const target = $("activityChart"), counts = summarizeDashboardRows(rows).activities;
  target.replaceChildren();
  if (!counts.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "Sin actividad para esta vista."; target.append(empty); return; }
  const max = Math.max(1, ...counts.map(item => item.count));
  for (const item of counts.slice(0, 12)) {
    const line = document.createElement("div"); line.className = "activity-item";
    const label = document.createElement("span"); label.className = "activity-name"; label.textContent = item.name;
    const track = document.createElement("span"); track.className = "bar-track"; track.setAttribute("aria-hidden", "true");
    const fill = document.createElement("span"); fill.className = "bar-fill"; fill.style.width = `${(item.count / max) * 100}%`; track.append(fill);
    const count = document.createElement("span"); count.className = "activity-count"; count.textContent = number.format(item.count);
    line.append(label, track, count); target.append(line);
  }
}
function renderDashboard() {
  const rows = filterDashboardRows(allRows.map(item => [item.date, item.period, item.category, item.client, item.address, item.activity, item.caseName, item.insurer, item.limit, item.report, item.prv, item.status, item.observation, item.returnStatus, item.returnDate, item.tp, item.ta1, item.ta2, item.amountTP, item.amountTA1, item.amountTA2, item.amountPRV, item.subtotal, item.reportStatus, item.deliveredDate, item.hours360, item.inspectionHours, item.workHours, item.temperatures, item.quality]), currentFilters());
  const summary = summarizeDashboardRows(rows);
  setText($("totalMetric"), number.format(summary.total));
  setText($("completedMetric"), number.format(summary.completed));
  setText($("realizedMetric"), number.format(summary.realized));
  setText($("pendingMetric"), number.format(summary.pending + summary.inProgress));
  setText($("rowCount"), `${number.format(rows.length)} registros · hasta 200 filas visibles`);
  renderProjects(rows);
  renderActivity(rows);
}
function appendBlock(title, rows) {
  const article = document.createElement("article"); article.className = "price-block";
  const heading = document.createElement("h3"); heading.textContent = title; article.append(heading);
  if (!rows.length) { const empty = document.createElement("p"); empty.className = "small-note"; empty.textContent = "Sin tarifas en este bloque del Sheet."; article.append(empty); return article; }
  const wrapper = document.createElement("div"); wrapper.className = "table-wrap";
  const table = document.createElement("table");
  const head = document.createElement("thead"), headRow = document.createElement("tr");
  for (const name of ["Caso", "TP", "TA", "Total"]) { const th = document.createElement("th"); th.scope = "col"; th.textContent = name; headRow.append(th); }
  head.append(headRow); table.append(head);
  const body = document.createElement("tbody");
  for (const price of rows) {
    const row = document.createElement("tr");
    cell(row, price.name);
    cell(row, price.tp == null ? "—" : `$${price.tp.toFixed(2)}`, "numeric");
    cell(row, price.ta == null ? "—" : `$${price.ta.toFixed(2)}`, "numeric");
    const totalLabel = price.percentage != null ? `${price.percentage}% del proyecto`
      : price.note ? price.note : price.total == null ? "—" : `$${price.total.toFixed(2)}`;
    cell(row, totalLabel, "numeric"); body.append(row);
  }
  table.append(body); wrapper.append(table); article.append(wrapper); return article;
}
function renderTabulator() {
  const target = $("priceBlocks"); target.replaceChildren();
  if (!tabModel.blocks.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "El tabulador privado no se pudo interpretar. Comprueba la pestaña TABULADOR del Sheet."; target.append(empty); }
  for (const block of tabModel.blocks) target.append(appendBlock(block.name, block.rows));
  if (tabModel.fire.length) target.append(appendBlock("FIRE · zonas extras", tabModel.fire.map(item => ({ name: item.name, tp: item.tp, ta: item.ta, total: item.tp != null && item.ta != null ? item.tp + item.ta : null }))));
  if (tabModel.flood) target.append(appendBlock("FLOOD · tarifas por hora", [{ name: "Trabajo por hora", tp: tabModel.flood.tp, ta: tabModel.flood.ta, total: tabModel.flood.tp + tabModel.flood.ta }]));
  for (const note of tabModel.notes) { const paragraph = document.createElement("p"); paragraph.className = "small-note"; paragraph.textContent = note; target.append(paragraph); }
  $("tpRate").value = tabModel.flood?.tp ?? ""; $("taRate").value = tabModel.flood?.ta ?? "";
  $("tpRate").disabled = !tabModel.flood; $("taRate").disabled = !tabModel.flood;
  renderCalculator();
}
function renderCalculator() {
  const result = calculateHourlyComparison($("hoursInput").value, $("tpRate").value, $("taRate").value);
  const target = $("calculatorResult"); target.replaceChildren();
  if (!result) { const note = document.createElement("span"); note.className = "small-note"; note.textContent = "Tarifas verificadas no disponibles; no se calculó un importe."; target.append(note); return; }
  for (const [label, value] of [["TP", result.tp], ["TA", result.ta], ["Total", result.combined]]) {
    const item = document.createElement("span"); item.className = "calc-value"; item.textContent = `${label}  $${value.toFixed(2)}`; target.append(item);
  }
}
function setView(name) {
  for (const button of document.querySelectorAll("[data-view]")) button.setAttribute("aria-selected", String(button.dataset.view === name));
  $("dashboardView").hidden = name !== "dashboard"; $("tabulatorView").hidden = name !== "tabulator";
}
function clearViews() {
  workspace.hidden = true; allRows = []; tabCells = []; tabModel = { blocks: [], fire: [], flood: null, notes: [] };
  $("projectRows").replaceChildren(); $("activityChart").replaceChildren(); $("priceBlocks").replaceChildren();
  $("yearFilter").replaceChildren(option("all", "Todos"));
  $("monthFilter").replaceChildren(option("all", "Todos"));
  $("statusFilter").replaceChildren(option("all", "Todos"));
  $("activityFilter").replaceChildren(option("all", "Todas"));
  $("technicianFilter").replaceChildren(option("all", "Todos"));
  $("searchFilter").value = ""; $("updatedAt").textContent = "—";
  $("tpRate").value = ""; $("taRate").value = ""; $("tpRate").disabled = true; $("taRate").disabled = true;
  $("calculatorResult").replaceChildren();
  $("totalMetric").textContent = "0"; $("completedMetric").textContent = "0"; $("realizedMetric").textContent = "0"; $("pendingMetric").textContent = "0";
}
function renderState(state) {
  $("readState").dataset.state = state.status;
  setText($("readStateText"), stateLabels[state.status] || "Estado desconocido");
  setText(accessMessage, state.message);
  const configured = runtime.config?.enabled === true && Boolean(runtime.authClient);
  $("signIn").hidden = !configured || state.status !== "signed_out";
  $("refresh").hidden = !configured || !["ready", "error", "unavailable", "denied"].includes(state.status);
  $("signOut").hidden = !configured || !["ready", "error", "unavailable", "denied", "loading"].includes(state.status);
  $("signIn").disabled = ["authorizing", "loading"].includes(state.status);
  $("refresh").disabled = ["authorizing", "loading", "signing_out"].includes(state.status);
  if (state.status !== "ready" || !state.dataset) { clearViews(); return; }
  try {
    allRows = normalizeDashboardRows(state.dataset.rows);
    tabCells = state.dataset.tab;
    tabModel = parseSecureTabulator(tabCells);
    setFilters(allRows);
    setText($("updatedAt"), state.readAt ? `Actualizado ${updatedFormatter.format(new Date(state.readAt))}` : "Lectura fresca");
    workspace.hidden = false;
    setView("dashboard"); renderDashboard(); renderTabulator();
  } catch (_) {
    clearViews();
    setText(accessMessage, "La respuesta privada no tiene el formato esperado. No se mostraron datos anteriores.");
    $("readState").dataset.state = "error"; setText($("readStateText"), stateLabels.error);
  }
}

const controller = createSecureDashboardClient({ config: runtime.config, authClient: runtime.authClient, sessionStorage: runtime.sessionStorage, fetcher: globalThis.fetch?.bind(globalThis), onState: renderState });
for (const id of ["yearFilter", "monthFilter", "statusFilter", "activityFilter", "technicianFilter"]) $(id).addEventListener("change", renderDashboard);
$("searchFilter").addEventListener("input", renderDashboard);
$("hoursInput").addEventListener("input", renderCalculator);
for (const button of document.querySelectorAll("[data-view]")) button.addEventListener("click", () => setView(button.dataset.view));
$("signIn").addEventListener("click", () => { void controller.signIn(); });
$("refresh").addEventListener("click", () => { void controller.refresh(); });
$("signOut").addEventListener("click", () => { void controller.signOut(); });
void controller.start();
