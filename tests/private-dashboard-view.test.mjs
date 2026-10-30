import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculateHourlyComparison, filterDashboardRows, parseSecureTabulator, summarizeDashboardRows } from "../private-dashboard-view.mjs";

const source = [
  ["2026-10-12", "1RA QUINCENA", "SAFECORE", "Synthetic Client", "Synthetic Address", "MITIGATION", "KITCHEN", "Synthetic Insurer", "YES", "YES", 0, "COMPLETED", "", "", "", "TP Fixture", "TA Fixture", "", 180, 130, 0, 0, 310, "SI", "2026-10-13", "", "", "", "", 4.8],
  ["2026-10-13", "1RA QUINCENA", "EXTERNO", "Second Client", "Second Address", "FLOOD", "HOUR", "", "", "", 0, "REALIZADO", "", "", "", "TP Fixture", "", "", 180, 0, 0, 0, 180, "PENDING", "", "", "", "", "", 4.6]
];

test("private dashboard filters and summarizes all statuses without inventing pay values", () => {
  const rows = filterDashboardRows(source, { year: "2026", status: "REALIZADO", technician: "TP Fixture" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, "EXTERNO");
  assert.deepEqual(summarizeDashboardRows(source), { total: 2, completed: 1, realized: 1, inProgress: 0, pending: 0, activities: [{ name: "FLOOD", count: 1 }, { name: "MITIGATION", count: 1 }] });
});

test("private tabulator parser reads source rates and hourly calculator only uses the supplied rates", () => {
  const cells = [[0, 0, "FLOOD"], [1, 2, "$22"], [1, 3, "$16"], [3, 0, "MITIGATION"], [4, 0, "CASO"], [5, 0, "KITCHEN"], [5, 1, "$180"], [5, 2, "$130"], [5, 3, "$310"]];
  const model = parseSecureTabulator(cells);
  assert.deepEqual(model.blocks[0].rows[0], { name: "KITCHEN", tp: 180, ta: 130, total: 310 });
  assert.deepEqual(model.flood, { tp: 22, ta: 16 });
  assert.deepEqual(calculateHourlyComparison(8, model.flood.tp, model.flood.ta), { hours: 8, tp: 176, ta: 128, combined: 304 });
  assert.equal(calculateHourlyComparison(-1, 22, 16), null);
});

test("private tabulator preserves percentage pickups and fixed amount rows as distinct tariff types", () => {
  const model = parseSecureTabulator([[0, 0, "MITIGATION"], [1, 0, "CASO"], [2, 0, "PICKUP"], [2, 1, "30%"], [3, 0, "SINK"], [3, 3, "$20"]]);
  assert.deepEqual(model.blocks[0].rows, [
    { name: "PICKUP", percentage: 30 },
    { name: "SINK", total: 20 }
  ]);
});

test("private dashboard shell exposes its secure views without a public Sheet, JSONP, or local data cache path", () => {
  const html = readFileSync(new URL("../private-dashboard.html", import.meta.url), "utf8");
  assert.match(html, /id="signIn"/);
  assert.match(html, /id="dashboardView"/);
  assert.match(html, /id="tabulatorView"/);
  assert.match(html, /href="\.\/payroll-private\.html"/);
  assert.match(html, /private-dashboard-ui\.mjs/);
  assert.doesNotMatch(html, /https:\/\/(?:docs\.google\.com\/spreadsheets|script\.google\.com\/macros)|localStorage|google\.script\.run|window\.__ops/i);
  assert.match(html, /no recurre a GViz, JSONP ni cachés/i);
});
