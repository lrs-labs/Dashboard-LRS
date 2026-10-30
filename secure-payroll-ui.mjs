import { createSecurePayrollClient } from "./secure-payroll-client.mjs";
import { loadPrivateAuthRuntime } from "./private-runtime-bootstrap.mjs";
import { buildPayrollInvoice, filterPayrollLines, getPayrollPeriodOptions, getPayrollReviewMetrics } from "./payroll-private-view.mjs";
import { generatePayrollInvoicePdf } from "./payroll-invoice-pdf.mjs";

const runtime = await loadPrivateAuthRuntime();
const $ = id => document.getElementById(id);
const signInButton = $("signIn");
const emailSignInForm = $("emailSignInForm");
const signInEmailInput = $("signInEmail");
const refreshButton = $("refresh");
const signOutButton = $("signOut");
const printButton = $("printInvoice");
const downloadPdfButton = $("downloadInvoicePdf");
const message = $("accessMessage");
const readState = $("readState");
const readStateText = $("readStateText");
const summary = $("summary");
const records = $("records");
const emptyState = $("emptyState");
const rowsBody = $("payrollRows");
const filtersPanel = $("filtersPanel");
const invoicePanel = $("invoice");
const invoiceHistory = $("invoiceHistory");
const invoiceRows = $("invoiceRows");
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const dateFormat = new Intl.DateTimeFormat("es-US", { dateStyle: "medium", timeZone: "America/New_York" });
let sourceLines = [];
let sourceReviewModel = { reviewRows: [], unassigned: [] };
let sourceLoaded = false;
let initializedFilters = false;
let lastReadAt = null;
let currentInvoice = null;

function setText(element, value) { element.textContent = value == null ? "" : String(value); }

function cellText(row, value, className) {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  setText(cell, value);
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

function uniqueSorted(values) {
  return [...new Set(values.map(value => String(value || "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));
}

function setSelectOptions(select, values, allLabel = "Todos") {
  const current = select.value;
  const options = [{ value: "", label: allLabel }, ...values.map(value => ({ value, label: value }))];
  select.replaceChildren(...options.map(item => {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    return option;
  }));
  if (options.some(option => option.value === current)) select.value = current;
}

function populateFilters(lines) {
  const core = globalThis.PayrollCore;
  const period = $("filterPeriod");
  const selectedPeriod = period.value;
  const periods = getPayrollPeriodOptions(lines, new Date(), core);
  const periodOptions = [
    { value: "all", label: "Todas las quincenas" },
    ...periods.map(item => ({ value: item.key, label: item.label }))
  ];
  period.replaceChildren(...periodOptions.map(item => {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    return option;
  }));
  const current = core.currentNYPeriod(new Date());
  const currentKey = core.periodKey(current.year, current.month, current.half);
  const validPeriod = periodOptions.some(option => option.value === selectedPeriod);
  period.value = initializedFilters && validPeriod ? selectedPeriod : currentKey;

  setSelectOptions($("filterTechnician"), uniqueSorted(lines.map(line => line.technician)), "Todos los técnicos");
  setSelectOptions($("filterActivity"), uniqueSorted(lines.map(line => line.activity)));
  setSelectOptions($("filterCase"), uniqueSorted(lines.map(line => line.caseName)));
  setSelectOptions($("filterStatus"), uniqueSorted(lines.map(line => line.jobStatus)));
  initializedFilters = true;
}

function getFilters() {
  return {
    period: $("filterPeriod").value,
    from: $("filterFrom").value,
    to: $("filterTo").value,
    technician: $("filterTechnician").value,
    role: $("filterRole").value,
    activity: $("filterActivity").value,
    caseName: $("filterCase").value,
    project: $("filterProject").value,
    jobStatus: $("filterStatus").value,
    paymentStatus: $("filterPayment").value
  };
}

function filterLines() { return filterPayrollLines(sourceLines, getFilters(), globalThis.PayrollCore); }

function clearTable() {
  rowsBody.replaceChildren();
  summary.hidden = true;
  records.hidden = true;
  filtersPanel.hidden = true;
  emptyState.hidden = true;
  $("sourceReviewNote").hidden = true;
  $("sourceReviewNote").textContent = "";
  $("invoiceLaunch").disabled = true;
  invoicePanel.hidden = true;
  invoiceHistory.hidden = true;
}

function renderSummary(lines) {
  const totals = globalThis.PayrollCore.summarize(lines);
  const amountUnknown = lines.some(line => typeof line.amount !== "number" || !Number.isFinite(line.amount));
  const amount = amountUnknown ? null : lines.reduce((sum, line) => sum + line.amount, 0);
  const paid = totals.reduce((sum, item) => sum + item.paid, 0);
  const pending = totals.reduce((sum, item) => sum + item.pending, 0);
  const reviewMetrics = getPayrollReviewMetrics(lines, sourceReviewModel);

  setText($("lineCount"), lines.length);
  setText($("totalAmount"), amount === null ? "Revisión requerida" : money.format(amount));
  setText($("paidAmount"), money.format(paid));
  setText($("pendingAmount"), money.format(pending));
  setText($("reviewCount"), reviewMetrics.paymentFlagReviewCount);
  setText($("amountReviewCount"), reviewMetrics.amountReviewCount);
  $("reviewMetric").classList.toggle("has-warning", reviewMetrics.paymentFlagReviewCount > 0);
  $("amountReviewMetric").classList.toggle("has-warning", reviewMetrics.amountReviewCount > 0);

  const globalCount = reviewMetrics.sourceUnclassifiedRowCount + reviewMetrics.sourceFeeReviewRowCount + reviewMetrics.sourceUnassignedSlotCount;
  const sourceNote = $("sourceReviewNote");
  sourceNote.hidden = globalCount === 0;
  if (globalCount > 0) {
    sourceNote.textContent = `Avisos globales de clasificación, separados del período y los totales visibles: ${reviewMetrics.sourceUnclassifiedRowCount} fila(s) sin fecha o quincena clasificable; ${reviewMetrics.sourceFeeReviewRowCount} fila(s) de cancelación con importe por revisar; ${reviewMetrics.sourceUnassignedSlotCount} casilla(s) de rol con importe y sin técnico asignado. No se cuentan como asignaciones ni como saldo pendiente de esta vista.`;
  }
  summary.hidden = false;
  return reviewMetrics;
}

function renderAssignments(lines) {
  rowsBody.replaceChildren();
  for (const line of lines) {
    const row = document.createElement("tr");
    cellText(row, line.date);
    cellText(row, line.technician);
    cellText(row, line.role);
    cellText(row, line.project || line.client);
    cellText(row, line.activity);
    cellText(row, line.caseName);
    cellText(row, `${line.jobStatus}${line.reportPending ? " · reporte pendiente" : ""}`);
    statusBadge(row, line);
    cellText(row, Number.isFinite(line.amount) ? money.format(line.amount) : "Revisar importe", "amount");
    rowsBody.append(row);
  }
  records.hidden = lines.length === 0;
  emptyState.hidden = lines.length !== 0;
  const reviewMetrics = renderSummary(lines);
  const readLabel = lastReadAt ? `Lectura de la hoja: ${dateFormat.format(new Date(lastReadAt))}.` : "Lectura fresca de la hoja.";
  if (reviewMetrics.paymentFlagReviewCount > 0 || reviewMetrics.amountReviewCount > 0) {
    message.textContent = `${readLabel} En esta vista: ${reviewMetrics.paymentFlagReviewCount} estado(s) de pago y ${reviewMetrics.amountReviewCount} importe(s) por revisar. Las casillas no confirman una transferencia bancaria.`;
  } else {
    message.textContent = `${readLabel} Los estados son administrativos y no confirman una transferencia bancaria.`;
  }
  updateInvoiceAction();
}

function applyFilters() {
  if (!sourceLoaded) return;
  const filtered = filterLines();
  renderAssignments(filtered);
  const paymentReviewCount = Number($("reviewCount").textContent);
  const amountReviewCount = Number($("amountReviewCount").textContent);
  setText($("resultCount"), `${filtered.length} asignaciones`);
  const resultsNote = $("resultsNote");
  resultsNote.hidden = paymentReviewCount === 0 && amountReviewCount === 0;
  if (!resultsNote.hidden) resultsNote.textContent = `${paymentReviewCount} estado(s) de pago y ${amountReviewCount} importe(s) por revisar en las asignaciones de esta vista.`;
}

function updateInvoiceAction() {
  const technician = $("filterTechnician").value;
  const period = $("filterPeriod").value;
  const available = sourceLines.some(line => line.technician === technician && line.periodKey === period);
  $("invoiceLaunch").disabled = !technician || period === "all" || !available;
  if (!technician) $("invoiceHelp").textContent = "Selecciona un técnico y una quincena para preparar su invoice.";
  else if (period === "all") $("invoiceHelp").textContent = "Selecciona una sola quincena para emitir un invoice individual.";
  else if (!available) $("invoiceHelp").textContent = "No hay asignaciones elegibles para ese técnico y período.";
  else $("invoiceHelp").textContent = "El PDF se prepara con las asignaciones completas del técnico en ese período, sin limitarlo por los otros filtros.";
}

function invoiceValue(id, value) { setText($(id), value); }

function showInvoice() {
  const technician = $("filterTechnician").value;
  const period = $("filterPeriod").value;
  const invoice = buildPayrollInvoice(sourceLines, technician, period, globalThis.PayrollCore);
  if (!invoice) {
    message.textContent = "No hay líneas elegibles para preparar ese invoice.";
    return;
  }
  currentInvoice = invoice;
  invoiceValue("invoiceTechnician", invoice.technician);
  invoiceValue("invoicePeriod", invoice.periodLabel);
  invoiceValue("invoiceReference", invoice.reference);
  invoiceValue("invoiceGeneratedAt", new Date(invoice.generatedAt).toLocaleString("es-US", { timeZone: "America/New_York" }));
  invoiceValue("invoiceLineCount", invoice.lines.length);
  invoiceValue("invoiceTotal", invoice.total === null ? "Revisión requerida" : money.format(invoice.total));
  invoiceValue("invoicePaid", money.format(invoice.paid));
  invoiceValue("invoicePending", money.format(invoice.pending));
  invoiceValue("invoiceBalance", invoice.balance === null ? "Revisión requerida" : money.format(invoice.balance));
  $("invoiceReviewNote").hidden = invoice.reviewCount === 0 && invoice.amountReviewCount === 0;
  $("invoiceReportNote").hidden = invoice.reportPendingCount === 0;
  invoiceRows.replaceChildren();
  for (const line of invoice.lines) {
    const row = document.createElement("tr");
    cellText(row, line.date);
    cellText(row, line.project || line.client);
    cellText(row, line.activity);
    cellText(row, line.caseName);
    cellText(row, line.role);
    cellText(row, line.jobStatus + (line.reportPending ? " · reporte pendiente" : ""));
    cellText(row, line.paidState === "paid" ? "Marcado pagado" : line.paidState === "unpaid" ? "Pendiente" : line.paidState === "zero" ? "Sin importe" : "Revisar estado");
    cellText(row, Number.isFinite(line.amount) ? money.format(line.amount) : "Revisar importe", "amount");
    invoiceRows.append(row);
  }
  invoicePanel.hidden = false;
  invoiceHistory.hidden = false;
  invoicePanel.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

function downloadInvoicePdf() {
  if (!currentInvoice) return;
  try {
    const { bytes, fileName } = generatePayrollInvoicePdf(currentInvoice);
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    message.textContent = "Se descargó un borrador PDF. No se archivó en Drive ni se envió al técnico.";
  } catch (_) {
    message.textContent = "No se pudo generar el PDF de vista previa. No se archivó ni se envió.";
  }
}

function renderState(state) {
  const labels = {
    unconfigured: "Sin conexión privada",
    signed_out: "Sesión no iniciada",
    authorizing: "Validando identidad",
    email_sent: "Enlace solicitado",
    email_error: "No se pudo solicitar el enlace",
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
  emailSignInForm.hidden = !configured || !["signed_out", "email_sent", "email_error"].includes(state.status);
  refreshButton.hidden = !configured || !["ready", "error", "unavailable", "denied"].includes(state.status);
  signOutButton.hidden = !configured || !["ready", "error", "unavailable", "denied", "loading"].includes(state.status);
  signInButton.disabled = ["authorizing", "loading"].includes(state.status);
  refreshButton.disabled = ["authorizing", "loading", "signing_out"].includes(state.status);

  if (state.status !== "ready" || !Array.isArray(state.rows)) {
    sourceLines = [];
    sourceReviewModel = { reviewRows: [], unassigned: [] };
    sourceLoaded = false;
    clearTable();
    return;
  }
  try {
    const model = globalThis.PayrollCore.buildAssignments(state.rows);
    sourceLines = model.lines;
    sourceReviewModel = model;
    sourceLoaded = true;
    lastReadAt = state.readAt || null;
    populateFilters(sourceLines);
    filtersPanel.hidden = false;
    applyFilters();
  } catch (_) {
    sourceLines = [];
    sourceReviewModel = { reviewRows: [], unassigned: [] };
    sourceLoaded = false;
    clearTable();
    message.textContent = "No se pudo interpretar la respuesta privada. No se mostraron datos anteriores.";
    readState.dataset.state = "error";
    readStateText.textContent = labels.error;
  }
}

const controller = createSecurePayrollClient({
  config: runtime.config,
  authClient: runtime.authClient,
  sessionStorage: runtime.sessionStorage,
  fetcher: globalThis.fetch?.bind(globalThis),
  onState: renderState
});

for (const id of ["filterPeriod", "filterFrom", "filterTo", "filterTechnician", "filterRole", "filterActivity", "filterCase", "filterProject", "filterStatus", "filterPayment"]) {
  $(id).addEventListener(id === "filterFrom" || id === "filterTo" || id === "filterProject" ? "input" : "change", applyFilters);
}
$("resetFilters").addEventListener("click", () => {
  $("filterFrom").value = "";
  $("filterTo").value = "";
  $("filterTechnician").value = "";
  $("filterRole").value = "";
  $("filterActivity").value = "";
  $("filterCase").value = "";
  $("filterProject").value = "";
  $("filterStatus").value = "";
  $("filterPayment").value = "all";
  const current = globalThis.PayrollCore.currentNYPeriod(new Date());
  $("filterPeriod").value = globalThis.PayrollCore.periodKey(current.year, current.month, current.half);
  applyFilters();
});
$("invoiceLaunch").addEventListener("click", showInvoice);
printButton.addEventListener("click", () => globalThis.print?.());
downloadPdfButton.addEventListener("click", downloadInvoicePdf);
$("closeInvoice").addEventListener("click", () => { invoicePanel.hidden = true; invoiceHistory.hidden = true; currentInvoice = null; });
$("driveOnly").addEventListener("click", () => { message.textContent = "La integración segura con Drive todavía no está configurada; no se creó ni se reemplazó ningún archivo."; });
$("driveAndResend").addEventListener("click", () => { message.textContent = "La integración de Drive y correo todavía no está configurada; no se envió ningún mensaje."; });
$("retryEmailOnly").addEventListener("click", () => { message.textContent = "El servicio seguro de correo todavía no está configurado; no se inició ningún reenvío."; });
emailSignInForm.addEventListener("submit", event => {
  event.preventDefault();
  const email = signInEmailInput.value;
  signInEmailInput.value = "";
  void controller.requestEmailLink(email);
});
refreshButton.addEventListener("click", () => { void controller.refresh(); });
signOutButton.addEventListener("click", () => { void controller.signOut(); });

void controller.start();
