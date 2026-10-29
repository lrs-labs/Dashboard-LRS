const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const PDF_MIME = "application/pdf";
const DRIVE_FIELDS = "files(id,name,mimeType,parents,appProperties,headRevisionId,version,webViewLink,trashed),nextPageToken";
const FILE_FIELDS = "id,name,mimeType,parents,appProperties,headRevisionId,version,webViewLink,trashed";
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])-Q([12])$/;
const MONTHS = Object.freeze(["ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"]);

function providerError(code, outcomeUnknown = false) {
  const error = new Error(code);
  error.outcomeUnknown = outcomeUnknown;
  return error;
}
function cleanSegment(value) {
  const result = String(value ?? "").normalize("NFC").trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").slice(0, 80);
  if (!result || result === "." || result === "..") throw providerError("drive_path_segment_invalid");
  return result;
}
function encodeQuery(query) { return encodeURIComponent(query); }
function escapeDriveQuery(value) { return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }
function concatBytes(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw providerError("pdf_bytes_required");
}
async function sha256(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function base64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}
function base64Url(bytes) { return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
function validKey(value) { return typeof value === "string" && value.length >= 16 && value.length <= 240 && /^[A-Za-z0-9._:-]+$/.test(value); }

function ensureEnabled(config, provider) {
  if (config?.enabled !== true || typeof config.getAccessToken !== "function") throw providerError(`${provider}_provider_not_configured`);
}

export function createGoogleDriveInvoiceAdapter({ config = {}, fetcher = globalThis.fetch } = {}) {
  async function getToken() {
    ensureEnabled(config, "google_drive");
    if (typeof fetcher !== "function" || typeof config.rootFolderId !== "string" || !config.rootFolderId.trim()) {
      throw providerError("google_drive_provider_not_configured");
    }
    const token = await config.getAccessToken();
    if (typeof token !== "string" || !token.trim()) throw providerError("google_drive_token_unavailable");
    return token;
  }
  async function request(url, { method = "GET", body, headers = {}, outcomeUnknown = false } = {}) {
    const token = await getToken();
    let response;
    try {
      response = await fetcher(url, {
        method, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...headers }, body
      });
    } catch (_) {
      throw providerError("google_drive_request_failed", outcomeUnknown);
    }
    if (!response.ok) {
      const uncertain = outcomeUnknown && (response.status >= 500 || response.status === 408 || response.status === 429);
      throw providerError(response.status === 412 ? "drive_revision_conflict" : `google_drive_http_${response.status}`, uncertain);
    }
    if (response.status === 204) return {};
    try { return await response.json(); }
    catch (_) { throw providerError("google_drive_response_invalid", outcomeUnknown); }
  }
  async function list(q) {
    const items = [];
    let pageToken = "";
    for (let page = 0; page < 10; page++) {
      const params = new URLSearchParams({ q, fields: DRIVE_FIELDS, pageSize: "100", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
      if (pageToken) params.set("pageToken", pageToken);
      const payload = await request(`${DRIVE_API}/files?${params}`);
      if (!Array.isArray(payload.files)) throw providerError("google_drive_list_invalid");
      items.push(...payload.files);
      if (!payload.nextPageToken) return items;
      pageToken = payload.nextPageToken;
    }
    throw providerError("google_drive_query_too_large");
  }
  async function getFile(fileId) {
    if (typeof fileId !== "string" || !fileId.trim() || fileId.length > 200) throw providerError("drive_file_id_invalid");
    return request(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`);
  }
  function exactOne(files, code) {
    const current = files.filter(file => file && file.trashed !== true);
    if (current.length > 1) throw providerError(code);
    return current[0] || null;
  }
  async function childFolder(name, parentId) {
    const q = `mimeType='${FOLDER_MIME}' and name='${escapeDriveQuery(name)}' and '${escapeDriveQuery(parentId)}' in parents and trashed=false`;
    const existing = exactOne(await list(q), "drive_folder_ambiguous");
    if (existing) return existing;
    let created;
    try {
      created = await request(`${DRIVE_API}/files?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }), outcomeUnknown: true
      });
    } catch (error) {
      if (error.outcomeUnknown !== true) throw error;
      const reconciled = exactOne(await list(q), "drive_folder_ambiguous");
      if (reconciled) return reconciled;
      throw error;
    }
    if (!created?.id || created.mimeType !== FOLDER_MIME) throw providerError("drive_folder_create_unverified", true);
    return created;
  }
  async function ensurePath(folderPath) {
    const parts = String(folderPath || "").split("/").map(part => cleanSegment(part));
    if (parts.length !== 4 || parts[0] !== "NOMINAS") throw providerError("drive_payroll_path_invalid");
    const yearMonth = /^\d{4}$/.test(parts[1]) && MONTHS.includes(parts[2]);
    if (!yearMonth) throw providerError("drive_payroll_path_invalid");
    let parentId = config.rootFolderId;
    for (const name of parts) parentId = (await childFolder(name, parentId)).id;
    return parentId;
  }
  function identityProps(metadata) {
    const periodKey = metadata?.periodKey;
    const technicianId = metadata?.technicianId;
    const snapshotId = metadata?.snapshotId;
    const sourceRevision = metadata?.sourceRevision;
    if (!PERIOD.test(periodKey || "") || !technicianId || !snapshotId || !sourceRevision) throw providerError("drive_invoice_identity_invalid");
    for (const value of [technicianId, snapshotId, sourceRevision]) if (String(value).length > 120) throw providerError("drive_invoice_identity_invalid");
    return { lrs_period_key: periodKey, lrs_technician_id: String(technicianId), lrs_snapshot_id: String(snapshotId), lrs_source_revision: String(sourceRevision) };
  }
  async function findByIdentity(periodKey, technicianId) {
    if (!PERIOD.test(periodKey || "") || typeof technicianId !== "string" || !technicianId.trim()) throw providerError("drive_invoice_identity_invalid");
    const q = `mimeType='${PDF_MIME}' and appProperties has { key='lrs_period_key' and value='${escapeDriveQuery(periodKey)}' } and appProperties has { key='lrs_technician_id' and value='${escapeDriveQuery(technicianId)}' } and trashed=false`;
    const file = exactOne(await list(q), "drive_invoice_ambiguous");
    if (!file) return null;
    if (file.mimeType !== PDF_MIME || !file.id || !file.headRevisionId || file.appProperties?.lrs_period_key !== periodKey || file.appProperties?.lrs_technician_id !== technicianId) {
      throw providerError("drive_invoice_metadata_invalid");
    }
    return summary(file);
  }
  function summary(file) {
    const props = file.appProperties || {};
    return {
      state: "stored", fileId: file.id, revisionId: file.headRevisionId,
      periodKey: props.lrs_period_key, technicianId: props.lrs_technician_id,
      snapshotId: props.lrs_snapshot_id, sourceRevision: props.lrs_source_revision,
      pdfSha256: props.lrs_pdf_sha256, fileName: file.name, webViewLink: file.webViewLink || null,
      version: String(file.version || "")
    };
  }
  async function makeMultipart(metadata, bytes) {
    const boundary = `lrs_${crypto.randomUUID().replace(/-/g, "")}`;
    const encoder = new TextEncoder();
    return {
      boundary,
      body: concatBytes([
        encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
        encoder.encode(`--${boundary}\r\nContent-Type: ${PDF_MIME}\r\n\r\n`), bytes,
        encoder.encode(`\r\n--${boundary}--`)
      ])
    };
  }
  async function findByOperationKey(key) {
    const q = `mimeType='${PDF_MIME}' and appProperties has { key='lrs_operation_key' and value='${escapeDriveQuery(key)}' } and trashed=false`;
    return exactOne(await list(q), "drive_idempotency_ambiguous");
  }
  async function pinRevision(fileId, revisionId) {
    const path = `${DRIVE_API}/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}?fields=id,keepForever&supportsAllDrives=true`;
    const result = await request(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ keepForever: true }) });
    if (result.id !== revisionId || result.keepForever !== true) throw providerError("drive_revision_retention_unverified", true);
  }
  async function createInvoice({ content, fileName, folderPath, idempotencyKey, metadata }) {
    const bytes = toBytes(content);
    if (bytes.length > MAX_PDF_BYTES || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw providerError("pdf_bytes_required");
    if (!validKey(idempotencyKey)) throw providerError("drive_idempotency_key_invalid");
    const props = identityProps(metadata);
    const prior = await findByOperationKey(idempotencyKey);
    if (prior) {
      const found = summary(prior);
      const expectedDigest = await sha256(bytes);
      if (found.pdfSha256 !== expectedDigest || found.periodKey !== props.lrs_period_key || found.technicianId !== props.lrs_technician_id) throw providerError("drive_idempotency_conflict");
      return { fileId: found.fileId, revisionId: found.revisionId };
    }
    const parentId = await ensurePath(folderPath);
    const pdfSha256 = await sha256(bytes);
    const fileMetadata = { name: cleanSegment(fileName), mimeType: PDF_MIME, parents: [parentId], appProperties: { ...props, lrs_pdf_sha256: pdfSha256, lrs_operation_key: idempotencyKey } };
    const multipart = await makeMultipart(fileMetadata, bytes);
    const uploaded = await request(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`, {
      method: "POST", headers: { "content-type": `multipart/related; boundary=${multipart.boundary}` }, body: multipart.body, outcomeUnknown: true
    });
    if (!uploaded?.id) throw providerError("drive_create_unverified", true);
    try {
      const current = await getFile(uploaded.id);
      if (current?.id !== uploaded.id || current.mimeType !== PDF_MIME || current.appProperties?.lrs_operation_key !== idempotencyKey || current.appProperties?.lrs_pdf_sha256 !== pdfSha256 || !current.headRevisionId) {
        throw providerError("drive_create_unverified", true);
      }
      await pinRevision(current.id, current.headRevisionId);
      return { fileId: current.id, revisionId: current.headRevisionId };
    } catch (error) {
      if (error.outcomeUnknown !== true) error.outcomeUnknown = true;
      throw error;
    }
  }
  async function replacePreservingRevision({ fileId, expectedRevisionId, content, fileName, folderPath, idempotencyKey, metadata }) {
    const bytes = toBytes(content);
    if (bytes.length > MAX_PDF_BYTES || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw providerError("pdf_bytes_required");
    if (!validKey(idempotencyKey) || !expectedRevisionId) throw providerError("drive_idempotency_or_revision_invalid");
    const current = await getFile(fileId);
    if (current?.id !== fileId || current.mimeType !== PDF_MIME || current.headRevisionId !== expectedRevisionId || current.trashed === true) {
      throw providerError("drive_revision_conflict");
    }
    const props = identityProps(metadata);
    const oldIdentity = current.appProperties || {};
    if (oldIdentity.lrs_period_key && (oldIdentity.lrs_period_key !== props.lrs_period_key || oldIdentity.lrs_technician_id !== props.lrs_technician_id)) {
      throw providerError("drive_file_identity_conflict");
    }
    const parentId = await ensurePath(folderPath);
    if (!Array.isArray(current.parents) || !current.parents.includes(parentId)) throw providerError("drive_folder_identity_conflict");
    await pinRevision(fileId, expectedRevisionId);
    const pdfSha256 = await sha256(bytes);
    const appProperties = { ...oldIdentity, ...props, lrs_pdf_sha256: pdfSha256, lrs_operation_key: idempotencyKey };
    const multipart = await makeMultipart({ name: cleanSegment(fileName), appProperties, parents: [parentId] }, bytes);
    let uploaded;
    try {
      uploaded = await request(`${DRIVE_UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`, {
        method: "PATCH", headers: { "content-type": `multipart/related; boundary=${multipart.boundary}` }, body: multipart.body, outcomeUnknown: true
      });
    } catch (error) { throw error; }
    try {
      const after = await getFile(fileId);
      if (uploaded?.id !== fileId || after?.id !== fileId || after.headRevisionId === expectedRevisionId || after.appProperties?.lrs_operation_key !== idempotencyKey || after.appProperties?.lrs_pdf_sha256 !== pdfSha256 || !after.headRevisionId) {
        throw providerError("drive_replace_unverified", true);
      }
      await pinRevision(fileId, after.headRevisionId);
      return { fileId, revisionId: after.headRevisionId };
    } catch (error) {
      if (error.outcomeUnknown !== true) error.outcomeUnknown = true;
      throw error;
    }
  }
  async function lookup({ idempotencyKey }) {
    if (!validKey(idempotencyKey)) return { state: "unsettled" };
    try {
      const file = await findByOperationKey(idempotencyKey);
      if (!file) return { state: "unsettled" };
      const record = summary(file);
      if (!record.revisionId || record.pdfSha256?.length !== 64) return { state: "unsettled" };
      return { state: "succeeded", result: record };
    } catch (_) { return { state: "unsettled" }; }
  }
  return Object.freeze({
    findCurrentInvoice: ({ periodKey, technicianId }) => findByIdentity(periodKey, technicianId),
    getCurrentInvoice: ({ periodKey, technicianId }) => findByIdentity(periodKey, technicianId),
    createInvoice, replacePreservingRevision, lookup: Object.freeze({ lookup })
  });
}

function safeHeader(value, max = 180) {
  const result = String(value ?? "").replace(/[\r\n\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!result || result.length > max) throw providerError("email_header_invalid");
  return result;
}
function encodeSubject(value) {
  const safe = safeHeader(value, 160);
  if (/^[\x20-\x7e]*$/.test(safe)) return safe;
  return `=?UTF-8?B?${base64(new TextEncoder().encode(safe))}?=`;
}
function mimeBase64(bytes) { return base64(bytes).replace(/.{1,76}/g, "$&\r\n").trimEnd(); }

export function createGmailInvoiceMailer({ config = {}, fetcher = globalThis.fetch } = {}) {
  async function token() {
    ensureEnabled(config, "gmail");
    if (typeof fetcher !== "function") throw providerError("gmail_provider_not_configured");
    const result = await config.getAccessToken();
    if (typeof result !== "string" || !result.trim()) throw providerError("gmail_token_unavailable");
    return result;
  }
  async function messageIdFor(key) { return `${await sha256(new TextEncoder().encode(key))}@lrs.invalid`; }
  async function request(url, options = {}, uncertain = false) {
    const accessToken = await token();
    let response;
    try {
      response = await fetcher(url, { ...options, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", ...options.headers } });
    } catch (_) { throw providerError("gmail_request_failed", uncertain); }
    if (!response.ok) throw providerError(`gmail_http_${response.status}`, uncertain && (response.status >= 500 || response.status === 408 || response.status === 429));
    try { return await response.json(); } catch (_) { throw providerError("gmail_response_invalid", uncertain); }
  }
  async function lookup({ idempotencyKey }) {
    if (!validKey(idempotencyKey)) return { state: "unsettled" };
    const messageId = await messageIdFor(idempotencyKey);
    const query = `in:sent rfc822msgid:<${messageId}>`;
    try {
      const result = await request(`${GMAIL_API}/users/me/messages?${new URLSearchParams({ q: query, maxResults: "2" })}`);
      const matches = Array.isArray(result.messages) ? result.messages : [];
      if (matches.length === 1 && matches[0]?.id) return { state: "succeeded", result: { messageId: matches[0].id, rfcMessageId: messageId } };
      return { state: matches.length > 1 ? "needs_review" : "unsettled" };
    } catch (_) { return { state: "unsettled" }; }
  }
  async function send({ to, subject, attachment, idempotencyKey, recipientDirectoryId, fileName = "NOMINA.pdf" }) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to || "") || !recipientDirectoryId) throw providerError("verified_recipient_required");
    if (!validKey(idempotencyKey)) throw providerError("email_idempotency_key_invalid");
    const bytes = toBytes(attachment);
    if (bytes.length > MAX_PDF_BYTES || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw providerError("pdf_bytes_required");
    const safeSubject = encodeSubject(subject);
    const safeFileName = cleanSegment(fileName).replace(/[^\p{L}\p{N} ._-]/gu, "_").slice(0, 100);
    const rfcMessageId = await messageIdFor(idempotencyKey);
    const attachmentBase64 = mimeBase64(bytes);
    const boundary = `lrs_${(await sha256(new TextEncoder().encode(idempotencyKey))).slice(0, 32)}`;
    const mime = [
      `To: ${to}`,
      `Subject: ${safeSubject}`,
      `Message-ID: <${rfcMessageId}>`,
      `X-LRS-Idempotency-Key: ${idempotencyKey}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary=\"${boundary}\"`, "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 7bit", "",
      "Adjuntamos el invoice de nómina solicitado. Este documento no confirma una transferencia bancaria.",
      `--${boundary}`,
      `Content-Type: ${PDF_MIME}; name=\"${safeFileName}\"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename=\"${safeFileName}\"`, "",
      attachmentBase64,
      `--${boundary}--`, ""
    ].join("\r\n");
    const raw = base64Url(new TextEncoder().encode(mime));
    const result = await request(`${GMAIL_API}/users/me/messages/send`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ raw })
    }, true);
    if (!result?.id) throw providerError("gmail_send_unverified", true);
    return { messageId: result.id, rfcMessageId };
  }
  return Object.freeze({ send, lookup: Object.freeze({ lookup }) });
}
