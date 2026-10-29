import { executeScheduledAdministrativeMarks, scheduledAdministrativeMarkDate } from "./workflow-adapters.mjs";
import { verifyClosedPayrollSnapshot } from "./payroll-snapshot-store.mjs";

function localParts(value) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(value);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}
function localDate(value) { const parts = localParts(value); return `${parts.year}-${parts.month}-${parts.day}`; }
function localTime(value) { const parts = localParts(value); return `${parts.hour}:${parts.minute}`; }

/** Invoked by a separately configured scheduler; disabled unless explicitly enabled server-side. */
export function createPayrollCalendarPaymentWorker({ enabled = false, snapshotStore, sourceReader, writer, jobs, audit,
  executionLocalTime = "23:59" } = {}) {
  return Object.freeze({
    async run(now = new Date()) {
      if (enabled !== true) return { state: "disabled", periods: [] };
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(executionLocalTime)) return { state: "needs_review", reason: "worker_time_not_configured", periods: [] };
      if (localTime(now) < executionLocalTime) return { state: "not_due_time", periods: [] };
      if (typeof snapshotStore?.listClosedSnapshots !== "function" || typeof sourceReader?.getPeriodRevision !== "function" ||
          typeof writer?.preflightClosedSnapshot !== "function" || typeof writer?.setPaidFlagByStableAssignmentId !== "function") {
        return { state: "not_configured", periods: [] };
      }
      let snapshots;
      try { snapshots = await snapshotStore.listClosedSnapshots(); }
      catch (_) { return { state: "unavailable", reason: "closed_snapshot_list_unavailable", periods: [] }; }
      if (!Array.isArray(snapshots)) return { state: "unavailable", reason: "closed_snapshot_list_invalid", periods: [] };
      const today = localDate(now);
      const periods = [];
      for (const raw of snapshots) {
        let snapshot;
        try { snapshot = await verifyClosedPayrollSnapshot(raw); }
        catch (_) { periods.push({ periodKey: raw?.periodKey || null, state: "needs_review", reason: "closed_snapshot_integrity_failed" }); continue; }
        const dueDate = scheduledAdministrativeMarkDate(snapshot.periodKey);
        if (dueDate > today) continue;
        if (dueDate < today) {
          periods.push({ periodKey: snapshot.periodKey, state: "missed_run_review", dueDate });
          continue;
        }
        let sourceRevision;
        try { sourceRevision = await sourceReader.getPeriodRevision({ periodKey: snapshot.periodKey }); }
        catch (_) { periods.push({ periodKey: snapshot.periodKey, state: "needs_review", reason: "sheet_revision_unavailable", dueDate }); continue; }
        if (sourceRevision !== snapshot.sourceRevision) {
          periods.push({ periodKey: snapshot.periodKey, state: "needs_review", reason: "source_changed_since_close", dueDate });
          continue;
        }
        const result = await executeScheduledAdministrativeMarks({ snapshot, now, writer, jobs, audit });
        periods.push({ periodKey: snapshot.periodKey, ...result });
      }
      const needsReview = periods.some(item => ["needs_review", "missed_run_review", "unknown", "reconcile_required"].includes(item.state));
      return { state: needsReview ? "completed_with_review" : "succeeded", date: today, timeZone: "America/New_York", periods };
    }
  });
}
