import test from "node:test";
import assert from "node:assert/strict";
import { loadPrivateAuthRuntime } from "../private-runtime-bootstrap.mjs";

const origin = "https://dashboard.example.test";
const config = Object.freeze({
  enabled: true,
  supabaseUrl: "https://synthetic-project.supabase.co",
  publishableKey: "sb_publishable_fixture_value_that_is_not_a_real_key",
  allowedOrigin: origin
});
function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}

test("Pages bootstrap consumes injected public configuration without calling a server route", async () => {
  let fetches = 0, sdkLoads = 0, created;
  const globalObject = { LRS_PUBLIC_RUNTIME_CONFIG: config };
  const storage = memoryStorage();
  const result = await loadPrivateAuthRuntime({
    globalObject,
    getOrigin: () => origin,
    fetcher: async () => { fetches++; throw new Error("Pages has no API route"); },
    loadSdk: async () => { sdkLoads++; return (...args) => { created = args; return { auth: {} }; }; },
    sessionStorage: storage
  });
  assert.equal(result.reason, null);
  assert.equal(result.config.enabled, true);
  assert.equal(fetches, 0);
  assert.equal(sdkLoads, 1);
  assert.equal(created[0], config.supabaseUrl);
  assert.equal(created[1], config.publishableKey);
});

test("missing configuration fails closed without loading the SDK or fetching", async () => {
  let sdkLoads = 0, fetches = 0;
  const result = await loadPrivateAuthRuntime({
    globalObject: {}, getOrigin: () => origin,
    fetcher: async () => { fetches++; }, loadSdk: async () => { sdkLoads++; }
  });
  assert.equal(result.config.enabled, false);
  assert.equal(result.reason, "runtime_config_unavailable");
  assert.equal(fetches, 0);
  assert.equal(sdkLoads, 0);
});

test("invalid origin, privileged config fields, and malformed keys fail before SDK load", async () => {
  const cases = [
    [config, "https://attacker.example"],
    [{ ...config, serviceRoleKey: "must never reach browser" }, origin],
    [{ ...config, supabaseUrl: "http://synthetic-project.supabase.co" }, origin],
    [{ ...config, publishableKey: "private-server-secret" }, origin]
  ];
  for (const [candidate, pageOrigin] of cases) {
    let sdkLoads = 0;
    const result = await loadPrivateAuthRuntime({
      globalObject: { LRS_PUBLIC_RUNTIME_CONFIG: candidate }, getOrigin: () => pageOrigin,
      loadSdk: async () => { sdkLoads++; return () => ({ auth: {} }); }, sessionStorage: memoryStorage()
    });
    assert.equal(result.config.enabled, false);
    assert.equal(sdkLoads, 0);
  }
});
