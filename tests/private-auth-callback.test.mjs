import test from "node:test";
import assert from "node:assert/strict";
import { loadPrivateAuthRuntime } from "../private-runtime-bootstrap.mjs";

const origin = "https://lrs.example.test";
const config = {
  enabled: true,
  supabaseUrl: "https://project.example.supabase.co",
  publishableKey: "sb_publishable_fixture_value_that_is_not_a_real_key",
  allowedOrigin: origin
};

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
}

async function makeRuntime(href, createAuth = () => ({})) {
  const location = {
    href,
    get origin() { return new URL(this.href).origin; }
  };
  const events = [];
  const history = {
    state: { page: "payroll" },
    replaceState(state, _title, nextUrl) {
      events.push("scrub");
      this.state = state;
      location.href = new URL(nextUrl, location.href).href;
    }
  };
  const authClient = { auth: createAuth({ location, history, events }) };
  let sdkArgs;
  const runtime = await loadPrivateAuthRuntime({
    runtimeConfig: config,
    globalObject: { location, history },
    sessionStorage: memoryStorage(),
    verifierStorage: memoryStorage(),
    loadSdk: async () => (...args) => {
      sdkArgs = args;
      return authClient;
    }
  });
  return { runtime, location, history, events, authClient, getSdkArgs: () => sdkArgs };
}

test("default Supabase invite fragment is consumed before PKCE SDK auto-detection", async () => {
  let supplied;
  let locationAfterScrub;
  const harness = await makeRuntime(
    `${origin}/Dashboard-LRS/payroll-private.html#access_token=fixture-access&refresh_token=fixture-refresh&token_type=bearer&type=invite&expires_in=3600`,
    ({ location, events }) => ({
      setSession: async tokens => {
        locationAfterScrub = location.href;
        supplied = tokens;
        events.push("setSession");
        return { data: { session: { access_token: "fixture-access" } }, error: null };
      }
    })
  );

  const authOptions = harness.getSdkArgs()[2].auth;
  assert.notEqual(authOptions.storage, harness.runtime.sessionStorage);
  assert.equal(typeof authOptions.storage.getItem, "function");
  assert.deepEqual({ ...authOptions, storage: "adapter" }, {
    storage: "adapter",
    storageKey: "lrs.private.auth.session",
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    flowType: "pkce"
  });
  assert.deepEqual(supplied, { access_token: "fixture-access", refresh_token: "fixture-refresh" });
  assert.equal(locationAfterScrub, `${origin}/Dashboard-LRS/payroll-private.html`);
  assert.deepEqual(harness.events, ["scrub", "setSession"]);
  assert.deepEqual(harness.runtime.authCallback, { status: "success", flow: "invite" });
  assert.equal(JSON.stringify(harness.runtime.authCallback).includes("fixture-access"), false);
});

test("invite token-hash callback uses verifyOtp after removing credentials from the URL", async () => {
  let supplied;
  const harness = await makeRuntime(
    `${origin}/Dashboard-LRS/payroll-private.html?token_hash=fixture-hash&type=invite`,
    ({ location, events }) => ({
      verifyOtp: async input => {
        assert.equal(location.href, `${origin}/Dashboard-LRS/payroll-private.html`);
        events.push("verifyOtp");
        supplied = input;
        return { data: { session: { access_token: "fixture-access" } }, error: null };
      }
    })
  );

  assert.deepEqual(supplied, { token_hash: "fixture-hash", type: "invite" });
  assert.deepEqual(harness.events, ["scrub", "verifyOtp"]);
  assert.deepEqual(harness.runtime.authCallback, { status: "success", flow: "invite-token-hash" });
});

test("ordinary PKCE magic-link callback still exchanges its code and cleans the URL first", async () => {
  let exchanged;
  const harness = await makeRuntime(
    `${origin}/Dashboard-LRS/payroll-private.html?code=fixture-code`,
    ({ location, events }) => ({
      exchangeCodeForSession: async code => {
        assert.equal(location.href, `${origin}/Dashboard-LRS/payroll-private.html`);
        events.push("exchangeCodeForSession");
        exchanged = code;
        return { data: { session: { access_token: "fixture-access" } }, error: null };
      }
    })
  );

  assert.equal(exchanged, "fixture-code");
  assert.deepEqual(harness.events, ["scrub", "exchangeCodeForSession"]);
  assert.deepEqual(harness.runtime.authCallback, { status: "success", flow: "pkce" });
});

test("invite-style code without a PKCE verifier remains signed out and is removed from history", async () => {
  let setSessionCalled = false;
  const harness = await makeRuntime(
    `${origin}/Dashboard-LRS/payroll-private.html?code=orphan-invite-code&type=invite`,
    ({ location, events }) => ({
      exchangeCodeForSession: async () => {
        assert.equal(location.href, `${origin}/Dashboard-LRS/payroll-private.html`);
        events.push("exchangeCodeForSession");
        return { data: { session: null }, error: new Error("missing verifier") };
      },
      setSession: async () => { setSessionCalled = true; return { data: { session: {} }, error: null }; }
    })
  );

  assert.deepEqual(harness.events, ["scrub", "exchangeCodeForSession"]);
  assert.equal(setSessionCalled, false);
  assert.deepEqual(harness.runtime.authCallback, { status: "error", flow: "pkce" });
  assert.equal(JSON.stringify(harness.runtime.authCallback).includes("orphan-invite-code"), false);
});

test("unsupported implicit callback is scrubbed and never creates a session", async () => {
  let accepted = false;
  const harness = await makeRuntime(
    `${origin}/Dashboard-LRS/payroll-private.html#access_token=fixture-access&refresh_token=fixture-refresh&type=email`,
    () => ({ setSession: async () => { accepted = true; return { data: {}, error: null }; } })
  );

  assert.equal(accepted, false);
  assert.equal(harness.location.href, `${origin}/Dashboard-LRS/payroll-private.html`);
  assert.deepEqual(harness.runtime.authCallback, { status: "error", flow: "unsupported" });
});

test("normal page load leaves its URL alone and does not call Auth callback methods", async () => {
  let called = false;
  const href = `${origin}/Dashboard-LRS/payroll-private.html`;
  const harness = await makeRuntime(href, () => ({
    setSession: async () => { called = true; },
    exchangeCodeForSession: async () => { called = true; },
    verifyOtp: async () => { called = true; }
  }));

  assert.equal(harness.location.href, href);
  assert.deepEqual(harness.events, []);
  assert.deepEqual(harness.runtime.authCallback, { status: "none", flow: null });
  assert.equal(called, false);
});

