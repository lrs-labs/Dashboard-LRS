import { createPrivateAuthRuntime, isSupabasePublishableKey } from "./private-auth-runtime.mjs";

export const SUPABASE_BROWSER_SDK_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0";
const CONFIG_PATH = "/api/private-runtime-config";

function unavailable(reason) { return createPrivateAuthRuntime({ config: { enabled: false, reason } }); }

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

/** Fetch private deployment config at runtime; this source contains no project URL or key value. */
export async function loadPrivateAuthRuntime(options = {}) {
  const { fetcher = globalThis.fetch?.bind(globalThis), loadSdk = loadSupabaseSdk,
    getOrigin = () => globalThis.location?.origin, sessionStorage } = options;
  const origin = getOrigin();
  if (typeof origin !== "string" || !/^https:\/\//.test(origin) || typeof fetcher !== "function" || typeof loadSdk !== "function") {
    return unavailable("runtime_config_unavailable");
  }
  try {
    const response = await fetcher(`${origin}${CONFIG_PATH}`, {
      method: "GET", mode: "same-origin", credentials: "omit", cache: "no-store", redirect: "error",
      referrerPolicy: "no-referrer", headers: { accept: "application/json" }
    });
    if (!response?.ok || (response.url && new URL(response.url).origin !== origin)) return unavailable("runtime_config_unavailable");
    const body = await response.json();
    if (!body || body.allowedOrigin !== origin || typeof body.supabaseUrl !== "string" ||
        typeof body.publishableKey !== "string" || !isSupabasePublishableKey(body.publishableKey)) {
      return unavailable("runtime_config_invalid");
    }
    const createClient = await loadSdk();
    const input = {
      config: { enabled: true, supabaseUrl: body.supabaseUrl, publishableKey: body.publishableKey, allowedOrigin: body.allowedOrigin },
      createClient
    };
    if (Object.hasOwn(options, "sessionStorage")) input.sessionStorage = sessionStorage;
    return createPrivateAuthRuntime(input, { getOrigin: () => origin });
  } catch (_) { return unavailable("runtime_config_unavailable"); }
}
