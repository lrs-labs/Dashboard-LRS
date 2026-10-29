import test from "node:test";
import assert from "node:assert/strict";
import { createInvoicePreviewTokenService } from "../supabase/functions/payroll-api/invoice-preview-token.mjs";

const SECRET = "synthetic-preview-token-secret-32-bytes-minimum";
const binding = {
  periodKey: "2026-10-Q1", snapshotId: "snapshot-fixture-1", sourceRevision: "sheet-revision-1",
  technicianId: "tech-fixture-1", fileId: "drive-file-fixture-1", revisionId: "revision-fixture-1",
  pdfSha256: "a".repeat(64), recipientDirectoryId: "recipient-fixture-1", directoryVersion: "directory-v1",
  recipientEmail: "tech@example.invalid", actorId: "user-fixture-1"
};

test("preview token signs an expiring approval for the exact archive, recipient, and actor", async () => {
  let now = Date.parse("2026-10-29T04:00:00.000Z");
  const service = createInvoicePreviewTokenService({ secret: SECRET, now: () => now, createId: () => "delivery-fixture-id" });
  const issued = await service.issue(binding);
  const result = await service.verify({ token: issued.token, periodKey: binding.periodKey, snapshotId: binding.snapshotId,
    sourceRevision: binding.sourceRevision, technicianId: binding.technicianId,
    archive: { fileId: binding.fileId, revisionId: binding.revisionId, pdfSha256: binding.pdfSha256 },
    recipient: { directoryId: binding.recipientDirectoryId, directoryVersion: binding.directoryVersion, email: binding.recipientEmail },
    actorId: binding.actorId });
  assert.equal(result.approved, true);
  assert.equal(result.deliveryAttemptId, "delivery-fixture-id");
  assert.deepEqual(result.binding, binding);
  now += 5 * 60_000 + 1;
  assert.equal((await service.verify({ token: issued.token, periodKey: binding.periodKey, snapshotId: binding.snapshotId,
    sourceRevision: binding.sourceRevision, technicianId: binding.technicianId,
    archive: { fileId: binding.fileId, revisionId: binding.revisionId, pdfSha256: binding.pdfSha256 },
    recipient: { directoryId: binding.recipientDirectoryId, directoryVersion: binding.directoryVersion, email: binding.recipientEmail },
    actorId: binding.actorId })).approved, false);
});

test("preview token rejects mutation and changes to PDF, Drive revision, email, or actor", async () => {
  const service = createInvoicePreviewTokenService({ secret: SECRET, now: () => Date.parse("2026-10-29T04:00:00.000Z"), createId: () => "delivery-fixture-id" });
  const issued = await service.issue(binding);
  const args = {
    token: issued.token, periodKey: binding.periodKey, snapshotId: binding.snapshotId, sourceRevision: binding.sourceRevision,
    technicianId: binding.technicianId, archive: { fileId: binding.fileId, revisionId: binding.revisionId, pdfSha256: binding.pdfSha256 },
    recipient: { directoryId: binding.recipientDirectoryId, directoryVersion: binding.directoryVersion, email: binding.recipientEmail }, actorId: binding.actorId
  };
  for (const changed of [
    { ...args, archive: { ...args.archive, revisionId: "different-revision" } },
    { ...args, archive: { ...args.archive, pdfSha256: "b".repeat(64) } },
    { ...args, recipient: { ...args.recipient, email: "changed@example.invalid" } },
    { ...args, actorId: "different-user" },
    { ...args, token: `${issued.token}x` }
  ]) assert.equal((await service.verify(changed)).approved, false);
});

test("preview tokens cannot be issued with missing identity or weak secrets", async () => {
  assert.throws(() => createInvoicePreviewTokenService({ secret: "short" }), /preview_secret_too_short/);
  const service = createInvoicePreviewTokenService({ secret: SECRET });
  await assert.rejects(service.issue({ ...binding, recipientEmail: "" }), /preview_binding_invalid/);
});

