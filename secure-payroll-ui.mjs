import { createSecurePayrollClient } from "./secure-payroll-client.mjs";

const runtime = globalThis.LRS_PRIVATE_PAYROLL_RUNTIME || {};
const signInButton = document.getElementById("signIn");
const refreshButton = document.getElementById("refresh");
const signOutButton = document.getElementById("signOut");
const message = document.getElementById("accessMessage");
const readState = document.getElementById("readState");
const readStateText = document.getElementById("readStateText");
const summary = document.getElementById("summary");
const records = document.getElementById("records");
const emptyState = document.getElementById("emptyState");
const rowsBody = document.getElementById("payrollRows");
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function cellText(row, value, className) {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  cell.textContent = value == null ? "" : String(value);
  row.append(cell);
  return cell;
}

function statusBadge(row, line) {
  const cell = document.createElement("td");
  const badge = document.createElement("span");
  const label = line.paidState === "paid" ? "Marcado pagado"
    : line.paidState === "unpaid" ? "Pendiente"
      : line.paidState === "zero" ? "Sin importe" : "Revisar estado";
  badge.className = `badge ${line.paidState === "paid" ? "paid" : line.paidState === "unpaid" ? "unpaid" : line.paidState === "review" ? "review" : ""}`;
  badge.textContent = label;
  cell.append(badge);
  row.append(cell);
}

function clearTable() {
  rowsBody.replaceChildren();
  summary.hidden = true;
  records.hidden = true;
  emptyState.hidden = true;
}

function renderAssignments(sourceRows) {
  const core = globalThis.PayrollCore;
  if (!core?.buildAssignments || !Array.isArray(sourceRows)) throw new Error("payroll_projection_unavailable");
  const model = core.buildAssignments(sourceRows);
  const total = model.lines.reduce((sum, line) => sum + (Number.isFinite(line.amount) ? line.amount : 0), 0);
  const reviewCount = model.lines.filter(line => line.paidState === "review").length + model.reviewRows.length + model.unassigned.length;

  document.getElementById("lineCount").textContent = String(model.lines.length);
  document.getElementById("totalAmount").textContent = money.format(total);
  document.getElementById("reviewCount").textContent = String(reviewCount);
  summary.hidden = false;
  rowsBody.replaceChildren();

  for (const line of model.lines) {
    const row = document.createElement("tr");
    cellText(row, line.date);
    cellText(row, line.technician);
    cellText(row, line.role);
    cellText(row, line.project || line.client);
    cellText(row, line.activity);
    cellText(row, line.caseName);
    cellText(row, `${line.jobStatus}${line.reportPending ? " · reporte pendiente" : ""}`);
    statusBadge(row, line);
    cellText(row, money.format(line.amount), "amount");
    rowsBody.append(row);
  }

  records.hidden = model.lines.length === 0;
  emptyState.hidden = model.lines.length !== 0;
  if (reviewCount > 0) {
    message.textContent = `Consulta actualizada. ${reviewCount} asignación(es) requieren revisión; no se asignó saldo concluyente a esas líneas.`;
  }
}

function renderState(state) {
  const labels = {
    unconfigured: "Sin conexión privada",
    signed_out: "Sesión no iniciada",
    authorizing: "Validando identidad",
    loading: "Leyendo la hoja",
    ready: "Actualizado desde la hoja",
    denied: "Acceso no autorizado",
    unavailable: "Servicio no disponible",
    error: "No se pudo actualizar",
    signing_out: "Cerrando sesión"
  };
  readState.dataset.state = state.status;
  readStateText.textContent = labels[state.status] || "Estado desconocido";
  message.textContent = state.message;
  const configured = Boolean(runtime.config?.enabled && runtime.authClient);
  signInButton.hidden = !configured || state.status !== "signed_out";
  refreshButton.hidden = !configured || !["ready", "error", "unavailable", "denied"].includes(state.status);
  signOutButton.hidden = !configured || !["ready", "error", "unavailable", "denied", "loading"].includes(state.status);
  signInButton.disabled = ["authorizing", "loading"].includes(state.status);
  refreshButton.disabled = ["authorizing", "loading", "signing_out"].includes(state.status);

  if (state.status !== "ready" || !Array.isArray(state.rows)) {
    clearTable();
    return;
  }
  try { renderAssignments(state.rows); }
  catch (_) {
    clearTable();
    message.textContent = "No se pudo interpretar la respuesta privada. No se mostraron datos anteriores.";
    readState.dataset.state = "error";
    readStateText.textContent = labels.error;
  }
}

const controller = createSecurePayrollClient({
  config: runtime.config,
  authClient: runtime.authClient,
  fetcher: globalThis.fetch?.bind(globalThis),
  onState: renderState
});

signInButton.addEventListener("click", () => { void controller.signIn(); });
refreshButton.addEventListener("click", () => { void controller.refresh(); });
signOutButton.addEventListener("click", () => { void controller.signOut(); });

void controller.start();
