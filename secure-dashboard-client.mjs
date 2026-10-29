import { clearLegacyPayrollCache, validatePrivateRuntime } from "./secure-payroll-client.mjs";
import { readPrivateDashboard } from "./secure-dashboard-adapter.mjs";
import { createPrivateSessionLease, MAX_PRIVATE_SESSION_AGE_MS } from "./session-lease.mjs";

const MESSAGES = Object.freeze({
  unconfigured: "La vista segura aún no está configurada para este dominio.",
  signed_out: "Inicia sesión para validar tu acceso al dashboard.",
  session_expired: "La sesión privada expiró. Inicia sesión de nuevo.",
  authorizing: "Abriendo el inicio de sesión seguro…",
  loading: "Consultando la hoja con tu sesión autorizada…",
  ready: "Datos actualizados desde la hoja.",
  denied: "Tu cuenta no tiene acceso a las secciones del dashboard.",
  unavailable: "El servicio privado no está disponible. No se mostraron datos anteriores.",
  error: "No se pudo actualizar. No se mostraron datos anteriores.",
  signing_out: "Cerrando sesión…"
});

function getStorage() {
  try { return globalThis.localStorage; } catch (_) { return null; }
}

function getSessionStorage() {
  try { return globalThis.sessionStorage; } catch (_) { return null; }
}

export function createSecureDashboardClient({ config, authClient, fetcher = globalThis.fetch, storage = getStorage(), sessionStorage = getSessionStorage(),
  getOrigin = () => globalThis.location?.origin, maxSessionAgeMs = MAX_PRIVATE_SESSION_AGE_MS, now = () => Date.now(), schedule, cancel, onState = () => {} } = {}) {
  let state = { status: "unconfigured", message: MESSAGES.unconfigured, dataset: null, readAt: null };
  let authSubscription = null;
  let requestVersion = 0;
  let validated = validatePrivateRuntime(config, authClient);
  let expiredNotice = false;
  let expireSession = async () => {};
  const sessionLease = createPrivateSessionLease({ storage: sessionStorage, now, schedule, cancel, maxAgeMs: maxSessionAgeMs, onExpire: () => { void expireSession(); } });

  function publish(status, values = {}) {
    state = { status, message: MESSAGES[status] || MESSAGES.error, dataset: null, readAt: null, ...values };
    onState(state);
    return state;
  }

  function clearOldData() { clearLegacyPayrollCache(storage); }

  function validateHost() {
    clearOldData();
    validated = validatePrivateRuntime(config, authClient);
    if (!validated.ok || getOrigin() !== config.allowedOrigin) return false;
    return true;
  }

  async function loadSession(session, event = "INITIAL_SESSION") {
    const version = ++requestVersion;
    clearOldData();
    if (!session?.access_token) {
      sessionLease.stop();
      return publish("signed_out", expiredNotice ? { message: MESSAGES.session_expired } : {});
    }
    if (!validateHost()) { sessionLease.stop(); return publish("unconfigured"); }
    if (event === "SIGNED_IN") expiredNotice = false;
    const lease = sessionLease.begin({ newAuthentication: event === "SIGNED_IN" });
    if (!lease.ok) {
      if (lease.reason === "session_expired") return expireSession();
      return publish("error", { message: "No se pudo iniciar una sesión privada temporal. Vuelve a cargar la página." });
    }
    publish("loading");
    const result = await readPrivateDashboard({
      endpoint: validated.endpoint,
      publishableKey: config.publishableKey,
      accessToken: session.access_token,
      fetcher
    });
    if (version !== requestVersion) return state;
    if (result.state === "signed_out") return expireSession();
    return publish(result.state, { dataset: result.dataset, readAt: result.dataset?.readAt || null });
  }

  expireSession = async () => {
    expiredNotice = true;
    requestVersion++;
    sessionLease.stop();
    clearOldData();
    try { await authClient?.auth?.signOut?.(); } catch (_) { /* Local data remains cleared. */ }
    requestVersion++;
    clearOldData();
    return publish("signed_out", { message: MESSAGES.session_expired });
  };

  async function start() {
    clearOldData();
    if (!validateHost()) return publish("unconfigured");
    if (!authSubscription && typeof authClient.auth.onAuthStateChange === "function") {
      const result = authClient.auth.onAuthStateChange((event, session) => { void loadSession(session, event); });
      authSubscription = result?.data?.subscription || result?.subscription || null;
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
    clearOldData();
    expiredNotice = false;
    sessionLease.stop();
    if (!validateHost() || typeof authClient.auth.signInWithOAuth !== "function") return publish("unconfigured");
    publish("authorizing");
    try {
      const { error } = await authClient.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: globalThis.location?.href, scopes: "openid email", queryParams: { prompt: "select_account" } }
      });
      if (error) return publish("error");
      return state;
    } catch (_) {
      return publish("error");
    }
  }

  async function refresh() {
    clearOldData();
    if (!validateHost() || typeof authClient.auth.getSession !== "function") return publish("unconfigured");
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
    clearOldData();
    publish("signing_out");
    try {
      const { error } = await authClient?.auth?.signOut?.() || {};
      if (error) return publish("error");
    } catch (_) {
      return publish("error");
    } finally {
      requestVersion++;
      sessionLease.stop();
      clearOldData();
      if (state.status === "signing_out") publish("signed_out");
    }
    return state;
  }

  function dispose() {
    requestVersion++;
    sessionLease.stop();
    authSubscription?.unsubscribe?.();
    authSubscription = null;
    clearOldData();
    state = { status: "signed_out", message: MESSAGES.signed_out, dataset: null, readAt: null };
  }

  return { start, signIn, refresh, signOut, dispose, getState: () => state };
}
