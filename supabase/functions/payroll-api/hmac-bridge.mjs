export const PAYROLL_BRIDGE_ACTION = "payroll.read.v1";
export const DASHBOARD_BRIDGE_ACTION = "dashboard.read.v1";
export const PAYROLL_BRIDGE_ACTIONS = Object.freeze([PAYROLL_BRIDGE_ACTION, DASHBOARD_BRIDGE_ACTION]);

export function canonicalPayrollBridgeMessage(timestamp, nonce, action = PAYROLL_BRIDGE_ACTION) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new TypeError("invalid_timestamp");
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{22,86}$/.test(nonce)) throw new TypeError("invalid_nonce");
  if (!PAYROLL_BRIDGE_ACTIONS.includes(action)) throw new TypeError("invalid_action");
  return `LRS-PAYROLL-HMAC-V1\nPOST\n${timestamp}\n${nonce}\n${action}`;
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomNonce() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function createPayrollBridgeEnvelope(secret, options = {}) {
  if (typeof secret !== "string" || new TextEncoder().encode(secret).length < 32) {
    throw new TypeError("bridge_secret_must_be_at_least_32_bytes");
  }
  const timestamp = options.timestamp ?? Math.floor((options.nowMs ?? Date.now()) / 1000);
  const nonce = options.nonce || randomNonce();
  const action = options.action ?? PAYROLL_BRIDGE_ACTION;
  const message = canonicalPayrollBridgeMessage(timestamp, nonce, action);
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return { action, timestamp, nonce, signature: base64Url(signature) };
}

export function validatePayrollBridgeUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === "https:" && url.hostname === "script.google.com" &&
    /^\/macros\/s\/[A-Za-z0-9_-]+\/exec\/?$/.test(url.pathname) &&
    !url.username && !url.password && !url.search && !url.hash;
}
