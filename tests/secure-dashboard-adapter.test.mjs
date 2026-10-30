import test from "node:test";
import assert from "node:assert/strict";
import { applyPrivateDashboardDataset, readPrivateDashboard } from "../secure-dashboard-adapter.mjs";

const url = "https://lrs-project.example/functions/v1/payroll-api";
const fixture = {
  schema: 1,
  readAt: "2026-10-29T16:00:00.000Z",
  rows: [{ date: "2026-10-12", period: "1RA QUINCENA", category: "NEW", client: "Synthetic client", address: "Synthetic address", activity: "MITIGATION", caseName: "KITCHEN", insurer: "Fixture insurer", limit: "YES", report: "YES", prv: "0", status: "COMPLETED", observation: "", returnStatus: "", returnDate: "", tp: "Fixture tech", ta1: "", ta2: "", amountTP: 180, amountTA1: 0, amountTA2: 0, amountPRV: 0, subtotal: 180, reportStatus: "SI", deliveredDate: "2026-10-13", hours360: "", inspectionHours: "", workHours: "", temperatures: "", quality: 5 }],
  tabCells: [[0, 0, "MITIGATION"], [0, 1, "KITCHEN"], [1, 1, "$180"]]
};
const ok = value => ({ ok: true, status: 200, json: async () => value });

test("private dashboard adapter makes a fresh authenticated no-store request", async () => {
  let request;
  const result = await readPrivateDashboard({ endpoint: url, publishableKey: "fixture-public-key", accessToken: "fixture-session", fetcher: async (target, init) => { request = { target, init }; return ok(fixture); } });
  assert.equal(result.state, "ready");
  assert.equal(result.dataset.rows[0].length, 30);
  assert.equal(result.dataset.rows[0][4], "Synthetic address");
  assert.deepEqual(result.dataset.tab, fixture.tabCells);
  assert.equal(request.target, url);
  assert.equal(request.init.cache, "no-store");
  assert.equal(request.init.credentials, "omit");
  assert.deepEqual(JSON.parse(request.init.body), { action: "dashboard.read" });
});

test("dashboard adapter does not call network without a signed-in session and has no fallback", async () => {
  let calls = 0;
  const missing = await readPrivateDashboard({ endpoint: url, publishableKey: "fixture-key", accessToken: "", fetcher: async () => { calls++; return ok(fixture); } });
  const denied = await readPrivateDashboard({ endpoint: url, publishableKey: "fixture-key", accessToken: "session", fetcher: async () => ({ ok: false, status: 403 }) });
  const malformed = await readPrivateDashboard({ endpoint: url, publishableKey: "fixture-key", accessToken: "session", fetcher: async () => ok({ schema: 1, rows: fixture.rows }) });
  assert.equal(missing.state, "unconfigured");
  assert.equal(denied.state, "denied");
  assert.equal(denied.dataset, null);
  assert.equal(malformed.state, "error");
  assert.equal(malformed.dataset, null);
  assert.equal(calls, 0);
});

test("adapter feeds private rows to existing dashboard and tabulator calculators without local caching", () => {
  const calls = [];
  applyPrivateDashboardDataset({ ...fixture, rows: [["synthetic"]], tab: fixture.tabCells }, {
    loadDataset: (...args) => calls.push(["dashboard", ...args]),
    applyTab: (...args) => calls.push(["tabulator", ...args])
  });
  assert.deepEqual(calls, [
    ["dashboard", [["synthetic"]], "Supabase · lectura privada", fixture.readAt],
    ["tabulator", fixture.tabCells, "Supabase · lectura privada"]
  ]);
});
