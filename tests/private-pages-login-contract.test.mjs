import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("private pages offer work-email one-time links without an OAuth provider", async () => {
  for (const [path, modulePath] of [["../private-dashboard.html", "private-dashboard-ui.mjs"], ["../payroll-private.html", "secure-payroll-ui.mjs"]]) {
    const html = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(html, /type="email"[^>]*id="signInEmail"|id="signInEmail"[^>]*type="email"/);
    assert.match(html, /id="signIn"[^>]*>Enviar enlace de acceso</);
    assert.match(html, /private-runtime-config\.js/);
    assert.doesNotMatch(html, /Continuar con Google/);
    assert.ok(html.indexOf("private-runtime-config.js") < html.indexOf(modulePath));
  }
});

test("committed Pages runtime config is disabled and contains no credential-shaped fields", async () => {
  const source = await readFile(new URL("../private-runtime-config.js", import.meta.url), "utf8");
  assert.match(source, /enabled:\s*false/);
  assert.doesNotMatch(source, /(?:service[_-]?role|hmac|smtp|access[_-]?token|publishableKey)\s*[:=]/i);
});
