export const LEGACY_PAYROLL_CACHE_KEYS = Object.freeze(["opsdash3:data", "opsdash3:tab"]);

const MESSAGES = Object.freeze({
  unconfigured: "El acceso privado aún no está configurado. Esta vista no consulta fuentes públicas ni usa datos guardados.",
  signed_out: "Inicia sesión para validar tu acceso a Nómina.",
  authorizing: "Abriendo el inicio de sesión seguro…",
  loading: "Consultando la hoja con tu sesión autorizada…",
  ready: "Datos actualizados desde la hoja.",
  denied: "Tu cuenta no tiene acceso a Nómina. Contacta a una persona administradora.",
  unavailable: "El servicio privado no está disponible. No se mostraron datos anteriores.",
  error: "No se pudo actualizar Nómina. No se mostraron datos anteriores.",
  signing_out: "Cerrando sesión…"
});

export function clearLegacyPayrollCache(storage) {
  if (!storage) {
    try { storage = globalThis.localStorage; } catch (_) { return; }
  }
  if (!storage) return;
  for (const key of LEGACY_PAYROLL_CACHE_KEYS) {
    try { storage.removeItem(key); } catch (_) { /* Storage can be disabled by browser policy. */ }
  }
}

export function validatePrivateRuntime(config, authClient) {
  if (!config || config.enabled !== true || !authClient?.auth) {
    return { ok: false, reason: "unconfigured" };
  }
  if (typeof config.supabaseUrl !== "string" || typeof config.publishableKey !== "string" || !config.publishableKey.trim()) {
    return { ok: false, reason: "unconfigured" };
  }
  let url;
  try { url = new URL(config.supabaseUrl); } catch { return { ok: false, reason: "unconfigured" }; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    return { ok: false, reason: "unconfigured" };
  }
  if (typeof config.allowedOrigin !== "string" || !/^https:\/\//.test(config.allowedOrigin)) {
    return { ok: false, reason: "unconfigured" };
  }
  return { ok: true, endpoint: `${url.origin}/functions/v1/payroll-api` };
}

export async function readPrivatePayroll({ endpoint, publishableKey, accessToken, fetcher = globalThis.fetch }) {
  if (!endpoint || !publishableKey || !accessToken || typeof fetcher !== "function") {
    return { state: "unconfigured", rows: null };
  }
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: {
        apikey: publishableKey,
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ action: "payroll.read" })
    });
    if (response.status === 401) return { state: "signed_out", rows: null };
    if (response.status === 403) return { state: "denied", rows: null };
    if (response.status === 503) return { state: "unavailable", rows: null };
    if (!response.ok) return { state: "error", rows: null };
    const payload = await response.json();
    if (!payload || payload.schema !== 1 || !Array.isArray(payload.rows)) return { state: "error", rows: null };
    return { state: "ready", rows: payload.rows, readAt: payload.readAt || null };
  } catch (_) {
    return { state: "error", rows: null };
  }
}

export function createSecurePayrollClient({ config, authClient, fetcher, storage = globalThis.localStorage, onState = () => {} } = {}) {
  let state = { status: "unconfigured", message: MESSAGES.unconfigured, rows: null, readAt: null };
  let authSubscription = null;
  let requestVersion = 0;
  let validated = validatePrivateRuntime(config, authClient);

  function publish(status, values = {}) {
    state = { status, message: MESSAGES[status] || MESSAGES.error, rows: null, readAt: null, ...values };
    onState(state);
    return state;
  }

  async function loadSession(session) {
    const version = ++requestVersion;
    clearLegacyPayrollCache(storage);
    if (!session?.access_token) return publish("signed_out");
    publish("loading");
    const result = await readPrivatePayroll({
      endpoint: validated.endpoint,
      publishableKey: config.publishableKey,
      accessToken: session.access_token,
      fetcher
    });
    if (version !== requestVersion) return state;
    return publish(result.state, { rows: result.rows, readAt: result.readAt || null });
  }

  async function start() {
    clearLegacyPayrollCache(storage);
    validated = validatePrivateRuntime(config, authClient);
    if (!validated.ok) return publish("unconfigured");

    if (!authSubscription && typeof authClient.auth.onAuthStateChange === "function") {
      const subscriptionResult = authClient.auth.onAuthStateChange((_event, session) => {
        void loadSession(session);
      });
      authSubscription = subscriptionResult?.data?.subscription || subscriptionResult?.subscription || null;
    }

    if (typeof authClient.auth.getSession !== "function") return publish("unconfigured");
    try {
      const { data, error } = await authClient.auth.getSession();
      if (error) return publish("error");
      return loadSession(data?.session || null);
    } catch (_) {
      return publish("error");
    }
  }

  async function signIn() {
    clearLegacyPayrollCache(storage);
    if (!validated.ok || typeof authClient.auth.signInWithOAuth !== "function") return publish("unconfigured");
    const origin = globalThis.location?.origin;
    if (origin !== config.allowedOrigin) return publish("unconfigured");
    publish("authorizing");
    try {
      const { error } = await authClient.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: globalThis.location.href,
          scopes: "openid email",
          queryParams: { prompt: "select_account" }
        }
      });
      if (error) return publish("error");
      return state;
    } catch (_) {
      return publish("error");
    }
  }

  async function refresh() {
    clearLegacyPayrollCache(storage);
    if (!validated.ok) return publish("unconfigured");
    if (typeof authClient.auth.getSession !== "function") return publish("unconfigured");
    try {
      const { data, error } = await authClient.auth.getSession();
      if (error) return publish("error");
      return loadSession(data?.session || null);
    } catch (_) {
      return publish("error");
    }
  }

  async function signOut() {
    requestVersion++;
    clearLegacyPayrollCache(storage);
    publish("signing_out");
    try {
      if (typeof authClient?.auth?.signOut === "function") {
        const { error } = await authClient.auth.signOut();
        if (error) {
          clearLegacyPayrollCache(storage);
          return publish("error");
        }
      }
    } catch (_) {
      clearLegacyPayrollCache(storage);
      return publish("error");
    } finally {
      requestVersion++;
      clearLegacyPayrollCache(storage);
      if (state.status === "signing_out") publish("signed_out");
    }
    return state;
  }

  function dispose() {
    requestVersion++;
    authSubscription?.unsubscribe?.();
    authSubscription = null;
    clearLegacyPayrollCache(storage);
    state = { status: "signed_out", message: MESSAGES.signed_out, rows: null, readAt: null };
  }

  return { start, signIn, refresh, signOut, dispose, getState: () => state };
}
