import test from "node:test";
import assert from "node:assert/strict";
import { consumePrivateAuthCallback, createPrivateAuthRuntime, createPrivateAuthStorage, PRIVATE_AUTH_STORAGE_KEY } from "../private-auth-runtime.mjs";

const config = { enabled: true, supabaseUrl: "https://project.example.supabase.co", publishableKey: "sb_publishable_fixture_value_that_is_not_a_real_key", allowedOrigin: "https://lrs.example.test" };
function memoryStorage() { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; }

test("private Auth runtime keeps the session per tab and shares only PKCE verifier storage", () => {
  const storage = memoryStorage();
  const verifierStorage = memoryStorage();
  let received;
  const authClient = { auth: {} };
  const result = createPrivateAuthRuntime({ config, sessionStorage: storage, verifierStorage,
    createClient: (...args) => { received = args; return authClient; } }, { getOrigin: () => config.allowedOrigin });
  assert.equal(result.authClient, authClient);
  assert.equal(result.sessionStorage, storage);
  assert.equal(received[0], config.supabaseUrl);
  assert.equal(received[1], config.publishableKey);
  assert.deepEqual({ ...received[2].auth, storage: "adapter" }, { storage: "adapter", storageKey: PRIVATE_AUTH_STORAGE_KEY, persistSession: true,
    autoRefreshToken: true, detectSessionInUrl: false, flowType: "pkce" });
});

test("private Auth runtime refuses a wrong origin or missing per-tab session storage", () => {
  let creates = 0;
  const input = { config, sessionStorage: memoryStorage(), verifierStorage: memoryStorage(), createClient: () => { creates++; return { auth: {} }; } };
  assert.equal(createPrivateAuthRuntime(input, { getOrigin: () => "https://attacker.example" }).reason, "origin_not_allowed");
  assert.equal(createPrivateAuthRuntime({ ...input, sessionStorage: null }, { getOrigin: () => config.allowedOrigin }).reason, "session_storage_unavailable");
  assert.equal(createPrivateAuthRuntime({ ...input, verifierStorage: null }, { getOrigin: () => config.allowedOrigin }).reason, "pkce_storage_unavailable");
  assert.equal(creates, 0);
});

test("disabled and incomplete deployment configuration cannot create a client", () => {
  let creates = 0;
  const createClient = () => { creates++; return { auth: {} }; };
  assert.equal(createPrivateAuthRuntime({ config: { enabled: false }, createClient }).config.enabled, false);
  assert.equal(createPrivateAuthRuntime({ config, sessionStorage: memoryStorage() }, { getOrigin: () => config.allowedOrigin }).reason, "auth_sdk_unavailable");
  assert.equal(creates, 0);
});

test("a verifier initiated in one tab is available to the callback tab, but session tokens stay isolated", () => {
  const sharedVerifierStorage = memoryStorage();
  const firstTabSession = memoryStorage();
  const callbackTabSession = memoryStorage();
  const verifierKey = `${PRIVATE_AUTH_STORAGE_KEY}-code-verifier`;
  const now = () => 1_800_000_000_000;
  const firstTabStorage = createPrivateAuthStorage({ sessionStorage: firstTabSession, verifierStorage: sharedVerifierStorage, now });
  const callbackTabStorage = createPrivateAuthStorage({ sessionStorage: callbackTabSession, verifierStorage: sharedVerifierStorage, now });

  firstTabStorage.setItem(verifierKey, "synthetic-one-time-verifier");
  firstTabStorage.setItem(PRIVATE_AUTH_STORAGE_KEY, "synthetic-session-not-shared");

  assert.equal(callbackTabStorage.getItem(verifierKey), "synthetic-one-time-verifier");
  assert.equal(callbackTabStorage.getItem(PRIVATE_AUTH_STORAGE_KEY), null);
  callbackTabStorage.removeItem(verifierKey);
  assert.equal(firstTabStorage.getItem(verifierKey), null);
});

test("expired or malformed cross-tab PKCE verifier entries are deleted and never returned", () => {
  const shared = memoryStorage();
  const session = memoryStorage();
  const verifierKey = `${PRIVATE_AUTH_STORAGE_KEY}-code-verifier`;
  let now = 1_800_000_000_000;
  const storage = createPrivateAuthStorage({ sessionStorage: session, verifierStorage: shared, now: () => now, verifierTtlMs: 600_000 });
  storage.setItem(verifierKey, "synthetic-verifier");
  now += 600_001;
  assert.equal(storage.getItem(verifierKey), null);
  assert.equal(shared.getItem(verifierKey), null);
  shared.setItem(verifierKey, "legacy-raw-value");
  assert.equal(storage.getItem(verifierKey), null);
  assert.equal(shared.getItem(verifierKey), null);
});

test("an emailed PKCE callback exchanges in its new tab after stripping the code from the URL", async () => {
  const sharedVerifierStorage = memoryStorage();
  const initiatingStorage = createPrivateAuthStorage({ sessionStorage: memoryStorage(), verifierStorage: sharedVerifierStorage });
  const callbackSessionStorage = memoryStorage();
  const callbackStorage = createPrivateAuthStorage({ sessionStorage: callbackSessionStorage, verifierStorage: sharedVerifierStorage });
  const verifierKey = `${PRIVATE_AUTH_STORAGE_KEY}-code-verifier`;
  initiatingStorage.setItem(verifierKey, "synthetic-cross-tab-verifier");
  let currentUrl = "https://lrs.example.test/payroll-private.html?code=synthetic-one-time-code";
  const auth = {
    exchangeCodeForSession: async code => {
      const verifier = callbackStorage.getItem(verifierKey);
      callbackStorage.removeItem(verifierKey);
      if (code !== "synthetic-one-time-code" || verifier !== "synthetic-cross-tab-verifier") return { error: new Error("invalid verifier"), data: null };
      callbackSessionStorage.setItem(PRIVATE_AUTH_STORAGE_KEY, "synthetic-session");
      return { error: null, data: { session: { access_token: "synthetic-token" } } };
    }
  };
  const result = await consumePrivateAuthCallback(auth, {
    locationObject: { href: currentUrl },
    historyObject: { state: null, replaceState: (_state, _title, url) => { currentUrl = url; } }
  });
  assert.deepEqual(result, { status: "success", flow: "pkce" });
  assert.equal(currentUrl, "https://lrs.example.test/payroll-private.html");
  assert.equal(callbackStorage.getItem(verifierKey), null);
  assert.equal(initiatingStorage.getItem(PRIVATE_AUTH_STORAGE_KEY), null);
  assert.equal(callbackSessionStorage.getItem(PRIVATE_AUTH_STORAGE_KEY), "synthetic-session");
});
