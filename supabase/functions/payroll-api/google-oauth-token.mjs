const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

function credentialsPresent(config) {
  return typeof config?.clientId === "string" && !!config.clientId.trim() &&
    typeof config?.clientSecret === "string" && !!config.clientSecret.trim() &&
    typeof config?.refreshToken === "string" && !!config.refreshToken.trim();
}

/** Server-only access token refresh. Never returns or stores the refresh token in browser state. */
export function createGoogleRefreshTokenProvider({ config = {}, fetcher = globalThis.fetch, now = () => Date.now() } = {}) {
  let cached = null;
  let refreshPromise = null;
  return Object.freeze({
    configured: credentialsPresent(config) && typeof fetcher === "function",
    async getAccessToken() {
      if (!credentialsPresent(config) || typeof fetcher !== "function") throw new Error("google_oauth_not_configured");
      const time = now();
      if (cached && cached.expiresAt > time + 60_000) return cached.value;
      if (refreshPromise) return refreshPromise;
      refreshPromise = (async () => {
        const form = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
          refresh_token: config.refreshToken, grant_type: "refresh_token" });
        let response;
        try {
          response = await fetcher(GOOGLE_TOKEN_URL, { method: "POST", cache: "no-store", redirect: "error",
            signal: AbortSignal.timeout(15_000), headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form });
        } catch (_) { throw new Error("google_oauth_token_refresh_failed"); }
        if (!response?.ok) throw new Error("google_oauth_token_refresh_failed");
        let body;
        try { body = await response.json(); } catch (_) { throw new Error("google_oauth_token_response_invalid"); }
        if (typeof body?.access_token !== "string" || !body.access_token.trim() || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
          throw new Error("google_oauth_token_response_invalid");
        }
        cached = { value: body.access_token, expiresAt: time + Math.min(body.expires_in, 3600) * 1000 };
        return cached.value;
      })();
      try { return await refreshPromise; }
      finally { refreshPromise = null; }
    }
  });
}
