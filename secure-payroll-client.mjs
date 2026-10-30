import { createPrivateSessionLease, MAX_PRIVATE_SESSION_AGE_MS } from "./session-lease.mjs";

export const LEGACY_PAYROLL_CACHE_KEYS = Object.freeze(["opsdash3:data", "opsdash3:tab"]);

const MESSAGES = Object.freeze({
  unconfigured: "El acceso privado aún no está configurado. Esta vista no consulta fuentes públicas ni usa datos guardados.",
  signed_out: "Inicia sesión para validar tu acceso a Nómina.",
  session_expired: "La sesión privada expiró. Inicia sesión de nuevo.",
  authorizing: "Solicitando un enlace seguro…",
  email_sent: "Si esta cuenta ya está habilitada, recibirás un enlace de acceso. Revisa tu correo de trabajo.",
  email_error: "No se pudo solicitar el acceso. Verifica la dirección e inténtalo de nuevo más tarde.",
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

function browserSessionStorage() {
  try { return globalThis.sessionStorage; } catch (_) { return null; }
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

export function createSecurePayrollClient({ config, authClient, fetcher, storage = globalThis.localStorage, sessionStorage = browserSessionStorage(),
  maxSessionAgeMs = MAX_PRIVATE_SESSION_AGE_MS, now = () => Date.now(), schedule, cancel, onState = () => {} } = {}) {
  let state = { status: "unconfigured", message: MESSAGES.unconfigured, rows: null, readAt: null };
  let authSubscription = null;
  let requestVersion = 0;
  let emailRequestInFlight = false;
  let validated = validatePrivateRuntime(config, authClient);
  let expiredNotice = false;
  let expireSession = async () => {};
  const sessionLease = createPrivateSessionLease({ storage: sessionStorage, now, schedule, cancel, maxAgeMs: maxSessionAgeMs, onExpire: () => { void expireSession(); } });

  function publish(status, values = {}) {
    state = { status, message: MESSAGES[status] || MESSAGES.error, rows: null, readAt: null, ...values };
    onState(state);
    return state;
  }

  async function loadSession(session, event = "INITIAL_SESSION") {
    const version = ++requestVersion;
    clearLegacyPayrollCache(storage);
    if (!session?.access_token) {
      sessionLease.stop();
      return publish("signed_out", expiredNotice ? { message: MESSAGES.session_expired } : {});
    }
    if (event === "SIGNED_IN") expiredNotice = false;
    const lease = sessionLease.begin({ newAuthentication: event === "SIGNED_IN" });
    if (!lease.ok) {
      if (lease.reason === "session_expired") return expireSession();
      return publish("error", { message: "No se pudo iniciar una sesión privada temporal. Vuelve a cargar la página." });
    }
    publish("loading");
    const result = await readPrivatePayroll({
      endpoint: validated.endpoint,
      publishableKey: config.publishableKey,
      accessToken: session.access_token,
      fetcher
    });
    if (version !== requestVersion) return state;
    if (result.state === "signed_out") return expireSession();
    return publish(result.state, { rows: result.rows, readAt: result.readAt || null });
  }

  expireSession = async () => {
    expiredNotice = true;
    requestVersion++;
    sessionLease.stop();
    clearLegacyPayrollCache(storage);
    try { await authClient?.auth?.signOut?.(); } catch (_) { /* Local view stays cleared even if remote logout is unavailable. */ }
    requestVersion++;
    clearLegacyPayrollCache(storage);
    return publish("signed_out", { message: MESSAGES.session_expired });
  };

  async function start() {
    clearLegacyPayrollCache(storage);
    validated = validatePrivateRuntime(config, authClient);
    if (!validated.ok) return publish("unconfigured");

    if (!authSubscription && typeof authClient.auth.onAuthStateChange === "function") {
      const subscriptionResult = authClient.auth.onAuthStateChange((event, session) => {
        void loadSession(session, event);
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

  async function requestEmailLink(email) {
    if (emailRequestInFlight) return state;
    clearLegacyPayrollCache(storage);
    expiredNotice = false;
    sessionLease.stop();
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return publish("email_error");
    }
    if (!validated.ok || typeof authClient.auth.signInWithOtp !== "function") return publish("unconfigured");
    const origin = globalThis.location?.origin;
    if (origin !== config.allowedOrigin) return publish("unconfigured");
    let emailRedirectTo;
    try {
      const redirect = new URL(globalThis.location.href);
      if (redirect.origin !== config.allowedOrigin) return publish("unconfigured");
      redirect.search = "";
      redirect.hash = "";
      emailRedirectTo = redirect.href;
    } catch (_) { return publish("unconfigured"); }
    emailRequestInFlight = true;
    publish("authorizing");
    try {
      const { error } = await authClient.auth.signInWithOtp({
        email: normalizedEmail,
        options: { shouldCreateUser: false, emailRedirectTo }
      });
      if (error) return publish("email_error");
      return publish("email_sent");
    } catch (_) {
      return publish("email_error");
    } finally {
      emailRequestInFlight = false;
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
    expiredNotice = false;
    sessionLease.stop();
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
      sessionLease.stop();
      clearLegacyPayrollCache(storage);
      if (state.status === "signing_out") publish("signed_out");
    }
    return state;
  }

  function dispose() {
    requestVersion++;
    sessionLease.stop();
    authSubscription?.unsubscribe?.();
    authSubscription = null;
    clearLegacyPayrollCache(storage);
    state = { status: "signed_out", message: MESSAGES.signed_out, rows: null, readAt: null };
  }

  return { start, requestEmailLink, refresh, signOut, dispose, getState: () => state };
}
