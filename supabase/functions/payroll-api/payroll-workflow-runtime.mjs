import { buildPayrollInvoice } from "../../../payroll-private-view.mjs";
import { generatePayrollInvoicePdf } from "../../../payroll-invoice-pdf.mjs";
import { createImmutablePayrollSnapshotStore } from "./payroll-snapshot-store.mjs";
import { computePeriodSourceRevision } from "./payroll-source-projection.mjs";
import { createSupabaseAssignmentIdentityStore } from "./supabase-assignment-identity-store.mjs";
import { createSupabasePayrollSnapshotStorage, createSupabaseRecipientDirectory } from "./supabase-snapshot-recipient-store.mjs";
import { createSupabaseWorkflowStore } from "./supabase-workflow-store.mjs";
import { createGoogleRefreshTokenProvider } from "./google-oauth-token.mjs";
import { createGoogleDriveInvoiceAdapter, createGmailInvoiceMailer } from "./google-workflow-adapters.mjs";
import { createInvoicePreviewTokenService } from "./invoice-preview-token.mjs";
import { createPayrollWorkflowHandler } from "./workflow-http.mjs";
import { validatePayrollBridgeUrl } from "./hmac-bridge.mjs";

function identitiesMatch(lines, records) {
  if (!Array.isArray(lines) || !Array.isArray(records)) return false;
  const byId = new Map(records.map(item => [item.assignmentId, item]));
  return lines.map(line => {
    const record = byId.get(line.assignmentId);
    const match = record?.state === "verified" && record.sourceFingerprintHash === line.sourceFingerprintHash &&
      (!line.sheetMetadataId || record.sheetMetadataId === line.sheetMetadataId);
    return { state: match ? "verified" : "needs_review", assignmentId: match ? line.assignmentId : null };
  });
}

/** Compose production handlers from runtime-only secrets and injected providers. */
export function createPayrollWorkflowRuntime({ supabaseAdmin, core, env = {}, readPayrollRows,
  fetcher = globalThis.fetch, now = () => Date.now() } = {}) {
  if (typeof supabaseAdmin?.rpc !== "function" || !core?.buildAssignments || typeof readPayrollRows !== "function") {
    throw new TypeError("payroll_workflow_runtime_dependencies_required");
  }
  const tokenProvider = createGoogleRefreshTokenProvider({ config: {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN
  }, fetcher, now });
  const sourceBridgeConfigured = validatePayrollBridgeUrl(env.GOOGLE_PAYROLL_READ_BRIDGE_URL || "") &&
    typeof env.GOOGLE_PAYROLL_BRIDGE_HMAC_SECRET === "string" && new TextEncoder().encode(env.GOOGLE_PAYROLL_BRIDGE_HMAC_SECRET).length >= 32;
  const driveEnabled = env.PAYROLL_WORKFLOWS_ENABLED === "true" && tokenProvider.configured &&
    sourceBridgeConfigured && typeof env.GOOGLE_DRIVE_NOMINAS_ROOT_ID === "string" && !!env.GOOGLE_DRIVE_NOMINAS_ROOT_ID.trim();
  const drive = createGoogleDriveInvoiceAdapter({ config: { enabled: driveEnabled,
    rootFolderId: env.GOOGLE_DRIVE_NOMINAS_ROOT_ID, getAccessToken: () => tokenProvider.getAccessToken() }, fetcher });
  const emailEnabled = driveEnabled && env.PAYROLL_EMAIL_ENABLED === "true";
  const mailer = createGmailInvoiceMailer({ config: { enabled: emailEnabled, getAccessToken: () => tokenProvider.getAccessToken() }, fetcher });
  const previewSecret = typeof env.PAYROLL_PREVIEW_HMAC_SECRET === "string" && new TextEncoder().encode(env.PAYROLL_PREVIEW_HMAC_SECRET).length >= 32
    ? env.PAYROLL_PREVIEW_HMAC_SECRET : null;
  const preview = previewSecret ? createInvoicePreviewTokenService({ secret: previewSecret, now }) : null;
  const identities = createSupabaseAssignmentIdentityStore(supabaseAdmin);
  const snapshots = createImmutablePayrollSnapshotStore(createSupabasePayrollSnapshotStorage(supabaseAdmin));
  const recipients = createSupabaseRecipientDirectory(supabaseAdmin);
  const { jobs, audit } = createSupabaseWorkflowStore(supabaseAdmin);
  const sourceReader = Object.freeze({
    async getRevision({ periodKey }) { return computePeriodSourceRevision(await readPayrollRows(), periodKey, core); }
  });
  const handler = createPayrollWorkflowHandler({
    enabled: driveEnabled, snapshotStore: snapshots, sourceReader,
    identityResolver: async lines => identitiesMatch(lines, await identities.findByAssignmentIds(lines.map(line => line.assignmentId))),
    buildInvoice(snapshot, technicianId) {
      const technician = snapshot.lines.find(line => line.technicianId === technicianId)?.technician;
      return buildPayrollInvoice(snapshot.lines, technician, snapshot.periodKey, core, {
        technicianId,
        generatedAt: snapshot.frozenAt
      });
    },
    renderPdf(invoice) { return generatePayrollInvoicePdf(invoice).bytes; },
    drive, jobs, audit, recipientDirectory: recipients, previewSigner: preview, previewVerifier: preview,
    mailer, now
  });
  return Object.freeze({ handler, driveEnabled, emailEnabled: emailEnabled && !!preview,
    tokenProviderConfigured: tokenProvider.configured, sourceBridgeConfigured });
}
