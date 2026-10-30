export const PAYROLL_API_BODY_LIMIT_BYTES = 8192;

/** Read a bounded UTF-8 request body without buffering unbounded input. */
export async function readRequestBodyLimited(request, limitBytes = PAYROLL_API_BODY_LIMIT_BYTES) {
  if (!request || !Number.isSafeInteger(limitBytes) || limitBytes < 1) return { ok: false, reason: "invalid_limit" };
  const declaredLength = request.headers?.get?.("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > limitBytes) {
    try { await request.body?.cancel?.(); } catch (_) { /* The declared limit already rejects the request. */ }
    return { ok: false, reason: "too_large" };
  }
  const reader = request.body?.getReader?.();
  if (!reader) return { ok: true, text: "" };
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) return { ok: false, reason: "invalid_body" };
      total += value.byteLength;
      if (total > limitBytes) {
        try { await reader.cancel(); } catch (_) { /* Rejection remains authoritative. */ }
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch (_) { return { ok: false, reason: "read_failed" }; }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  try { return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(joined) }; }
  catch (_) { return { ok: false, reason: "invalid_utf8" }; }
}
