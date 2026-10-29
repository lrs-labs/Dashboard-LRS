import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  classifyWorkflowAttempt,
  makeWorkflowIdempotencyKey,
  mayTransitionWorkflowState,
  normalizeJobIdentity
} from "../supabase/functions/payroll-api/workflow-idempotency.mjs";

const digest = "a".repeat(64);

test("normalizes identities for frozen invoice, email, and calendar jobs", () => {
  assert.deepEqual(normalizeJobIdentity({
    jobType: "invoice_drive", periodKey: "2026-10-Q1", technicianId: "tech-1", version: "v2"
  }), {
    jobType: "invoice_drive", periodKey: "2026-10-Q1", technicianId: "tech-1", version: "v2"
  });
  assert.deepEqual(normalizeJobIdentity({
    jobType: "invoice_email", periodKey: "2026-10-Q2", technicianId: "tech-2", version: "v1", deliveryAttemptId: "attempt-1"
  }), {
    jobType: "invoice_email", periodKey: "2026-10-Q2", technicianId: "tech-2", version: "v1", deliveryAttemptId: "attempt-1"
  });
  assert.deepEqual(normalizeJobIdentity({
    jobType: "calendar_mark", periodKey: "2026-10-Q1", assignmentId: "assignment-7"
  }), { jobType: "calendar_mark", periodKey: "2026-10-Q1", assignmentId: "assignment-7" });
  assert.deepEqual(normalizeJobIdentity({
    jobType: "period_close", periodKey: "2026-10-Q1", snapshotId: "snapshot-1"
  }), { jobType: "period_close", periodKey: "2026-10-Q1", snapshotId: "snapshot-1" });
});

test("rejects incomplete and malformed job identities", () => {
  assert.equal(normalizeJobIdentity({ jobType: "invoice_drive", periodKey: "2026-13-Q1", technicianId: "t", version: "v" }), null);
  assert.equal(normalizeJobIdentity({ jobType: "invoice_drive", periodKey: "2026-10-Q1", technicianId: "", version: "v" }), null);
  assert.equal(normalizeJobIdentity({ jobType: "invoice_email", periodKey: "2026-10-Q1", technicianId: "t", version: "v" }), null);
  assert.equal(normalizeJobIdentity({ jobType: "calendar_mark", periodKey: "2026-10-Q1" }), null);
  assert.equal(normalizeJobIdentity({ jobType: "unknown", periodKey: "2026-10-Q1" }), null);
});

test("creates deterministic opaque idempotency keys without embedding identifiers", async () => {
  const input = { jobType: "invoice_drive", periodKey: "2026-10-Q1", technicianId: "synthetic-tech", version: "v1" };
  const first = await makeWorkflowIdempotencyKey(input, webcrypto);
  const second = await makeWorkflowIdempotencyKey({ ...input }, webcrypto);
  assert.equal(first, second);
  assert.match(first, /^lrs:invoice_drive:[A-Za-z0-9_-]+$/);
  assert.equal(first.includes("synthetic-tech"), false);
  assert.equal(await makeWorkflowIdempotencyKey({ jobType: "calendar_mark", periodKey: "bad" }, webcrypto), null);
});

test("classifies a new job, same-payload replay, and successful replay", () => {
  const idempotencyKey = "lrs:fixture:opaque";
  assert.deepEqual(classifyWorkflowAttempt({ idempotencyKey, jobType: "invoice_drive", requestDigest: digest, existing: null }), {
    decision: "enqueue", state: "queued"
  });
  const existing = { idempotency_key: idempotencyKey, job_type: "invoice_drive", request_digest: digest, state: "succeeded", result: { fileId: "fixture-file" } };
  assert.deepEqual(classifyWorkflowAttempt({ idempotencyKey, jobType: "invoice_drive", requestDigest: digest, existing }), {
    decision: "return_existing_result", state: "succeeded"
  });
  assert.equal(classifyWorkflowAttempt({ idempotencyKey, jobType: "invoice_drive", requestDigest: "b".repeat(64), existing }).decision, "conflict");
});

test("running and uncertain jobs are never silently duplicated", () => {
  for (const state of ["queued", "running"]) {
    assert.deepEqual(classifyWorkflowAttempt({
      idempotencyKey: "lrs:key", jobType: "invoice_email", requestDigest: digest,
      existing: { idempotency_key: "lrs:key", job_type: "invoice_email", request_digest: digest, state }
    }), { decision: "wait", state });
  }
  for (const state of ["unknown", "needs_review"]) {
    assert.equal(classifyWorkflowAttempt({
      idempotencyKey: "lrs:key", jobType: "invoice_email", requestDigest: digest,
      existing: { idempotency_key: "lrs:key", job_type: "invoice_email", request_digest: digest, state }
    }).decision, "reconcile");
  }
});

test("failed jobs require explicit retry approval", () => {
  assert.deepEqual(classifyWorkflowAttempt({
    idempotencyKey: "lrs:key", jobType: "calendar_mark", requestDigest: digest,
    existing: { idempotency_key: "lrs:key", job_type: "calendar_mark", request_digest: digest, state: "failed" }
  }), { decision: "manual_retry_review", state: "failed" });
  assert.equal(mayTransitionWorkflowState("failed", "queued"), false);
  assert.equal(mayTransitionWorkflowState("failed", "queued", { retryApproved: true }), true);
});

test("unknown outcomes require reconciliation before finalization or retry", () => {
  assert.equal(mayTransitionWorkflowState("unknown", "succeeded"), false);
  assert.equal(mayTransitionWorkflowState("unknown", "failed"), false);
  assert.equal(mayTransitionWorkflowState("unknown", "queued", { retryApproved: true }), false);
  assert.equal(mayTransitionWorkflowState("unknown", "failed", { reconciled: true }), true);
  assert.equal(mayTransitionWorkflowState("needs_review", "running", { reconciled: true }), true);
  assert.equal(mayTransitionWorkflowState("needs_review", "running"), false);
  assert.equal(mayTransitionWorkflowState("succeeded", "queued", { retryApproved: true, reconciled: true }), false);
});
