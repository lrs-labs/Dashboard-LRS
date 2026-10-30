function parsePeriodKey(value) {
  const match = /^([0-9]{4})-([0-9]{2})-Q([12])$/.exec(String(value ?? ""));
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), half: Number(match[3]) };
}

export function getPayrollPeriodOptions(lines, now, core) {
  if (!core?.currentNYPeriod || !core?.periodKey || !core?.periodLabel) throw new TypeError("payroll_core_required");
  const current = core.currentNYPeriod(now);
  const byKey = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    const period = { year: Number(line.year), month: Number(line.month), half: Number(line.half) };
    if (!Number.isInteger(period.year) || !Number.isInteger(period.month) || ![1, 2].includes(period.half)) continue;
    const key = core.periodKey(period.year, period.month, period.half);
    byKey.set(key, { key, ...period, label: core.periodLabel(period.year, period.month, period.half) });
  }
  const currentKey = core.periodKey(current.year, current.month, current.half);
  if (!byKey.has(currentKey)) byKey.set(currentKey, {
    key: currentKey,
    ...current,
    label: core.periodLabel(current.year, current.month, current.half)
  });
  return [...byKey.values()].sort((a, b) =>
    b.year - a.year || b.month - a.month || b.half - a.half
  );
}

export function filterPayrollLines(lines, filters, core) {
  if (!core?.filterAssignments) throw new TypeError("payroll_core_required");
  const selected = filters || {};
  const period = selected.period === "all" ? null : parsePeriodKey(selected.period);
  if (selected.period !== "all" && !period) return [];
  return core.filterAssignments(lines, {
    ...(period || {}),
    from: selected.from || "",
    to: selected.to || "",
    technician: selected.technician || "",
    role: selected.role || "",
    activity: selected.activity || "",
    caseName: selected.caseName || "",
    project: selected.project || "",
    jobStatus: selected.jobStatus || "",
    paymentStatus: selected.paymentStatus || "all"
  });
}

export function buildPayrollInvoice(lines, technician, periodKey, core, { technicianId, generatedAt } = {}) {
  if (!core?.periodLabel || !core?.folio || !core?.summarize) throw new TypeError("payroll_core_required");
  const period = parsePeriodKey(periodKey);
  const name = String(technician ?? "").trim();
  if (!period || !name) return null;
  const invoiceLines = (Array.isArray(lines) ? lines : [])
    .filter(line => line.technician === name && line.periodKey === periodKey)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) ||
      a.project.localeCompare(b.project, "es") ||
      a.activity.localeCompare(b.activity, "es") ||
      a.role.localeCompare(b.role, "es") ||
      a.caseName.localeCompare(b.caseName, "es"));
  if (!invoiceLines.length) return null;

  const technicianIds = new Set(invoiceLines.map(line => line.technicianId).filter(value => typeof value === "string" && value.trim()));
  const stableTechnicianId = typeof technicianId === "string" && technicianId.trim()
    ? technicianId.trim()
    : technicianIds.size === 1 ? [...technicianIds][0] : null;
  if (stableTechnicianId && invoiceLines.some(line => line.technicianId && line.technicianId !== stableTechnicianId)) return null;

  const summary = core.summarize(invoiceLines)[0];
  const amountReviewCount = invoiceLines.filter(line => typeof line.amount !== "number" || !Number.isFinite(line.amount)).length;
  const knownAmount = invoiceLines.reduce((sum, line) => sum + (Number.isFinite(line.amount) ? line.amount : 0), 0);
  const paid = invoiceLines.reduce((sum, line) => sum + (line.paidState === "paid" && Number.isFinite(line.amount) ? line.amount : 0), 0);
  const pending = invoiceLines.reduce((sum, line) => sum + (line.paidState === "unpaid" && Number.isFinite(line.amount) ? line.amount : 0), 0);
  const review = invoiceLines.reduce((sum, line) => sum + (line.paidState === "review" && Number.isFinite(line.amount) ? line.amount : 0), 0);
  const reviewCount = invoiceLines.filter(line => line.paidState === "review").length;
  return {
    technicianId: stableTechnicianId,
    technician: name,
    period,
    periodKey,
    periodLabel: core.periodLabel(period.year, period.month, period.half),
    reference: core.folio(name, period.year, period.month, period.half, invoiceLines),
    lines: invoiceLines,
    total: amountReviewCount ? null : knownAmount,
    knownTotal: knownAmount,
    paid,
    pending,
    review,
    balance: reviewCount > 0 || amountReviewCount > 0 ? null : knownAmount - paid,
    reviewCount,
    amountReviewCount,
    reportPendingCount: invoiceLines.filter(line => line.reportPending).length,
    projectCount: summary?.projects || 0,
    generatedAt: typeof generatedAt === "string" && Number.isFinite(Date.parse(generatedAt))
      ? new Date(generatedAt).toISOString()
      : new Date().toISOString(),
    state: "preview-only"
  };
}
