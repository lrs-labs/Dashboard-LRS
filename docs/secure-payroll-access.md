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

## Google Sheets bridge assessment

The current Supabase function has no Google credentials and cannot read the source Sheet yet. The lowest-stack option to evaluate first is a **read-only Apps Script bridge** called server-to-server by the Supabase function:

1. Replace the existing anonymous GET/JSONP and write-capable handlers with a narrowly scoped POST contract that returns only the approved payroll projection. Reject all unsupported operations before opening the spreadsheet.
2. Require an HMAC-SHA256 signature over the method, fixed action, timestamp, nonce, and exact body. Keep the shared HMAC secret only in Apps Script Script Properties and Supabase Function Secrets. Enforce a short timestamp window, nonce replay checks, request-size limits, and a lock around replay checks. Supabase must authenticate the user's JWT and check `private.user_access` before calling this bridge.
3. Deny unsigned requests, JSONP, browser requests, row-number lookups, sheet/range selection from the client, and any legacy `reset`, `guardarCaso`, or payment action. Do not deploy the bridge until the active Apps Script project/source and deployment are verified and the public handlers are closed.

This avoids a Google service-account private key, but it is **not credential-free**: the HMAC secret is a persistent machine credential and needs separate approval and secure configuration. Apps Script supports HMAC-SHA256 signing. Supabase documents storing runtime secrets as function secrets. We did not create either value. The source project and active deployment still need to be made available for inspection; the supplied deployment manifest and old source excerpts are not proof of the currently deployed version.

Google Workload Identity Federation can remove service-account keys for supported external workloads, but Google requires a trusted external identity token. We found no documented way for this managed Supabase Edge Function runtime to obtain an AWS identity assertion, so a keyless Google federation path is not established for this project. Do not assume that the fact Supabase runs its infrastructure on AWS grants this function AWS credentials.

If the bridge cannot be secured, the fallback is a dedicated Google service account granted **Viewer on the source Sheet only**, using the Google Sheets read-only API scope, with the key stored only in Supabase Function Secrets. Google recommends federation over long-lived service-account keys where available. This fallback would still be a new persistent credential/grant, and has not been approved or created. PDF storage, sending email, and paid-flag writes need separate permissions and separately reviewed handlers; no Google Drive/Gmail/write scopes are configured here.

References: [Apps Script HMAC-SHA256](https://developers.google.com/apps-script/reference/utilities/utilities#computeHmacSha256Signature(String,String)), [Supabase Function Secrets](https://supabase.com/docs/guides/functions/secrets), [Google Workload Identity Federation](https://cloud.google.com/iam/docs/workload-identity-federation), [Google Sheets API scopes](https://developers.google.com/workspace/sheets/api/scopes), [Google service-account guidance](https://cloud.google.com/iam/docs/service-account-overview).

## Job idempotency

`workflow-idempotency.mjs` derives opaque stable keys for period close, per-technician invoice versions, individual email attempts, and per-assignment calendar marks. Job payload digests detect key reuse with different content. Replays of queued/running work wait; a succeeded replay returns its recorded result; unknown outcomes require reconciliation; failed retries require explicit approval. No handler currently enqueues or executes these business jobs, and no live invoices, emails, or payment flags have been changed.

The helper is a tested planning primitive, not a scheduler or a payment writer. Automatic administrative marking on the 3rd/18th still requires a verified closed-period snapshot, stable assignment identifiers, an audit ledger, and reviewed server-side write access to AF:AH. Unknown flags or missing snapshot data must continue to block the batch.

## Verification

The synthetic tests cover the private client and gate, authorization policy, payroll slot mapping, missing payment flags, and opaque job idempotency/replay transitions. They use no live rows or credentials.
