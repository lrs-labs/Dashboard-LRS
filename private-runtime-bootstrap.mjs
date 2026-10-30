import { consumePrivateAuthCallback, createPrivateAuthRuntime, isSupabasePublishableKey } from "./private-auth-runtime.mjs";

export const SUPABASE_BROWSER_SDK_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0";
const CONFIG_KEY = "LRS_PUBLIC_RUNTIME_CONFIG";
const CONFIG_FIELDS = Object.freeze(["allowedOrigin", "enabled", "publishableKey", "supabaseUrl"]);

function unavailable(reason) {
  const runtime = createPrivateAuthRuntime({ config: { enabled: false, reason } });
  return Object.freeze({ ...runtime, reason });
}

function isAllowedOrigin(value, pageOrigin) {
  if (typeof value !== "string" || value !== pageOrigin) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.origin === value && parsed.pathname === "/" && !parsed.search && !parsed.hash;
  } catch (_) { return false; }
}

function validateConfig(config, pageOrigin) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return "runtime_config_unavailable";
  if (config.enabled !== true) return "runtime_config_unavailable";
  const keys = Object.keys(config).sort();
  if (keys.length !== CONFIG_FIELDS.length || keys.some((key, index) => key !== CONFIG_FIELDS[index])) return "runtime_config_invalid";
  if (!isAllowedOrigin(config.allowedOrigin, pageOrigin) || !isSupabasePublishableKey(config.publishableKey)) return "runtime_config_invalid";
  if (typeof config.supabaseUrl !== "string") return "runtime_config_invalid";
  try {
    const url = new URL(config.supabaseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.origin !== config.supabaseUrl.replace(/\/$/, "")) {
      return "runtime_config_invalid";
    }
  } catch (_) { return "runtime_config_invalid"; }
  return null;
}

function loadSupabaseSdk({ documentObject = globalThis.document, globalObject = globalThis } = {}) {
  if (typeof globalObject.supabase?.createClient === "function") return Promise.resolve(globalObject.supabase.createClient);
  if (!documentObject?.createElement || !documentObject.head?.append) return Promise.reject(new Error("auth_sdk_unavailable"));
  return new Promise((resolve, reject) => {
    const script = documentObject.createElement("script");
    script.src = SUPABASE_BROWSER_SDK_URL;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.referrerPolicy = "no-referrer";
    script.onload = () => typeof globalObject.supabase?.createClient === "function"
      ? resolve(globalObject.supabase.createClient)
      : reject(new Error("auth_sdk_unavailable"));
    script.onerror = () => reject(new Error("auth_sdk_unavailable"));
    documentObject.head.append(script);
  });
}

/**
 * GitHub Pages cannot execute a server route. It receives only the Supabase
 * project URL and publishable browser key from a deployment-time injected
 * script. No config means no SDK initialization and no data requests.
 */
export async function loadPrivateAuthRuntime(options = {}) {
  const globalObject = options.globalObject || globalThis;
  const origin = (options.getOrigin || (() => globalObject.location?.origin))();
  if (typeof origin !== "string" || !/^https:\/\//.test(origin)) return unavailable("origin_not_allowed");

  const config = Object.hasOwn(options, "runtimeConfig")
    ? options.runtimeConfig
    : globalObject[CONFIG_KEY];
  const reason = validateConfig(config, origin);
  if (reason) return unavailable(reason);

  try {
    const createClient = await (options.loadSdk || (() => loadSupabaseSdk({ documentObject: options.documentObject, globalObject })))();
    const input = { config, createClient };
    if (Object.hasOwn(options, "sessionStorage")) input.sessionStorage = options.sessionStorage;
    if (Object.hasOwn(options, "verifierStorage")) input.verifierStorage = options.verifierStorage;
    const runtime = createPrivateAuthRuntime(input, { getOrigin: () => origin });
    if (!runtime.authClient) return runtime;
    const authCallback = await consumePrivateAuthCallback(runtime.authClient.auth, {
      locationObject: options.locationObject || globalObject.location,
      historyObject: options.historyObject || globalObject.history
    });
    return Object.freeze({ ...runtime, authCallback });
  } catch (_) {
    return unavailable("auth_sdk_unavailable");
  }
}
