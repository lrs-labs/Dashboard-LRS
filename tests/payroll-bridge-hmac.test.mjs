import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { canonicalPayrollBridgeMessage, createPayrollBridgeEnvelope, validatePayrollBridgeUrl } from "../supabase/functions/payroll-api/hmac-bridge.mjs";

const SECRET = "fixture-secret-for-tests-only-0000000000000000";
const NONCE = "AAAAAAAAAAAAAAAAAAAAAA";

test("HMAC envelope uses a fixed action and canonical POST signature", async () => {
  const timestamp = 1_798_000_000;
  const envelope = await createPayrollBridgeEnvelope(SECRET, { timestamp, nonce: NONCE });
  assert.deepEqual(envelope, {
    action: "payroll.read.v1",
    timestamp,
    nonce: NONCE,
    signature: createHmac("sha256", SECRET)
      .update(canonicalPayrollBridgeMessage(timestamp, NONCE), "utf8")
      .digest("base64url")
  });
});

test("HMAC envelope rejects weak secrets, caller-selected actions, and malformed nonces", async () => {
  await assert.rejects(createPayrollBridgeEnvelope("too-short", { timestamp: 1, nonce: NONCE }), /32_bytes/);
  assert.throws(() => canonicalPayrollBridgeMessage(1, NONCE, "payroll.write"), /invalid_action/);
  assert.throws(() => canonicalPayrollBridgeMessage(1, NONCE, "drive.write"), /invalid_action/);
  assert.throws(() => canonicalPayrollBridgeMessage(1, "not-a-valid-nonce"), /invalid_nonce/);
  assert.throws(() => canonicalPayrollBridgeMessage(Number.NaN, NONCE), /invalid_timestamp/);
});

test("dashboard HMAC action is explicit and distinct from payroll", async () => {
  const timestamp = 1_798_000_000;
  const envelope = await createPayrollBridgeEnvelope(SECRET, { action: "dashboard.read.v1", timestamp, nonce: NONCE });
  assert.deepEqual(envelope, {
    action: "dashboard.read.v1", timestamp, nonce: NONCE,
    signature: createHmac("sha256", SECRET)
      .update(canonicalPayrollBridgeMessage(timestamp, NONCE, "dashboard.read.v1"), "utf8")
      .digest("base64url")
  });
});

test("bridge URL permits only a clean Apps Script web-app URL", () => {
  assert.equal(validatePayrollBridgeUrl("https://script.google.com/macros/s/example-deployment/exec"), true);
  assert.equal(validatePayrollBridgeUrl("http://script.google.com/macros/s/example-deployment/exec"), false);
  assert.equal(validatePayrollBridgeUrl("https://example.com/macros/s/example-deployment/exec"), false);
  assert.equal(validatePayrollBridgeUrl("https://script.google.com/macros/s/example-deployment/exec?range=A:ZZ"), false);
});
