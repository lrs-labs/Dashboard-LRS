const STORAGE_KEY = "lrs.private.auth.session";

function browserSessionStorage() {
  try { return globalThis.sessionStorage; } catch (_) { return null; }
}

function disabled(reason) {
  return Object.freeze({ config: { enabled: false }, authClient: null, sessionStorage: null, reason });
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
  if (!config || config.enabled !== true) return disabled("unconfigured");
  if (typeof config.supabaseUrl !== "string" || typeof config.publishableKey !== "string" || !config.publishableKey.trim() ||
      typeof config.allowedOrigin !== "string" || !/^https:\/\//.test(config.allowedOrigin)) return disabled("runtime_config_invalid");
  try {
    const url = new URL(config.supabaseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return disabled("runtime_config_invalid");
  } catch (_) { return disabled("runtime_config_invalid"); }
  if (getOrigin() !== config.allowedOrigin) return disabled("origin_not_allowed");
  if (typeof createClient !== "function") return disabled("auth_sdk_unavailable");
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function" || typeof storage.removeItem !== "function") return disabled("session_storage_unavailable");
  try {
    const authClient = createClient(config.supabaseUrl, config.publishableKey, {
      auth: {
        storage,
        storageKey: STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: "pkce"
      }
    });
    if (!authClient?.auth) return disabled("auth_client_invalid");
    return Object.freeze({ config, authClient, sessionStorage: storage, reason: null });
  } catch (_) { return disabled("auth_client_invalid"); }
}

export const PRIVATE_AUTH_STORAGE_KEY = STORAGE_KEY;
