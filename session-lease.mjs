export const PRIVATE_SESSION_STARTED_AT_KEY = "lrs.private.session.started-at";
export const MAX_PRIVATE_SESSION_AGE_MS = 8 * 60 * 60 * 1000;

export function createPrivateSessionLease({
  storage = null,
  now = () => Date.now(),
  schedule = globalThis.setTimeout,
  cancel = globalThis.clearTimeout,
  maxAgeMs = MAX_PRIVATE_SESSION_AGE_MS,
  onExpire = () => {}
} = {}) {
  let memoryStart = null;
  let timer = null;
  let generation = 0;

  function readStart() {
    try {
      const value = storage?.getItem?.(PRIVATE_SESSION_STARTED_AT_KEY);
      if (value !== null && value !== undefined) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? number : null;
      }
    } catch (_) { return null; }
    return memoryStart;
  }
  function writeStart(value) {
    try {
      if (storage?.setItem) {
        storage.setItem(PRIVATE_SESSION_STARTED_AT_KEY, String(value));
        if (storage.getItem(PRIVATE_SESSION_STARTED_AT_KEY) !== String(value)) return false;
        return true;
      }
    } catch (_) { return false; }
    memoryStart = value;
    return true;
  }
  function clearStart() {
    memoryStart = null;
    try { storage?.removeItem?.(PRIVATE_SESSION_STARTED_AT_KEY); } catch (_) { /* Keep logout usable when browser storage is disabled. */ }
  }
  function clearTimer() {
    generation++;
    if (timer !== null) {
      try { cancel?.(timer); } catch (_) { /* Timer cleanup is best effort. */ }
      timer = null;
    }
  }
  function stop({ clearMarker = true } = {}) {
    clearTimer();
    if (clearMarker) clearStart();
  }
  function begin({ newAuthentication = false } = {}) {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || typeof schedule !== "function") return { ok: false, reason: "lease_unavailable" };
    clearTimer();
    let startedAt = newAuthentication ? null : readStart();
    if (!startedAt) {
      startedAt = now();
      if (!Number.isFinite(startedAt) || startedAt <= 0 || !writeStart(startedAt)) return { ok: false, reason: "lease_storage_unavailable" };
    }
    const expiresAt = startedAt + maxAgeMs;
    const remaining = expiresAt - now();
    if (remaining <= 0) {
      stop();
      return { ok: false, reason: "session_expired", startedAt, expiresAt };
    }
    const currentGeneration = generation;
    try {
      timer = schedule(() => {
        if (currentGeneration !== generation) return;
        timer = null;
        stop();
        onExpire();
      }, remaining);
      timer?.unref?.();
    } catch (_) {
      stop();
      return { ok: false, reason: "lease_unavailable" };
    }
    return { ok: true, startedAt, expiresAt };
  }
  return Object.freeze({ begin, stop, getStartedAt: readStart });
}
