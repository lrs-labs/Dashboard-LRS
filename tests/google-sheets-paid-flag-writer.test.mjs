import test from "node:test";
import assert from "node:assert/strict";
import Payroll from "../payroll-core.js";
import { createGoogleSheetsPaidFlagWriter } from "../supabase/functions/payroll-api/google-sheets-paid-flag-writer.mjs";
import { calculateAssignmentHashes } from "../supabase/functions/payroll-api/assignment-identity.mjs";
import { contentAddressedPayrollEventRef } from "../supabase/functions/payroll-api/payroll-source-projection.mjs";

const BASE_CONFIG = { enabled: true, writeEnabled: true, sourceWriteGuardVerified: true,
  sourceTabName: "REGISTRO_CASOS", spreadsheetId: "synthetic-sheet-id", sourceTabId: 7,
  getAccessToken: async () => "synthetic-access-token" };
const assignmentId = "018f47a2-13a4-7b2c-8d2a-000000000001";
const row = Array(41).fill("");
row[1] = 46303; row[5] = "1RA QUINCENA"; row[6] = "EXTERNO"; row[7] = "Fixture Client";
row[9] = "MITIGATION"; row[10] = "CASE-7"; row[15] = "COMPLETED"; row[20] = "Fixture Tech";
row[23] = 180; row[31] = false; row[40] = "Fixture Project";

async function lineFixture(overrides = {}) {
  const source = { date: "2026-10-08", period: "1RA QUINCENA", category: "EXTERNO", client: "Fixture Client", project: "Fixture Project",
    activity: "MITIGATION", caseName: "CASE-7", status: "COMPLETED", tp: "Fixture Tech", ta1: "", ta2: "",
    amountTP: 180, amountTA1: 0, amountTA2: 0, paidTP: false, paidTA1: false, paidTA2: false };
  const line = Payroll.buildAssignments([source]).lines.find(item => item.role === "TP");
  const eventRef = await contentAddressedPayrollEventRef(source, line);
  const hashes = await calculateAssignmentHashes({ eventRef, periodKey: line.periodKey, date: line.date, project: line.project,
    client: line.client, caseName: line.caseName, activity: line.activity, technicianId: "tech-fixture-1", role: "TP",
    amount: 180, jobStatus: line.jobStatus, cancellationFee: line.cancellationFee });
  return { assignmentId, technicianId: "tech-fixture-1", role: "TP", sheetMetadataId: 91,
    sourceFingerprintHash: hashes.sourceFingerprintHash, amount: 180, periodKey: "2026-10-Q1", paidFlag: false, ...overrides };
}

function makeFetcher({ initialPaid = false, metadataMatches = 1, loseWrite = false } = {}) {
  const requests = [];
  let paid = initialPaid;
  const fetcher = async (url, options = {}) => {
    const parsed = new URL(String(url));
    requests.push({ path: parsed.pathname, options });
    if (parsed.pathname.endsWith("/developerMetadata:search")) {
      const records = Array.from({ length: metadataMatches }, () => ({ developerMetadata: { metadataId: 91,
        metadataKey: "lrs.payroll.assignment.v1", metadataValue: `${assignmentId}:TP`,
        location: { locationType: "ROW", dimensionRange: { sheetId: 7, startIndex: 5, endIndex: 6 } } } }));
      return response({ matchedDeveloperMetadata: records });
    }
    if (parsed.pathname.endsWith("/values:batchGetByDataFilter")) {
      const values = row.slice(); values[31] = paid;
      return response({ valueRanges: [{ valueRange: { values: [values] } }] });
    }
    if (parsed.pathname.endsWith("/values:batchUpdateByDataFilter")) {
      const body = JSON.parse(options.body);
      const sent = body.data[0].values[0];
      const nonNull = sent.flatMap((value, index) => value === null ? [] : [[index, value]]);
      assert.deepEqual(nonNull, [[31, true]], "the API request may change AF only for the TP slot");
      if (loseWrite) throw new TypeError("synthetic network loss");
      paid = true;
      return response({ totalUpdatedCells: 1, totalUpdatedRows: 1, totalUpdatedSheets: 1 });
    }
    throw new Error(`unexpected_sheet_request:${parsed.pathname}`);
  };
  return { fetcher, requests, get paid() { return paid; } };
}
function response(value, status = 200) { return { ok: status >= 200 && status < 300, status, async json() { return value; } }; }
function snapshot(line) { return { state: "closed", frozen: true, digest: "d".repeat(64), periodKey: line.periodKey, lines: [line] }; }

test("writer is disabled by default and fails before any API request without the independently verified guard", async () => {
  let requests = 0;
  const writer = createGoogleSheetsPaidFlagWriter({ config: {}, core: Payroll, fetcher: async () => { requests++; } });
  await assert.rejects(writer.preflightClosedSnapshot({ snapshot: {} }), /paid_writer_disabled/);
  assert.equal(requests, 0);
});

test("preflight verifies stable metadata and fingerprint; calendar update changes only AF and confirms readback", async () => {
  const fixture = makeFetcher();
  const writer = createGoogleSheetsPaidFlagWriter({ config: BASE_CONFIG, core: Payroll, fetcher: fixture.fetcher });
  const line = await lineFixture();
  assert.deepEqual(await writer.preflightClosedSnapshot({ snapshot: snapshot(line) }), { state: "ready" });
  const result = await writer.setPaidFlagByStableAssignmentId({ ...line, expectedPaidFlag: false, paidFlag: true,
    snapshotId: "snapshot-fixture", idempotencyKey: "job-fixture-key-001", origin: "automatic-calendar-policy" });
  assert.equal(result.updated, true);
  assert.equal(result.bankTransferVerified, false);
  assert.equal(fixture.paid, true);
  assert.equal(fixture.requests.filter(item => item.path.endsWith("/values:batchUpdateByDataFilter")).length, 1);
});

test("ambiguous metadata, changed source fingerprint, and a manual paid flag block all writes", async () => {
  const ambiguous = makeFetcher({ metadataMatches: 2 });
  const line = await lineFixture();
  const ambiguousWriter = createGoogleSheetsPaidFlagWriter({ config: BASE_CONFIG, core: Payroll, fetcher: ambiguous.fetcher });
  assert.equal((await ambiguousWriter.preflightClosedSnapshot({ snapshot: snapshot(line) })).state, "needs_review");
  assert.equal(ambiguous.requests.some(item => item.path.endsWith("/values:batchUpdateByDataFilter")), false);

  const stale = makeFetcher();
  const staleWriter = createGoogleSheetsPaidFlagWriter({ config: BASE_CONFIG, core: Payroll, fetcher: stale.fetcher });
  await assert.rejects(staleWriter.setPaidFlagByStableAssignmentId({ ...line, sourceFingerprintHash: "a".repeat(64), expectedPaidFlag: false,
    paidFlag: true, snapshotId: "snapshot-fixture", idempotencyKey: "job-fixture-key-002", origin: "automatic-calendar-policy" }), /fingerprint_mismatch/);
  assert.equal(stale.requests.some(item => item.path.endsWith("/values:batchUpdateByDataFilter")), false);

  const manuallyPaid = makeFetcher({ initialPaid: true });
  const manualWriter = createGoogleSheetsPaidFlagWriter({ config: BASE_CONFIG, core: Payroll, fetcher: manuallyPaid.fetcher });
  assert.deepEqual(await manualWriter.preflightClosedSnapshot({ snapshot: snapshot(line) }), { state: "needs_review", reason: "manual_payment_conflict" });
  assert.equal(manuallyPaid.requests.some(item => item.path.endsWith("/values:batchUpdateByDataFilter")), false);
});

test("preflight accepts a paid flag only when the closed snapshot job durably attributes that exact slot", async () => {
  const line = await lineFixture();
  const alreadyPaid = makeFetcher({ initialPaid: true });
  const writer = createGoogleSheetsPaidFlagWriter({ config: BASE_CONFIG, core: Payroll, fetcher: alreadyPaid.fetcher });
  assert.deepEqual(await writer.preflightClosedSnapshot({ snapshot: snapshot(line), attributedPaidAssignments: [] }),
    { state: "needs_review", reason: "manual_payment_conflict" });
  assert.deepEqual(await writer.preflightClosedSnapshot({ snapshot: snapshot(line), attributedPaidAssignments: [
    { assignmentId: line.assignmentId, role: line.role, idempotencyKey: "fixture-calendar-job" }
  ] }), { state: "ready" });

  const missingWrite = makeFetcher({ initialPaid: false });
  const missingWriter = createGoogleSheetsPaidFlagWriter({ config: BASE_CONFIG, core: Payroll, fetcher: missingWrite.fetcher });
  assert.deepEqual(await missingWriter.preflightClosedSnapshot({ snapshot: snapshot(line), attributedPaidAssignments: [
    { assignmentId: line.assignmentId, role: line.role, idempotencyKey: "fixture-calendar-job" }
  ] }), { state: "needs_review", reason: "automated_payment_flag_missing" });
  assert.equal(alreadyPaid.requests.some(item => item.path.endsWith("/values:batchUpdateByDataFilter")), false);
  assert.equal(missingWrite.requests.some(item => item.path.endsWith("/values:batchUpdateByDataFilter")), false);
});

test("lost Sheets write response is surfaced as unknown and never blindly retried", async () => {
  const fixture = makeFetcher({ loseWrite: true });
  const writer = createGoogleSheetsPaidFlagWriter({ config: BASE_CONFIG, core: Payroll, fetcher: fixture.fetcher });
  const line = await lineFixture();
  await assert.rejects(writer.setPaidFlagByStableAssignmentId({ ...line, expectedPaidFlag: false, paidFlag: true,
    snapshotId: "snapshot-fixture", idempotencyKey: "job-fixture-key-003", origin: "automatic-calendar-policy" }), error => {
      assert.equal(error.outcomeUnknown, true);
      return /request_failed/.test(error.message);
    });
  assert.equal(fixture.requests.filter(item => item.path.endsWith("/values:batchUpdateByDataFilter")).length, 1);
});
