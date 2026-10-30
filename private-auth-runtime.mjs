const STORAGE_KEY = "lrs.private.auth.session";
const CODE_VERIFIER_TTL_MS = 10 * 60 * 1000;
const CALLBACK_KEYS = Object.freeze([
  "access_token", "code", "error", "error_code", "error_description", "refresh_token", "token_hash", "type"
]);

function browserSessionStorage() {
  try { return globalThis.sessionStorage; } catch (_) { return null; }
}

function browserVerifierStorage() {
  try { return globalThis.localStorage; } catch (_) { return null; }
}

/**
 * Supabase PKCE callbacks commonly open in a new tab from the email client.
 * Share only the short-lived code verifier across same-origin tabs; keep the
 * actual access/refresh-token session in per-tab sessionStorage.
 */
export function createPrivateAuthStorage({ sessionStorage, verifierStorage, now = () => Date.now(),
  storageKey = STORAGE_KEY, verifierTtlMs = CODE_VERIFIER_TTL_MS } = {}) {
  const verifierKey = `${storageKey}-code-verifier`;
  const isVerifierKey = key => key === verifierKey;
  return Object.freeze({
    getItem(key) {
      if (!isVerifierKey(key)) return sessionStorage?.getItem?.(key) ?? null;
      let raw;
      try { raw = verifierStorage?.getItem?.(key); } catch (_) { return null; }
      if (raw == null) return null;
      try {
        const entry = JSON.parse(raw);
        const age = now() - entry?.storedAt;
        if (entry?.version === 1 && typeof entry.value === "string" && entry.value &&
            Number.isFinite(entry.storedAt) && age >= 0 && age <= verifierTtlMs) return entry.value;
      } catch (_) { /* Invalid or legacy verifier records are discarded below. */ }
      try { verifierStorage?.removeItem?.(key); } catch (_) { /* Expired records must never be used. */ }
      return null;
    },
    setItem(key, value) {
      if (!isVerifierKey(key)) return sessionStorage?.setItem?.(key, value);
      const storedAt = now();
      if (typeof value !== "string" || !value || !Number.isFinite(storedAt)) throw new TypeError("invalid_code_verifier");
      const entry = JSON.stringify({ version: 1, storedAt, value });
      verifierStorage?.setItem?.(key, entry);
      if (verifierStorage?.getItem?.(key) !== entry) throw new Error("code_verifier_storage_unavailable");
    },
    removeItem(key) {
      if (!isVerifierKey(key)) return sessionStorage?.removeItem?.(key);
      return verifierStorage?.removeItem?.(key);
    }
  });
}

function disabled(reason) {
  return Object.freeze({ config: { enabled: false }, authClient: null, sessionStorage: null, reason });
}

/**
 * Consume the Supabase Auth callback before the page starts loading private data.
 * Email invitations use a one-time implicit session by default, while sign-in
 * links initiated by this page use PKCE. Credentials are removed from the URL
 * before any Auth exchange and never included in the returned status.
 */
export async function consumePrivateAuthCallback(auth, {
  locationObject = globalThis.location,
  historyObject = globalThis.history
} = {}) {
  if (!auth || !locationObject?.href) return Object.freeze({ status: "none", flow: null });

  let url;
  try { url = new URL(locationObject.href); } catch (_) { return Object.freeze({ status: "none", flow: null }); }
  const query = url.searchParams;
  const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const has = key => query.has(key) || fragment.has(key);
  const get = key => query.get(key) ?? fragment.get(key);
  if (!CALLBACK_KEYS.some(has)) return Object.freeze({ status: "none", flow: null });

  // Never process a callback while its credentials remain in the address bar.
  if (!historyObject || typeof historyObject.replaceState !== "function") {
    return Object.freeze({ status: "error", flow: "unsupported" });
  }
  try {
    historyObject.replaceState(historyObject.state ?? null, "", `${url.origin}${url.pathname}`);
  } catch (_) {
    return Object.freeze({ status: "error", flow: "unsupported" });
  }

  if (get("error") || get("error_code") || get("error_description")) {
    return Object.freeze({ status: "error", flow: "auth-error" });
  }

  try {
    const code = get("code");
    if (code) {
      if (typeof auth.exchangeCodeForSession !== "function") return Object.freeze({ status: "error", flow: "pkce" });
      const result = await auth.exchangeCodeForSession(code);
      return Object.freeze({ status: result?.error || !result?.data?.session ? "error" : "success", flow: "pkce" });
    }

    const type = get("type");
    const tokenHash = get("token_hash");
    if (type === "invite" && tokenHash) {
      if (typeof auth.verifyOtp !== "function") return Object.freeze({ status: "error", flow: "invite-token-hash" });
      const result = await auth.verifyOtp({ token_hash: tokenHash, type: "invite" });
      return Object.freeze({ status: result?.error || !result?.data?.session ? "error" : "success", flow: "invite-token-hash" });
    }

    const accessToken = get("access_token");
    const refreshToken = get("refresh_token");
    if (type === "invite" && accessToken && refreshToken) {
      if (typeof auth.setSession !== "function") return Object.freeze({ status: "error", flow: "invite" });
      const result = await auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      return Object.freeze({ status: result?.error || !result?.data?.session ? "error" : "success", flow: "invite" });
    }
  } catch (_) {
    return Object.freeze({ status: "error", flow: get("type") === "invite" ? "invite" : "pkce" });
  }

  return Object.freeze({ status: "error", flow: "unsupported" });
}

export function isSupabasePublishableKey(value) {
  if (typeof value !== "string" || value.length < 20 || value.length > 4096 || /\s/.test(value)) return false;
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(value)) return true;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(globalThis.atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload?.role === "anon";
  } catch (_) { return false; }
}

/**
 * Builds Supabase Auth with per-tab session storage. The caller supplies the
 * SDK factory and private runtime configuration at deployment time; neither
 * is embedded in this source tree. No localStorage or service-role key is used.
 */
export function createPrivateAuthRuntime(input = {}, { getOrigin = () => globalThis.location?.origin } = {}) {
  const config = input?.config;
  const createClient = input?.createClient;
  const storage = input && Object.hasOwn(input, "sessionStorage") ? input.sessionStorage : browserSessionStorage();
  const verifierStorage = input && Object.hasOwn(input, "verifierStorage") ? input.verifierStorage : browserVerifierStorage();
  if (!config || config.enabled !== true) return disabled("unconfigured");
  if (typeof config.supabaseUrl !== "string" || !isSupabasePublishableKey(config.publishableKey) ||
      typeof config.allowedOrigin !== "string" || !/^https:\/\//.test(config.allowedOrigin)) return disabled("runtime_config_invalid");
  try {
    const url = new URL(config.supabaseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return disabled("runtime_config_invalid");
  } catch (_) { return disabled("runtime_config_invalid"); }
  if (getOrigin() !== config.allowedOrigin) return disabled("origin_not_allowed");
  if (typeof createClient !== "function") return disabled("auth_sdk_unavailable");
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function" || typeof storage.removeItem !== "function") return disabled("session_storage_unavailable");
  if (!verifierStorage || typeof verifierStorage.getItem !== "function" || typeof verifierStorage.setItem !== "function" || typeof verifierStorage.removeItem !== "function") return disabled("pkce_storage_unavailable");
  try {
    const authClient = createClient(config.supabaseUrl, config.publishableKey, {
      auth: {
        storage: createPrivateAuthStorage({ sessionStorage: storage, verifierStorage }),
        storageKey: STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        flowType: "pkce"
      }
    });
    if (!authClient?.auth) return disabled("auth_client_invalid");
    return Object.freeze({ config, authClient, sessionStorage: storage, reason: null });
  } catch (_) { return disabled("auth_client_invalid"); }
}

export const PRIVATE_AUTH_STORAGE_KEY = STORAGE_KEY;
