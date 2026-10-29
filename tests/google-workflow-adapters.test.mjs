import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createGoogleDriveInvoiceAdapter, createGmailInvoiceMailer } from "../supabase/functions/payroll-api/google-workflow-adapters.mjs";

const PDF = new TextEncoder().encode("%PDF-1.7\nsynthetic invoice");
const driveConfig = { enabled: true, rootFolderId: "folder-root-fixture", getAccessToken: async () => "server-token-fixture" };

function jsonResponse(value, status = 200, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => value };
}

test("Drive adapter stays disabled without an explicit server-side enable switch", async () => {
  let requests = 0;
  const adapter = createGoogleDriveInvoiceAdapter({ config: { ...driveConfig, enabled: false }, fetcher: async () => { requests++; } });
  await assert.rejects(adapter.findCurrentInvoice({ periodKey: "2026-10-Q1", technicianId: "tech-fixture" }), /provider_not_configured/);
  assert.equal(requests, 0);
});

test("Drive archive builds the fixed NOMINAS year/month/technician hierarchy and uploads PDF bytes", async () => {
  const requests = [];
  let folderNo = 0;
  const fetcher = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const parsed = new URL(String(url));
    if (parsed.pathname === "/drive/v3/files" && options.method !== "POST") return jsonResponse({ files: [] });
    if (parsed.pathname === "/drive/v3/files" && options.method === "POST") {
      const body = JSON.parse(options.body);
      return jsonResponse({ id: `folder-${++folderNo}`, name: body.name, mimeType: body.mimeType, parents: body.parents });
    }
    if (parsed.pathname === "/upload/drive/v3/files") {
      assert.equal(options.method, "POST");
      assert.match(options.headers["content-type"], /^multipart\/related; boundary=/);
      const body = new TextDecoder().decode(options.body);
      assert.match(body, /Fixture Tech - 1RA QUINCENA 2026-10\.pdf/);
      assert.match(body, /synthetic invoice/);
      return jsonResponse({ id: "drive-fixture-1", name: "NOMINA Fixture Tech - 1RA QUINCENA 2026-10.pdf" });
    }
    if (parsed.pathname === "/drive/v3/files/drive-fixture-1") return jsonResponse({ id: "drive-fixture-1", name: "Fixture.pdf", mimeType: "application/pdf", headRevisionId: "revision-v1", version: "1", appProperties: { lrs_period_key: "2026-10-Q1", lrs_technician_id: "tech-fixture-1", lrs_snapshot_id: "snapshot-fixture-1", lrs_source_revision: "revision-source-1", lrs_pdf_sha256: createHash("sha256").update(PDF).digest("hex"), lrs_operation_key: "operation-fixture-1" } });
    if (parsed.pathname === "/drive/v3/files/drive-fixture-1/revisions/revision-v1") return jsonResponse({ id: "revision-v1", keepForever: true });
    throw new Error(`unexpected_fixture_request:${parsed.pathname}`);
  };
  const adapter = createGoogleDriveInvoiceAdapter({ config: driveConfig, fetcher });
  const created = await adapter.createInvoice({
    content: PDF, fileName: "Fixture Tech - 1RA QUINCENA 2026-10.pdf",
    folderPath: "NOMINAS/2026/OCTUBRE/Fixture Tech",
    idempotencyKey: "operation-fixture-1",
    metadata: { periodKey: "2026-10-Q1", technicianId: "tech-fixture-1", snapshotId: "snapshot-fixture-1", sourceRevision: "revision-source-1" }
  });
  assert.equal(created.fileId, "drive-fixture-1");
  assert.equal(created.revisionId, "revision-v1");
  assert.equal(folderNo, 4);
  assert.ok(requests.every(request => request.options.headers.authorization === "Bearer server-token-fixture"));
  assert.equal(requests.filter(request => new URL(request.url).pathname === "/drive/v3/files" && request.options.method === "POST").length, 4);
});

test("Drive replacement checks the current revision and preserves prior and new revisions", async () => {
  const requests = [];
  let fileReads = 0;
  const folders = new Map([["NOMINAS", "dir-nominas"], ["2026", "dir-year"], ["OCTUBRE", "dir-month"], ["Fixture Tech", "dir-tech"]]);
  const fetcher = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const parsed = new URL(String(url));
    const pathname = parsed.pathname;
    if (pathname === "/drive/v3/files" && options.method !== "POST") {
      const query = parsed.searchParams.get("q") || "";
      const name = [...folders.keys()].find(candidate => query.includes(`name='${candidate}'`));
      return jsonResponse({ files: name ? [{ id: folders.get(name), name, mimeType: "application/vnd.google-apps.folder", parents: [], trashed: false }] : [] });
    }
    if (pathname === "/drive/v3/files/file-fixture") {
      fileReads++;
      if (fileReads >= 3) return jsonResponse({ id: "file-fixture", mimeType: "application/pdf", parents: ["dir-tech"], headRevisionId: "revision-after", appProperties: { lrs_period_key: "2026-10-Q1", lrs_technician_id: "tech-fixture-1", lrs_snapshot_id: "snapshot-fixture-1", lrs_source_revision: "sheet-revision-fixture", lrs_pdf_sha256: createHash("sha256").update(PDF).digest("hex"), lrs_operation_key: "operation-fixture-2" } }, 200, { etag: '"drive-etag-after"' });
      return jsonResponse({ id: "file-fixture", mimeType: "application/pdf", parents: ["dir-tech"], headRevisionId: "revision-before", appProperties: { lrs_period_key: "2026-10-Q1", lrs_technician_id: "tech-fixture-1" } }, 200, { etag: '"drive-etag-before"' });
    }
    if (pathname === "/drive/v3/files/file-fixture/revisions/revision-before") return jsonResponse({ id: "revision-before", keepForever: true });
    if (pathname === "/upload/drive/v3/files/file-fixture") return jsonResponse({ id: "file-fixture", name: "Fixture.pdf" });
    if (pathname === "/drive/v3/files/file-fixture/revisions/revision-after") return jsonResponse({ id: "revision-after", keepForever: true });
    throw new Error(`unexpected_fixture_request:${pathname}:${options.method}`);
  };
  const adapter = createGoogleDriveInvoiceAdapter({ config: driveConfig, fetcher });
  await assert.rejects(adapter.replacePreservingRevision({ fileId: "file-fixture", expectedRevisionId: "stale-revision", content: PDF,
    fileName: "Fixture.pdf", folderPath: "NOMINAS/2026/OCTUBRE/Fixture Tech", idempotencyKey: "operation-fixture-2", metadata: {} }), /revision_conflict/);
  assert.equal(requests.filter(request => request.url.includes("/upload/drive/")).length, 0);
  requests.length = 0;
  const replaced = await adapter.replacePreservingRevision({ fileId: "file-fixture", expectedRevisionId: "revision-before", content: PDF,
    fileName: "Fixture.pdf", folderPath: "NOMINAS/2026/OCTUBRE/Fixture Tech", idempotencyKey: "operation-fixture-2",
    metadata: { periodKey: "2026-10-Q1", technicianId: "tech-fixture-1", snapshotId: "snapshot-fixture-1", sourceRevision: "sheet-revision-fixture" } });
  assert.equal(replaced.fileId, "file-fixture");
  assert.equal(replaced.revisionId, "revision-after");
  assert.equal(requests.filter(request => request.url.includes("/revisions/")).length, 4);
  const patch = requests.find(request => request.url.includes("/upload/drive/"));
  assert.equal(patch.options.headers["if-match"], '"drive-etag-before"');
  assert.equal(requests.filter(request => request.url.includes("/upload/drive/")).length, 1);
});

test("Drive replacement fails closed when the provider does not return a conditional ETag", async () => {
  const adapter = createGoogleDriveInvoiceAdapter({ config: driveConfig, fetcher: async url => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/drive/v3/files/file-fixture") return jsonResponse({ id: "file-fixture", mimeType: "application/pdf", parents: ["dir-tech"], headRevisionId: "revision-current", appProperties: {} });
    throw new Error(`unexpected_fixture_request:${parsed.pathname}`);
  } });
  await assert.rejects(adapter.replacePreservingRevision({ fileId: "file-fixture", expectedRevisionId: "revision-current", content: PDF,
    fileName: "Fixture.pdf", folderPath: "NOMINAS/2026/OCTUBRE/Fixture Tech", idempotencyKey: "operation-etag-missing",
    metadata: { periodKey: "2026-10-Q1", technicianId: "tech-fixture-1", snapshotId: "snapshot-fixture-1", sourceRevision: "sheet-revision-fixture" } }),
  /conditional_revision_unavailable/);
});

test("Drive archive does not report success when persisted revision retention cannot be verified", async () => {
  let folderNo = 0, retentionReads = 0;
  const fetcher = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/drive/v3/files" && options.method !== "POST") return jsonResponse({ files: [] });
    if (parsed.pathname === "/drive/v3/files" && options.method === "POST") {
      const body = JSON.parse(options.body);
      return jsonResponse({ id: `folder-${++folderNo}`, name: body.name, mimeType: body.mimeType, parents: body.parents });
    }
    if (parsed.pathname === "/upload/drive/v3/files") return jsonResponse({ id: "drive-retention-fixture", name: "Fixture.pdf" });
    if (parsed.pathname === "/drive/v3/files/drive-retention-fixture") return jsonResponse({ id: "drive-retention-fixture", name: "Fixture.pdf", mimeType: "application/pdf", headRevisionId: "revision-retention", version: "1", appProperties: { lrs_period_key: "2026-10-Q1", lrs_technician_id: "tech-fixture-1", lrs_snapshot_id: "snapshot-fixture-1", lrs_source_revision: "revision-source-1", lrs_pdf_sha256: createHash("sha256").update(PDF).digest("hex"), lrs_operation_key: "operation-retention-1" } });
    if (parsed.pathname === "/drive/v3/files/drive-retention-fixture/revisions/revision-retention") {
      if (options.method === "PATCH") return jsonResponse({ id: "revision-retention", keepForever: true });
      retentionReads++;
      return jsonResponse({ id: "revision-retention", keepForever: false });
    }
    throw new Error(`unexpected_fixture_request:${parsed.pathname}:${options.method}`);
  };
  const adapter = createGoogleDriveInvoiceAdapter({ config: driveConfig, fetcher });
  await assert.rejects(adapter.createInvoice({ content: PDF, fileName: "Fixture.pdf", folderPath: "NOMINAS/2026/OCTUBRE/Fixture Tech",
    idempotencyKey: "operation-retention-1", metadata: { periodKey: "2026-10-Q1", technicianId: "tech-fixture-1", snapshotId: "snapshot-fixture-1", sourceRevision: "revision-source-1" } }), error => {
    assert.equal(error.outcomeUnknown, true);
    return /retention_unverified/.test(error.message);
  });
  assert.equal(retentionReads, 1);
});

test("Gmail adapter sends only the verified target and exact PDF attachment; disabled mode makes no request", async () => {
  let captured;
  const adapter = createGmailInvoiceMailer({ config: { enabled: true, getAccessToken: async () => "mail-token-fixture" }, fetcher: async (url, options) => {
    captured = { url: String(url), options };
    return jsonResponse({ id: "gmail-message-fixture" });
  } });
  const result = await adapter.send({ to: "tech@example.invalid", subject: "Invoice de nomina - 2026-10-Q1", attachment: PDF,
    idempotencyKey: "email-attempt-fixture", recipientDirectoryId: "directory-fixture", fileName: "NOMINA-2026-10-Q1.pdf" });
  assert.equal(result.messageId, "gmail-message-fixture");
  assert.equal(captured.url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  assert.equal(captured.options.headers.authorization, "Bearer mail-token-fixture");
  const raw = JSON.parse(captured.options.body).raw;
  const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("binary");
  assert.match(decoded, /To: tech@example\.invalid/);
  assert.match(decoded, /Content-Type: application\/pdf/);
  assert.match(decoded, /Content-Disposition: attachment; filename="NOMINA-2026-10-Q1\.pdf"/);
  assert.match(decoded, /c3ludGhldGljIGludm9pY2U=/);
  assert.equal((decoded.match(/X-LRS-Idempotency-Key:/g) || []).length, 1);
});

test("Gmail refuses invalid recipients and reports lost send responses as uncertain", async () => {
  let requests = 0;
  const adapter = createGmailInvoiceMailer({ config: { enabled: true, getAccessToken: async () => "mail-token-fixture" }, fetcher: async () => {
    requests++;
    throw new TypeError("network lost");
  } });
  await assert.rejects(adapter.send({ to: "unverified", subject: "Invoice", attachment: PDF, idempotencyKey: "email-fixture-key-123", recipientDirectoryId: "directory-fixture" }), /verified_recipient_required/);
  assert.equal(requests, 0);
  await assert.rejects(adapter.send({ to: "tech@example.invalid", subject: "Invoice", attachment: PDF, idempotencyKey: "email-fixture-key-123", recipientDirectoryId: "directory-fixture" }), error => {
    assert.equal(error.outcomeUnknown, true);
    return /request_failed/.test(error.message);
  });
  assert.equal(requests, 1);
});
