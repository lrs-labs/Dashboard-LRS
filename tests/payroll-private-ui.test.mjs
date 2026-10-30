import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../payroll-private.html", import.meta.url), "utf8");

function button(id) {
  const match = html.match(new RegExp(`<button\\b(?=[^>]*\\bid="${id}")[^>]*>([\\s\\S]*?)<\\/button>`, "i"));
  assert.ok(match, `button ${id} exists`);
  return { openingTag: match[0].slice(0, match[0].indexOf(">") + 1), text: match[1].replace(/<[^>]*>/g, "").trim() };
}

test("Drive regenerate, separate resend, and history controls are explicit and remain disabled", () => {
  const driveOnly = button("driveOnly");
  const driveAndResend = button("driveAndResend");
  const retryEmail = button("retryEmailOnly");
  for (const control of [driveOnly, driveAndResend, retryEmail]) assert.match(control.openingTag, /\bdisabled(?:\s|>)/i);
  assert.match(driveOnly.text, /solo actualizar en Drive/i);
  assert.match(driveAndResend.text, /actualizar en Drive y reenviar al técnico/i);
  assert.match(retryEmail.text, /reintentar solo el envío/i);
  assert.match(html, /id="invoiceHistory"[^>]*aria-live="polite"/i);
  assert.match(html, /Historial de archivos/);
  assert.match(html, /Drive aún no está conectado/);
});

test("private payroll page has no enabled paid-marking control", () => {
  assert.doesNotMatch(html, /<button\b[^>]*(?:id|data-action)="[^"]*(?:markPaid|setPaid|paymentWrite)[^"]*"[^>]*>/i);
  assert.match(html, /no confirma una transferencia bancaria/i);
});

test("private payroll summary separates current-view payment and amount reviews from source-wide warnings", () => {
  assert.match(html, /Importe calculado/);
  assert.match(html, /Marcado pagado en hoja/);
  assert.match(html, /Pendiente según casillas/);
  assert.match(html, /Estados de pago por revisar/);
  assert.match(html, /Importes por revisar/);
  assert.match(html, /id="sourceReviewNote"[^>]*aria-live="polite"[^>]*hidden/i);
  const source = readFileSync(new URL("../secure-payroll-ui.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /sourceReviewCount/);
  assert.match(source, /Avisos globales de clasificación, separados del período/);
  assert.match(source, /no se cuentan como asignaciones ni como saldo pendiente/i);
});

test("private payroll page uses its isolated core without replacing the public dashboard core", () => {
  assert.match(html, /<script src="\.\/payroll-core-private\.js" defer><\/script>/);
  assert.doesNotMatch(html, /<script src="\.\/payroll-core\.js" defer><\/script>/);
});
