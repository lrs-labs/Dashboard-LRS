import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createHmac } from "node:crypto";
import { createPayrollBridgeEnvelope } from "../supabase/functions/payroll-api/hmac-bridge.mjs";

const SECRET = "synthetic-only-secret-value-not-for-production-0001";
const NONCE = "AAAAAAAAAAAAAAAAAAAAAA";
const source = readFileSync(new URL("../apps-script/PayrollReadBridge.gs", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../apps-script/appsscript.json", import.meta.url), "utf8"));
const PAYROLL_RANGES = [
  "REGISTRO_CASOS!B3:B20003", "REGISTRO_CASOS!F3:H20003", "REGISTRO_CASOS!J3:K20003",
  "REGISTRO_CASOS!P3:P20003", "REGISTRO_CASOS!U3:W20003", "REGISTRO_CASOS!X3:Z20003",
  "REGISTRO_CASOS!AF3:AH20003", "REGISTRO_CASOS!AI3:AI20003", "REGISTRO_CASOS!AO3:AO20003"
];
const DASHBOARD_RANGES = [
  "REGISTRO_CASOS!B3:B20003", "REGISTRO_CASOS!F3:H20003", "REGISTRO_CASOS!I3:I20003",
  "REGISTRO_CASOS!J3:K20003", "REGISTRO_CASOS!L3:O20003", "REGISTRO_CASOS!P3:P20003",
  "REGISTRO_CASOS!Q3:S20003", "REGISTRO_CASOS!U3:W20003", "REGISTRO_CASOS!X3:AA20003",
  "REGISTRO_CASOS!AE3:AE20003", "REGISTRO_CASOS!AI3:AN20003", "REGISTRO_CASOS!AU3:AU20003"
];
function base64url(bytes) { return Buffer.from(bytes).toString("base64url"); }
function signedRequest(action = "payroll.read.v1", timestamp = Math.floor(Date.now() / 1000), nonce = NONCE) {
  const canonical = `LRS-PAYROLL-HMAC-V1\nPOST\n${timestamp}\n${nonce}\n${action}`;
  const signature = base64url(createHmac("sha256", SECRET).update(canonical, "utf8").digest());
  return { action, timestamp, nonce, signature };
}
function sheetSerial(isoDate) {
  return (Date.parse(`${isoDate}T00:00:00.000Z`) - Date.UTC(1899, 11, 30)) / 86400000;
}
const fixtures = {
  [PAYROLL_RANGES[0]]: [[sheetSerial("2026-10-08")]],
  [PAYROLL_RANGES[1]]: [["1RA QUINCENA", "EXTERNO", "Fixture Client"]],
  [PAYROLL_RANGES[2]]: [["MITIGATION", "KITCHEN"]],
  [PAYROLL_RANGES[3]]: [["COMPLETED"]],
  [PAYROLL_RANGES[4]]: [["Fixture Tech", "", ""]],
  [PAYROLL_RANGES[5]]: [[150, 0, 0]],
  [PAYROLL_RANGES[6]]: [[false, false, false]],
  [PAYROLL_RANGES[7]]: [["YES"]],
  [PAYROLL_RANGES[8]]: [["Fixture Project"]],
  [DASHBOARD_RANGES[2]]: [["Fixture Address"]],
  [DASHBOARD_RANGES[4]]: [["Fixture Insurer", "YES", "NO", 25]],
  [DASHBOARD_RANGES[6]]: [["Fixture observation", "PENDING", sheetSerial("2026-10-09")]],
  [DASHBOARD_RANGES[8]]: [[150, 0, 0, 25]],
  [DASHBOARD_RANGES[9]]: [[175]],
  [DASHBOARD_RANGES[10]]: [["SI", sheetSerial("2026-10-10"), 8, 2, 5, "75F"]],
  [DASHBOARD_RANGES[11]]: [[4.5]]
};
function makeContext() {
  const properties = new Map([["LRS_PAYROLL_BRIDGE_HMAC_SECRET", SECRET], ["LRS_PAYROLL_SOURCE_SHEET_ID", "synthetic-sheet-id"]]);
  const calls = [];
  const propertyStore = {
    getProperty(key) { return properties.get(key) ?? null; },
    setProperty(key, value) { properties.set(key, String(value)); return this; },
    deleteProperty(key) { properties.delete(key); return this; },
    getKeys() { return [...properties.keys()]; }
  };
  const outputFactory = {
    createTextOutput(content) {
      return { content, mimeType: "", setMimeType(mimeType) { this.mimeType = mimeType; return this; }, getContent() { return this.content; } };
    },
    MimeType: { JSON: "application/json" }
  };
  const sandbox = {
    Object, Date, Math, JSON, Number, String, Array, RegExp, Map,
    Utilities: {
      Charset: { UTF_8: "UTF-8" },
      newBlob(value) { return { getBytes() { return [...Buffer.from(String(value), "utf8")]; } }; },
      computeHmacSha256Signature(value, key) { return [...createHmac("sha256", key).update(value, "utf8").digest()]; },
      base64EncodeWebSafe(bytes) { return base64url(bytes); }
    },
    PropertiesService: { getScriptProperties() { return propertyStore; } },
    LockService: { getScriptLock() { return { tryLock() { return true; }, releaseLock() {} }; } },
    Sheets: { Spreadsheets: { Values: { batchGet(id, options) {
      calls.push({ id, options });
      assert.equal(id, "synthetic-sheet-id");
      return { valueRanges: options.ranges.map(range => ({ range, values: range === "TABULADOR!A1:Z500" ? [["FLOOD", "KITCHEN", "$150"]] : fixtures[range] || [] })) };
    } } } },
    ContentService: outputFactory
  };
  vm.runInNewContext(source, sandbox, { filename: "PayrollReadBridge.gs" });
  return { doPost: sandbox.doPost, properties, calls };
}
function request(envelope, overrides = {}) {
  return { postData: { type: "application/json", contents: JSON.stringify({ ...envelope, ...overrides }) }, queryString: null };
}
function body(output) { return JSON.parse(output.getContent()); }

test("manifest grants only Sheets readonly and enables the fixed advanced service", () => {
  assert.deepEqual(manifest.oauthScopes, ["https://www.googleapis.com/auth/spreadsheets.readonly"]);
  assert.deepEqual(manifest.dependencies.enabledAdvancedServices, [{ userSymbol: "Sheets", serviceId: "sheets", version: "v4" }]);
});

test("valid payroll request reads only the fixed payroll projection", async () => {
  const context = makeContext();
  const envelope = await createPayrollBridgeEnvelope(SECRET, { timestamp: Math.floor(Date.now() / 1000), nonce: NONCE });
  const response = body(context.doPost(request(envelope)));
  assert.equal(response.ok, true);
  assert.equal(response.schema, 1);
  assert.equal(response.action, "payroll.read.v1");
  assert.equal(response.rows.length, 1);
  assert.equal(response.rows[0].project, "Fixture Project");
  assert.equal(response.rows[0].category, "EXTERNO");
  assert.equal(response.rows[0].paidTP, false);
  assert.equal(context.calls.length, 1);
  assert.deepEqual(Array.from(context.calls[0].options.ranges), PAYROLL_RANGES);
  assert.equal(context.calls[0].options.valueRenderOption, "UNFORMATTED_VALUE");
  assert.equal(context.calls[0].options.dateTimeRenderOption, "SERIAL_NUMBER");
});

test("dashboard request reads only the dashboard projection and bounded tabulator", async () => {
  const context = makeContext();
  const envelope = await createPayrollBridgeEnvelope(SECRET, { action: "dashboard.read.v1", timestamp: Math.floor(Date.now() / 1000), nonce: NONCE });
  const response = body(context.doPost(request(envelope)));
  assert.equal(response.ok, true);
  assert.equal(response.action, "dashboard.read.v1");
  assert.equal(response.rows.length, 1);
  assert.equal(response.rows[0].address, "Fixture Address");
  assert.equal(response.rows[0].quality, 4.5);
  assert.deepEqual(response.tabCells, [[0, 0, "FLOOD"], [0, 1, "KITCHEN"], [0, 2, "$150"]]);
  assert.deepEqual(Array.from(context.calls[0].options.ranges), DASHBOARD_RANGES);
  assert.deepEqual(Array.from(context.calls[1].options.ranges), ["TABULADOR!A1:Z500"]);
  assert.equal(context.calls[1].options.valueRenderOption, "FORMATTED_VALUE");
});

test("invalid signature, stale timestamp, query action, extra fields, and replay fail closed", async () => {
  const context = makeContext();
  const valid = signedRequest();
  assert.equal(body(context.doPost(request(valid, { signature: "A".repeat(43) }))).ok, false);
  assert.equal(body(context.doPost(request(signedRequest("payroll.read.v1", Math.floor(Date.now() / 1000) - 1000, "BBBBBBBBBBBBBBBBBBBBBB")))).error, "unauthorized");
  assert.equal(body(context.doPost({ ...request(valid), queryString: "action=anything" })).error, "invalid_request");
  assert.equal(body(context.doPost(request(valid, { range: "A:ZZ" }))).error, "invalid_request");
  assert.equal(body(context.doPost(request(signedRequest("dashboard.write.v1")))).error, "invalid_request");
  assert.equal(body(context.doPost(request(valid))).ok, true);
  assert.equal(body(context.doPost(request(valid))).error, "replay_or_busy");
});

test("body size and malformed content types are rejected before reading the workbook", () => {
  const context = makeContext();
  const huge = { postData: { type: "application/json", contents: "x".repeat(2049) }, queryString: null };
  assert.equal(body(context.doPost(huge)).error, "invalid_request");
  assert.equal(body(context.doPost({ postData: { type: "text/plain", contents: "{}" } })).error, "invalid_request");
  assert.equal(context.calls.length, 0);
});

test("dashboard read refuses data beyond its fixed row limit instead of truncating it", async () => {
  const context = makeContext();
  const overflow = Array.from({ length: 20001 }, () => []);
  overflow[20000] = ["late row"];
  fixtures[DASHBOARD_RANGES[0]] = overflow;
  const envelope = await createPayrollBridgeEnvelope(SECRET, { action: "dashboard.read.v1", timestamp: Math.floor(Date.now() / 1000), nonce: NONCE });
  assert.equal(body(context.doPost(request(envelope))).error, "read_unavailable");
});
