import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleRefreshTokenProvider } from "../supabase/functions/payroll-api/google-oauth-token.mjs";

const config = { clientId: "fixture-client-id", clientSecret: "fixture-client-secret", refreshToken: "fixture-refresh-token" };
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, async json() { return body; } }; }

test("Google refresh provider caches server-side access tokens and coalesces concurrent refresh requests", async () => {
  let now = 1_000_000, requests = 0, captured;
  const provider = createGoogleRefreshTokenProvider({ config, now: () => now, fetcher: async (url, options) => {
    requests++; captured = { url: String(url), options };
    await new Promise(resolve => setTimeout(resolve, 2));
    return response({ access_token: "synthetic-access-token", expires_in: 3600 });
  } });
  assert.equal(provider.configured, true);
  const values = await Promise.all([provider.getAccessToken(), provider.getAccessToken(), provider.getAccessToken()]);
  assert.deepEqual(values, ["synthetic-access-token", "synthetic-access-token", "synthetic-access-token"]);
  assert.equal(requests, 1);
  assert.equal(captured.url, "https://oauth2.googleapis.com/token");
  assert.equal(captured.options.redirect, "error");
  assert.equal(captured.options.cache, "no-store");
  assert.equal(captured.options.body.get("refresh_token"), config.refreshToken);
  now += 3_600_000;
  assert.equal(await provider.getAccessToken(), "synthetic-access-token");
  assert.equal(requests, 2);
});

test("Google refresh provider fails closed when credentials are absent or token response is invalid", async () => {
  let requests = 0;
  const missing = createGoogleRefreshTokenProvider({ config: {}, fetcher: async () => { requests++; } });
  assert.equal(missing.configured, false);
  await assert.rejects(missing.getAccessToken(), /google_oauth_not_configured/);
  const invalid = createGoogleRefreshTokenProvider({ config, fetcher: async () => { requests++; return response({ error: "invalid_grant" }, 400); } });
  await assert.rejects(invalid.getAccessToken(), /google_oauth_token_refresh_failed/);
  assert.equal(requests, 1);
});
