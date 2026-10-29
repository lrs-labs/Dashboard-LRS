import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { loadPrivateAuthRuntime, SUPABASE_BROWSER_SDK_URL } from "../private-runtime-bootstrap.mjs";
import { isSupabasePublishableKey } from "../private-auth-runtime.mjs";

const origin = "https://lrs.example.test";
const require = createRequire(import.meta.url);
const config = { allowedOrigin: origin, supabaseUrl: "https://project.example.supabase.co", publishableKey: "sb_publishable_fixture_public_key_123456" };
function memoryStorage() { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; }

test("bootstrap fetches deployment configuration at runtime without credentials or caching, then creates the Supabase client", async () => {
  let request, sdkLoads = 0, clientArgs;
  const runtime = await loadPrivateAuthRuntime({ getOrigin: () => origin, sessionStorage: memoryStorage(),
    fetcher: async (url, options) => { request = { url, options }; return { ok: true, async json() { return config; } }; },
    loadSdk: async () => { sdkLoads++; return (...args) => { clientArgs = args; return { auth: {} }; }; } });
  assert.equal(runtime.config.enabled, true);
  assert.equal(request.url, `${origin}/api/private-runtime-config`);
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.cache, "no-store");
  assert.equal(request.options.redirect, "error");
  assert.equal(sdkLoads, 1);
  assert.equal(clientArgs[0], config.supabaseUrl);
  assert.equal(clientArgs[1], config.publishableKey);
  assert.match(SUPABASE_BROWSER_SDK_URL, /supabase-js@2\.118\.0/);
});

test("bootstrap fails closed for wrong origin, missing config, and service-role key without loading the SDK", async () => {
  let fetches = 0, sdkLoads = 0;
  const options = { getOrigin: () => "http://insecure.example.test", fetcher: async () => { fetches++; }, loadSdk: async () => { sdkLoads++; } };
  assert.equal((await loadPrivateAuthRuntime(options)).config.enabled, false);
  assert.equal(fetches, 0);
  const invalid = await loadPrivateAuthRuntime({ getOrigin: () => origin,
    fetcher: async () => { fetches++; return { ok: true, async json() { return { ...config, publishableKey: "sb_" + "secret_do_not_allow_this_key" }; } }; },
    loadSdk: async () => { sdkLoads++; } });
  assert.equal(invalid.config.enabled, false);
  assert.equal(sdkLoads, 0);
  assert.equal((await loadPrivateAuthRuntime({ getOrigin: () => origin, fetcher: async () => ({ ok: false }), loadSdk: async () => { sdkLoads++; } })).config.enabled, false);
  assert.equal(isSupabasePublishableKey("sb_" + "secret_fixture_private_value"), false);
});

test("Vercel runtime config route is GET-only, exact-origin, private-cache and reads only server env names", async () => {
  const routeSource = await readFile(new URL("../api/private-runtime-config.js", import.meta.url), "utf8");
  assert.doesNotMatch(routeSource, /sb_publishable_[A-Za-z0-9_-]{20,}/);
  const { createHandler } = require("../api/private-runtime-config.js");
  const env = { APP_ORIGIN: origin, SUPABASE_URL: config.supabaseUrl, SUPABASE_PUBLISHABLE_KEY: config.publishableKey };
  function call(method = "GET", headers = { host: "lrs.example.test", "x-forwarded-proto": "https" }) {
    const outputHeaders = {};
    const out = { setHeader(key, value) { outputHeaders[key] = value; }, end(body) { this.body = body; } };
    createHandler(env)({ method, headers }, out);
    return { status: out.statusCode, headers: outputHeaders, body: JSON.parse(out.body) };
  }
  const accepted = call();
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body, config);
  assert.match(accepted.headers["cache-control"], /no-store/);
  assert.equal(call("POST").status, 405);
  assert.equal(call("GET", { host: "attacker.example", "x-forwarded-proto": "https" }).status, 403);
  assert.equal(call("GET", { host: "lrs.example.test", origin: "https://attacker.example", "x-forwarded-proto": "https" }).status, 403);
  const invalidOutput = { setHeader() {}, end(body) { this.body = JSON.parse(body); } };
  createHandler({ ...env, SUPABASE_PUBLISHABLE_KEY: "sb_" + "secret_not_public" })({ method: "GET", headers: { host: "lrs.example.test", "x-forwarded-proto": "https" } }, invalidOutput);
  assert.equal(invalidOutput.statusCode, 503);
  assert.equal(invalidOutput.body.error, "runtime_not_configured");
});
