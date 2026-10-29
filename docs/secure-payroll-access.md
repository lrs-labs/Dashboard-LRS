# Private payroll frontend foundation

## Scope

This draft adds an isolated private payroll route and an optional redirect gate. It does not replace the current Dashboard data path by default, and it is not linked from the public page. Until a trusted runtime config is supplied, `payroll-private.html` says access is not configured, performs no payroll request, and has no public-source fallback.

When a trusted deployment bootstrap sets `window.LRS_PRIVATE_PAYROLL_RUNTIME.config.enabled` to `true`, `secure-payroll-gate.js` removes the old dashboard row and tab caches before redirecting to the private route. If storage cleanup fails, it still redirects. If redirect fails, it hides the page rather than reopening the public dashboard. A missing or disabled flag leaves current Dashboard behavior unchanged.

## Runtime contract

The deployment host must create an authenticated Supabase client before loading the gate and private route. Runtime values belong in the host's configuration, never in this repository. The injected object has this shape, with values supplied only at deployment time:

```js
window.LRS_PRIVATE_PAYROLL_RUNTIME = {
  config: {
    enabled: true,
    supabaseUrl: "<Supabase project URL>",
    publishableKey: "<public publishable key>",
    allowedOrigin: "<approved HTTPS origin>"
  },
  authClient: supabaseClient
};
```

Configure the client to keep its auth session in `sessionStorage`, not `localStorage`. Use Supabase Auth's Google OAuth flow with only `openid email`; register the exact approved production callback and origin. A user must also have an active server-side `private.user_access` record with payroll scope. The browser's email, role, or technician names are never an authorization source.

The private route sends a fresh `POST` to the authenticated Edge Function, with `cache: "no-store"`, omitted cookies, a bearer session, and an allowlisted action. It validates the response schema, keeps rows in memory only, and clears the view on sign-out, denial, error, or an older request completing after sign-out. It does not call Apps Script, JSONP, GViz, or local row caches.

## Cutover state

- `window.LRS_PRIVATE_PAYROLL_RUNTIME` is intentionally absent from source. No auth client, project URL, publishable key, private credential, user, email, or live payroll data is included here.
- The isolated route is not linked from Dashboard navigation. It has not been deployed to GitHub Pages or to the future custom domain.
- The Edge Function and schema require a separately configured Auth provider and runtime. No Auth users or `user_access` records have been provisioned, so authorization remains default-deny.
- The current public Dashboard still uses its existing Apps Script/GViz paths until the secure runtime is configured and the full dashboard cutover is approved. The gate is not a security boundary while disabled.
- Never enable the flag on the public Pages host until the private API, origin, Auth provider, Google read integration, and intended hosting location have been verified together.

## Verification

The synthetic client tests cover missing configuration, signed-out state, fresh no-store reads, 401/403/503/error responses, malformed payloads, origin validation, cache removal, sign-out, and late-response races. The gate tests cover disabled/default behavior, cache clearing before redirect, storage exceptions, and redirect failure. They use no live rows or credentials.
