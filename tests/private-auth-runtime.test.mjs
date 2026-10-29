import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateAuthRuntime, PRIVATE_AUTH_STORAGE_KEY } from "../private-auth-runtime.mjs";

const config = { enabled: true, supabaseUrl: "https://project.example.supabase.co", publishableKey: "fixture-publishable-value", allowedOrigin: "https://lrs.example.test" };
function memoryStorage() { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; }

test("private Auth runtime constructs a PKCE session using only sessionStorage", () => {
  const storage = memoryStorage();
  let received;
  const authClient = { auth: {} };
  const result = createPrivateAuthRuntime({ config, sessionStorage: storage, createClient: (...args) => { received = args; return authClient; } }, { getOrigin: () => config.allowedOrigin });
  assert.equal(result.authClient, authClient);
  assert.equal(result.sessionStorage, storage);
  assert.equal(received[0], config.supabaseUrl);
  assert.equal(received[1], config.publishableKey);
  assert.deepEqual(received[2].auth, { storage, storageKey: PRIVATE_AUTH_STORAGE_KEY, persistSession: true,
    autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" });
});

test("private Auth runtime refuses a wrong origin or missing per-tab session storage", () => {
  let creates = 0;
  const input = { config, sessionStorage: memoryStorage(), createClient: () => { creates++; return { auth: {} }; } };
  assert.equal(createPrivateAuthRuntime(input, { getOrigin: () => "https://attacker.example" }).reason, "origin_not_allowed");
  assert.equal(createPrivateAuthRuntime({ ...input, sessionStorage: null }, { getOrigin: () => config.allowedOrigin }).reason, "session_storage_unavailable");
  assert.equal(creates, 0);
});

test("disabled and incomplete deployment configuration cannot create a client", () => {
  let creates = 0;
  const createClient = () => { creates++; return { auth: {} }; };
  assert.equal(createPrivateAuthRuntime({ config: { enabled: false }, createClient }).config.enabled, false);
  assert.equal(createPrivateAuthRuntime({ config, sessionStorage: memoryStorage() }, { getOrigin: () => config.allowedOrigin }).reason, "auth_sdk_unavailable");
  assert.equal(creates, 0);
});
