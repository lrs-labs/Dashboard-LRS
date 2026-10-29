import { clearLegacyPayrollCache, validatePrivateRuntime } from "./secure-payroll-client.mjs";
import { readPrivateDashboard } from "./secure-dashboard-adapter.mjs";

const MESSAGES = Object.freeze({
  unconfigured: "La vista segura aún no está configurada para este dominio.",
  signed_out: "Inicia sesión para validar tu acceso al dashboard.",
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

export function createSecureDashboardClient({ config, authClient, fetcher = globalThis.fetch, storage = getStorage(), getOrigin = () => globalThis.location?.origin, onState = () => {} } = {}) {
  let state = { status: "unconfigured", message: MESSAGES.unconfigured, dataset: null, readAt: null };
  let authSubscription = null;
  let requestVersion = 0;
  let validated = validatePrivateRuntime(config, authClient);

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

  async function loadSession(session) {
    const version = ++requestVersion;
    clearOldData();
    if (!session?.access_token) return publish("signed_out");
    if (!validateHost()) return publish("unconfigured");
    publish("loading");
    const result = await readPrivateDashboard({
      endpoint: validated.endpoint,
      publishableKey: config.publishableKey,
      accessToken: session.access_token,
      fetcher
    });
    if (version !== requestVersion) return state;
    return publish(result.state, { dataset: result.dataset, readAt: result.dataset?.readAt || null });
  }

  async function start() {
    clearOldData();
    if (!validateHost()) return publish("unconfigured");
    if (!authSubscription && typeof authClient.auth.onAuthStateChange === "function") {
      const result = authClient.auth.onAuthStateChange((_event, session) => { void loadSession(session); });
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
    clearOldData();
    publish("signing_out");
    try {
      const { error } = await authClient?.auth?.signOut?.() || {};
      if (error) return publish("error");
    } catch (_) {
      return publish("error");
    } finally {
      requestVersion++;
      clearOldData();
      if (state.status === "signing_out") publish("signed_out");
    }
    return state;
  }

  function dispose() {
    requestVersion++;
    authSubscription?.unsubscribe?.();
    authSubscription = null;
    clearOldData();
    state = { status: "signed_out", message: MESSAGES.signed_out, dataset: null, readAt: null };
  }

  return { start, signIn, refresh, signOut, dispose, getState: () => state };
}
