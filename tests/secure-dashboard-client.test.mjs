import test from "node:test";
import assert from "node:assert/strict";
import { createSecureDashboardClient } from "../secure-dashboard-client.mjs";

const config = { enabled: true, supabaseUrl: "https://project.example", publishableKey: "fixture-key", allowedOrigin: "https://dashboard.example" };
const fixture = { schema: 1, readAt: "2026-10-29T16:00:00.000Z", rows: [], tabCells: [] };
function authClient(session = { access_token: "fixture-session" }) {
  const callbacks = [];
  return {
    callbacks,
    auth: {
      async getSession() { return { data: { session }, error: null }; },
      onAuthStateChange(callback) { callbacks.push(callback); return { data: { subscription: { unsubscribe() {} } } }; },
      async signInWithOAuth(options) { this.oauthOptions = options; return { error: null }; },
      async signOut() { return { error: null }; }
    }
  };
}
const ok = payload => ({ ok: true, status: 200, json: async () => payload });

test("secure dashboard clears legacy row caches and requests only the private dashboard endpoint", async () => {
  const auth = authClient(), removed = [], states = [], requests = [];
  const client = createSecureDashboardClient({ config, authClient: auth, getOrigin: () => config.allowedOrigin, storage: { removeItem(key) { removed.push(key); } }, onState: state => states.push(state.status), fetcher: async (url, init) => { requests.push({ url, init }); return ok(fixture); } });
  const state = await client.start();
  assert.equal(state.status, "ready");
  assert.deepEqual(state.dataset.rows, []);
  assert.deepEqual([...new Set(removed)].sort(), ["opsdash3:data", "opsdash3:tab"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.cache, "no-store");
  assert.deepEqual(JSON.parse(requests[0].init.body), { action: "dashboard.read" });
  assert.ok(states.includes("loading"));
});

test("dashboard client refuses the wrong origin and never falls back to public feeds", async () => {
  let calls = 0;
  const auth = authClient();
  const client = createSecureDashboardClient({ config, authClient: auth, getOrigin: () => "https://other.example", storage: null, fetcher: async () => { calls++; return ok(fixture); } });
  const state = await client.start();
  assert.equal(state.status, "unconfigured");
  assert.equal(calls, 0);
  assert.equal(await client.signIn().then(result => result.status), "unconfigured");
});

test("dashboard client clears data on sign-out and rejects late results after the session ends", async () => {
  const auth = authClient(), removed = [];
  let release;
  const client = createSecureDashboardClient({ config, authClient: auth, getOrigin: () => config.allowedOrigin, storage: { removeItem(key) { removed.push(key); } }, fetcher: () => new Promise(resolve => { release = () => resolve(ok(fixture)); }) });
  const pending = client.start();
  await new Promise(resolve => setImmediate(resolve));
  const signedOut = await client.signOut();
  release();
  const late = await pending;
  assert.equal(signedOut.status, "signed_out");
  assert.equal(late.status, "signed_out");
  assert.equal(late.dataset, null);
  assert.ok(removed.length >= 2);
});

test("dashboard session lease expires and signs out without restoring a cached dashboard", async () => {
  let now = 100_000, timer;
  const values = new Map();
  const sessionStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const auth = authClient(), removed = [];
  const client = createSecureDashboardClient({ config, authClient: auth, sessionStorage, getOrigin: () => config.allowedOrigin,
    storage: { removeItem(key) { removed.push(key); } }, now: () => now, maxSessionAgeMs: 400,
    schedule: (callback, delay) => { timer = { callback, delay }; return timer; }, cancel: () => {}, fetcher: async () => ok(fixture) });
  assert.equal((await client.start()).status, "ready");
  assert.equal(timer.delay, 400);
  now += 400;
  timer.callback();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.getState().status, "signed_out");
  assert.equal(client.getState().dataset, null);
  assert.match(client.getState().message, /sesión privada expiró/i);
  assert.equal(values.get("lrs.private.session.started-at"), undefined);
  assert.deepEqual([...new Set(removed)].sort(), ["opsdash3:data", "opsdash3:tab"]);
});
