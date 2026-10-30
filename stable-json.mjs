/** Deterministic JSON used for content digests and compare-and-set records. */
export function stableJson(value) {
  const seen = new Set();
  function normalize(input) {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new TypeError("non_finite_digest_value");
      return Object.is(input, -0) ? 0 : input;
    }
    if (Array.isArray(input)) {
      if (seen.has(input)) throw new TypeError("cyclic_digest_value");
      seen.add(input);
      const result = input.map(item => {
        if (item === undefined) throw new TypeError("undefined_digest_value");
        return normalize(item);
      });
      seen.delete(input);
      return result;
    }
    if (typeof input === "object" && Object.getPrototypeOf(input) === Object.prototype) {
      if (seen.has(input)) throw new TypeError("cyclic_digest_value");
      seen.add(input);
      const result = {};
      for (const key of Object.keys(input).sort()) {
        if (input[key] === undefined) throw new TypeError("undefined_digest_value");
        result[key] = normalize(input[key]);
      }
      seen.delete(input);
      return result;
    }
    throw new TypeError("unsupported_digest_value");
  }
  return JSON.stringify(normalize(value));
}

export async function sha256Hex(value, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle?.digest) throw new TypeError("webcrypto_required");
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : stableJson(value));
  const digest = new Uint8Array(await cryptoImpl.subtle.digest("SHA-256", bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
