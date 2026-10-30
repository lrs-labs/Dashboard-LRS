import test from "node:test";
import assert from "node:assert/strict";
import { PAYROLL_API_BODY_LIMIT_BYTES, readRequestBodyLimited } from "../supabase/functions/payroll-api/request-body-limit.mjs";

test("signed invoice confirmation bodies larger than the old 1024-byte cap remain within the bounded API limit", async () => {
  const body = JSON.stringify({ action: "invoice.send-confirm", periodKey: "2026-10-Q1", snapshotId: "snapshot-fixture", technicianId: "tech-fixture", previewToken: "x".repeat(4096) });
  assert.ok(new TextEncoder().encode(body).byteLength > 1024);
  assert.ok(new TextEncoder().encode(body).byteLength < PAYROLL_API_BODY_LIMIT_BYTES);
  const result = await readRequestBodyLimited(new Request("https://app.example.test/api", { method: "POST", headers: { "content-type": "application/json" }, body }));
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.text), JSON.parse(body));
});

test("request reader rejects oversized declared and streamed bodies and malformed UTF-8", async () => {
  const declared = await readRequestBodyLimited(new Request("https://app.example.test/api", { method: "POST", headers: { "content-length": String(PAYROLL_API_BODY_LIMIT_BYTES + 1) }, body: "{}" }));
  assert.deepEqual(declared, { ok: false, reason: "too_large" });
  const streamed = new Request("https://app.example.test/api", { method: "POST", body: "x".repeat(PAYROLL_API_BODY_LIMIT_BYTES + 1) });
  assert.deepEqual(await readRequestBodyLimited(streamed), { ok: false, reason: "too_large" });
  const invalid = new Request("https://app.example.test/api", { method: "POST", body: new Uint8Array([0xc3, 0x28]) });
  assert.deepEqual(await readRequestBodyLimited(invalid), { ok: false, reason: "invalid_utf8" });
});
