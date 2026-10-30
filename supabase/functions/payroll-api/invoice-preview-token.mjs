const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_TTL_MS = 5 * 60_000;

function text(value) { return typeof value === "string" ? value.trim() : ""; }
function canonical(value) {
  return JSON.stringify(Object.keys(value).sort().map(key => [key, value[key]]));
}
function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function fromBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("invalid_preview_token");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}
function validBinding(value) {
  if (!value || typeof value !== "object") return false;
  const required = ["periodKey", "snapshotId", "sourceRevision", "technicianId", "fileId", "revisionId",
    "recipientDirectoryId", "directoryVersion", "recipientEmail", "actorId"];
  if (required.some(key => !text(value[key]))) return false;
  return /^\d{4}-(0[1-9]|1[0-2])-Q[12]$/.test(value.periodKey) &&
    SHA256.test(value.pdfSha256 || "") && EMAIL.test(value.recipientEmail);
}
function expectedBinding(input) {
  return {
    periodKey: text(input?.periodKey), snapshotId: text(input?.snapshotId), sourceRevision: text(input?.sourceRevision),
    technicianId: text(input?.technicianId), fileId: text(input?.archive?.fileId),
    revisionId: text(input?.archive?.revisionId), pdfSha256: text(input?.archive?.pdfSha256),
    recipientDirectoryId: text(input?.recipient?.directoryId), directoryVersion: text(input?.recipient?.directoryVersion),
    recipientEmail: text(input?.recipient?.email), actorId: text(input?.actorId)
  };
}

export function createInvoicePreviewTokenService({ secret, now = () => Date.now(), createId = () => globalThis.crypto?.randomUUID?.() } = {}) {
  if (typeof secret !== "string" || new TextEncoder().encode(secret).length < 32) throw new TypeError("preview_secret_too_short");
  const secretBytes = new TextEncoder().encode(secret);
  let keyPromise;
  function key() {
    if (!keyPromise) keyPromise = crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    return keyPromise;
  }

  async function issue(binding, { ttlMs = MAX_TTL_MS } = {}) {
    if (!validBinding(binding) || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) {
      throw new TypeError("preview_binding_invalid");
    }
    const deliveryAttemptId = createId();
    if (!text(deliveryAttemptId) || deliveryAttemptId.length > 120) throw new TypeError("preview_attempt_id_invalid");
    const issuedAt = now();
    const expiresAt = issuedAt + ttlMs;
    const payload = { v: 1, issuedAt, expiresAt, deliveryAttemptId, binding: { ...binding } };
    const encoded = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
    const signature = base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", await key(), new TextEncoder().encode(encoded))));
    return { token: `${encoded}.${signature}`, deliveryAttemptId, expiresAt: new Date(expiresAt).toISOString() };
  }

  async function verify(input) {
    try {
      const token = text(input?.token);
      if (!token || token.length > 8192) return { approved: false };
      const parts = token.split(".");
      if (parts.length !== 2) return { approved: false };
      const message = new TextEncoder().encode(parts[0]);
      const signature = fromBase64Url(parts[1]);
      if (!(await crypto.subtle.verify("HMAC", await key(), signature, message))) return { approved: false };
      const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
      const currentTime = now();
      if (payload?.v !== 1 || !Number.isFinite(payload.issuedAt) || !Number.isFinite(payload.expiresAt) ||
          payload.issuedAt > currentTime + 30_000 || payload.expiresAt <= currentTime ||
          payload.expiresAt - payload.issuedAt > MAX_TTL_MS || !text(payload.deliveryAttemptId) || !validBinding(payload.binding)) {
        return { approved: false };
      }
      const expected = expectedBinding(input);
      if (!validBinding(expected) || canonical(payload.binding) !== canonical(expected)) return { approved: false };
      return { approved: true, deliveryAttemptId: payload.deliveryAttemptId, expiresAt: new Date(payload.expiresAt).toISOString(), binding: payload.binding };
    } catch (_) {
      return { approved: false };
    }
  }

  return Object.freeze({ issue, verify });
}
