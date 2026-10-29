import test from "node:test";
import assert from "node:assert/strict";
import { createSecurePayrollClient, readPrivatePayroll } from "../secure-payroll-client.mjs";

const config = Object.freeze({
  enabled: true,
  supabaseUrl: "https://project.example.supabase.co",
  publishableKey: "fixture-publishable-value",
  allowedOrigin: "https://lrsbyor.github.io"
});

function memoryStorage(values = {}) {
  const map = new Map(Object.entries(values));
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    entries: () => [...map.entries()]
  };
}

function fakeAuth(session = null) {
  const listeners = new Set();
  const calls = { oauth: [], signOut: 0 };
  return {
    calls,
    emit(event, nextSession) { for (const listener of listeners) listener(event, nextSession); },
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange: listener => {
        listeners.add(listener);
        return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
      },
      signInWithOAuth: async options => { calls.oauth.push(options); return { data: {}, error: null }; },
      signOut: async () => { calls.signOut++; for (const listener of listeners) listener("SIGNED_OUT", null); return { error: null }; }
    }
  };
}

const okResponse = (payload, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => payload });

test("missing runtime fails closed and removes only old payroll snapshots", async () => {
  const storage = memoryStorage({ "opsdash3:data": "old rows", "opsdash3:tab": "old prices", "opsdash3:theme": "dark" });
  const auth = fakeAuth({ access_token: "synthetic-token" });
  let fetches = 0;
  const client = createSecurePayrollClient({ authClient: auth, fetcher: async () => { fetches++; }, storage });
  const result = await client.start();
  assert.equal(result.status, "unconfigured");
  assert.equal(result.rows, null);
  assert.equal(fetches, 0);
  assert.equal(storage.getItem("opsdash3:data"), null);
  assert.equal(storage.getItem("opsdash3:tab"), null);
  assert.equal(storage.getItem("opsdash3:theme"), "dark");
});

test("signed-out user sees no stale data and the endpoint is not called", async () => {
  const storage = memoryStorage({ "opsdash3:data": "stale" });
  const auth = fakeAuth(null);
  let fetches = 0;
  const client = createSecurePayrollClient({ config, authClient: auth, fetcher: async () => { fetches++; }, storage });
  const result = await client.start();
  assert.equal(result.status, "signed_out");
  assert.equal(result.rows, null);
  assert.equal(fetches, 0);
  assert.equal(storage.getItem("opsdash3:data"), null);
});

test("private read sends only a fresh no-store authenticated request", async () => {
  const auth = fakeAuth({ access_token: "signed-user-token" });
  const rows = [{ date: "2026-10-07", tp: "Synthetic Tech", amountTP: 100 }];
  const requests = [];
  const client = createSecurePayrollClient({
    config, authClient: auth, storage: memoryStorage(),
    fetcher: async (url, options) => { requests.push({ url, options }); return okResponse({ schema: 1, readAt: "2026-10-29T12:00:00Z", rows }); }
  });
  const state = await client.start();
  assert.equal(state.status, "ready");
  assert.deepEqual(state.rows, rows);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://project.example.supabase.co/functions/v1/payroll-api");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.cache, "no-store");
  assert.equal(requests[0].options.credentials, "omit");
  assert.equal(requests[0].options.headers.authorization, "Bearer signed-user-token");
  assert.equal(requests[0].options.headers.apikey, config.publishableKey);
  assert.deepEqual(JSON.parse(requests[0].options.body), { action: "payroll.read" });
});

test("authorization denial clears the view and never falls back to public feeds", async () => {
  const auth = fakeAuth({ access_token: "signed-user-token" });
  let calls = 0;
  const client = createSecurePayrollClient({
    config, authClient: auth, storage: memoryStorage(),
    fetcher: async () => { calls++; return okResponse({ error: "not_authorized" }, 403); }
  });
  const state = await client.start();
  assert.equal(calls, 1);
  assert.equal(state.status, "denied");
  assert.equal(state.rows, null);
});

test("expired sessions and unavailable services expose no cached rows", async () => {
  for (const [status, expected] of [[401, "signed_out"], [503, "unavailable"], [500, "error"]]) {
    const client = createSecurePayrollClient({
      config, authClient: fakeAuth({ access_token: "signed-user-token" }), storage: memoryStorage(),
      fetcher: async () => okResponse({}, status)
    });
    const state = await client.start();
    assert.equal(state.status, expected);
    assert.equal(state.rows, null);
  }
});

test("malformed API responses fail closed", async () => {
  const result = await readPrivatePayroll({
    endpoint: "https://project.example.supabase.co/functions/v1/payroll-api",
    publishableKey: config.publishableKey,
    accessToken: "signed-user-token",
    fetcher: async () => okResponse({ schema: 99, rows: [{ secret: "should not render" }] })
  });
  assert.deepEqual(result, { state: "error", rows: null });
});

test("Google sign-in starts only on the configured origin", async () => {
  const previousLocation = globalThis.location;
  globalThis.location = { origin: "https://lrsbyor.github.io", href: "https://lrsbyor.github.io/payroll-private.html" };
  try {
    const auth = fakeAuth(null);
    const client = createSecurePayrollClient({ config, authClient: auth, storage: memoryStorage() });
    await client.start();
    const result = await client.signIn();
    assert.equal(result.status, "authorizing");
    assert.equal(auth.calls.oauth.length, 1);
    assert.equal(auth.calls.oauth[0].provider, "google");
    assert.equal(auth.calls.oauth[0].options.redirectTo, globalThis.location.href);
    assert.equal(auth.calls.oauth[0].options.scopes, "openid email");
  } finally {
    if (typeof previousLocation === "undefined") delete globalThis.location;
    else globalThis.location = previousLocation;
  }
});

test("unauthorized origin cannot initiate Google sign-in", async () => {
  const previousLocation = globalThis.location;
  globalThis.location = { origin: "https://attacker.example", href: "https://attacker.example/payroll-private.html" };
  try {
    const auth = fakeAuth(null);
    const client = createSecurePayrollClient({ config, authClient: auth, storage: memoryStorage() });
    await client.start();
    const result = await client.signIn();
    assert.equal(result.status, "unconfigured");
    assert.equal(auth.calls.oauth.length, 0);
  } finally {
    if (typeof previousLocation === "undefined") delete globalThis.location;
    else globalThis.location = previousLocation;
  }
});

test("sign-out clears in-memory rows and legacy payroll snapshots", async () => {
  const storage = memoryStorage({ "opsdash3:data": "stale", "opsdash3:tab": "stale", "opsdash3:theme": "light" });
  const auth = fakeAuth({ access_token: "signed-user-token" });
  const client = createSecurePayrollClient({
    config, authClient: auth, storage,
    fetcher: async () => okResponse({ schema: 1, rows: [{ date: "2026-10-07", tp: "Synthetic Tech", amountTP: 10 }] })
  });
  await client.start();
  const state = await client.signOut();
  assert.equal(state.status, "signed_out");
  assert.equal(state.rows, null);
  assert.equal(auth.calls.signOut, 1);
  assert.equal(storage.getItem("opsdash3:data"), null);
  assert.equal(storage.getItem("opsdash3:tab"), null);
  assert.equal(storage.getItem("opsdash3:theme"), "light");
});

test("a late response after sign-out cannot restore the old table", async () => {
  const auth = fakeAuth({ access_token: "signed-user-token" });
  let resolveFetch;
  const client = createSecurePayrollClient({
    config, authClient: auth, storage: memoryStorage(),
    fetcher: () => new Promise(resolve => { resolveFetch = resolve; })
  });
  const start = client.start();
  await new Promise(resolve => setImmediate(resolve));
  auth.emit("SIGNED_OUT", null);
  resolveFetch(okResponse({ schema: 1, rows: [{ date: "2026-10-07", tp: "Synthetic Tech", amountTP: 10 }] }));
  await start;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.getState().status, "signed_out");
  assert.equal(client.getState().rows, null);
});
