import { dashboardToLegacyPayload } from "./supabase/functions/payroll-api/policy.mjs";

export async function readPrivateDashboard({ endpoint, publishableKey, accessToken, fetcher = globalThis.fetch } = {}) {
  if (!endpoint || !publishableKey || !accessToken || typeof fetcher !== "function") {
    return { state: "unconfigured", dataset: null };
  }
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: {
        apikey: publishableKey,
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ action: "dashboard.read" })
    });
    if (response.status === 401) return { state: "signed_out", dataset: null };
    if (response.status === 403) return { state: "denied", dataset: null };
    if (response.status === 503) return { state: "unavailable", dataset: null };
    if (!response.ok) return { state: "error", dataset: null };
    const payload = await response.json();
    const dataset = dashboardToLegacyPayload(payload);
    return { state: "ready", dataset };
  } catch (_) {
    return { state: "error", dataset: null };
  }
}

export function applyPrivateDashboardDataset(dataset, { loadDataset, applyTab } = {}) {
  if (!dataset || typeof loadDataset !== "function" || typeof applyTab !== "function") {
    throw new TypeError("dashboard_adapters_required");
  }
  // Existing filters, charts, tabulator, and calculators can keep their
  // current normalizers. Persisting the rows remains disabled in secure mode.
  loadDataset(dataset.rows, "Supabase · lectura privada", dataset.readAt || undefined);
  applyTab(dataset.tab, "Supabase · lectura privada");
}
