/** Read-only HMAC gateway for one fixed payroll projection. */
const LRS_PAYROLL_BRIDGE = Object.freeze({
  actions: ["payroll.read.v1", "dashboard.read.v1"],
  sheetTab: "REGISTRO_CASOS",
  maxBodyChars: 2048,
  maxRows: 20000,
  readRows: 20001,
  maxClockSkewSeconds: 60,
  nonceTtlSeconds: 120,
  maxActiveNonces: 400,
  noncePrefix: "lrs.payroll.read.nonce."
});
const LRS_PAYROLL_READ_RANGES = Object.freeze([
  "REGISTRO_CASOS!B3:B20003",
  "REGISTRO_CASOS!F3:H20003",
  "REGISTRO_CASOS!J3:K20003",
  "REGISTRO_CASOS!P3:P20003",
  "REGISTRO_CASOS!U3:W20003",
  "REGISTRO_CASOS!X3:Z20003",
  "REGISTRO_CASOS!AF3:AH20003",
  "REGISTRO_CASOS!AI3:AI20003",
  "REGISTRO_CASOS!AO3:AO20003"
]);
const LRS_DASHBOARD_READ_RANGES = Object.freeze([
  "REGISTRO_CASOS!B3:B20003",
  "REGISTRO_CASOS!F3:H20003",
  "REGISTRO_CASOS!I3:I20003",
  "REGISTRO_CASOS!J3:K20003",
  "REGISTRO_CASOS!L3:O20003",
  "REGISTRO_CASOS!P3:P20003",
  "REGISTRO_CASOS!Q3:S20003",
  "REGISTRO_CASOS!U3:W20003",
  "REGISTRO_CASOS!X3:AA20003",
  "REGISTRO_CASOS!AE3:AE20003",
  "REGISTRO_CASOS!AI3:AN20003",
  "REGISTRO_CASOS!AU3:AU20003"
]);
const LRS_TABULADOR_RANGE = "TABULADOR!A1:Z500";

function doPost(e) {
  try {
    if (e && e.queryString) return payrollBridgeReply_({ ok: false, error: "invalid_request" });
    const postData = e && e.postData;
    const raw = postData && typeof postData.contents === "string" ? postData.contents : "";
    if (!raw || raw.length > LRS_PAYROLL_BRIDGE.maxBodyChars ||
        !/^application\/json(?:\s*;|$)/i.test(String(postData.type || ""))) {
      return payrollBridgeReply_({ ok: false, error: "invalid_request" });
    }

    let request;
    try { request = JSON.parse(raw); } catch (_) { return payrollBridgeReply_({ ok: false, error: "invalid_request" }); }
    if (!request || Object.keys(request).sort().join(",") !== "action,nonce,signature,timestamp" ||
        !LRS_PAYROLL_BRIDGE.actions.includes(request.action) ||
        !Number.isSafeInteger(request.timestamp) ||
        typeof request.nonce !== "string" || !/^[A-Za-z0-9_-]{22,86}$/.test(request.nonce) ||
        typeof request.signature !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(request.signature)) {
      return payrollBridgeReply_({ ok: false, error: "invalid_request" });
    }

    if (!payrollBridgeVerify_(request)) return payrollBridgeReply_({ ok: false, error: "unauthorized" });
    if (!payrollBridgeConsumeNonce_(request.nonce)) return payrollBridgeReply_({ ok: false, error: "replay_or_busy" });

    if (request.action === "payroll.read.v1") {
      const result = payrollBridgeRead_();
      return payrollBridgeReply_({ ok: true, schema: 1, action: request.action, readAt: new Date().toISOString(), rows: result });
    }
    const dashboard = payrollBridgeReadDashboard_();
    return payrollBridgeReply_({ ok: true, schema: 1, action: request.action, readAt: new Date().toISOString(), rows: dashboard.rows, tabCells: dashboard.tabCells });
  } catch (_) {
    // Do not log request bodies, signatures, credentials, cell values, or internal errors.
    return payrollBridgeReply_({ ok: false, error: "read_unavailable" });
  }
}

function payrollBridgeVerify_(request) {
  const secret = PropertiesService.getScriptProperties().getProperty("LRS_PAYROLL_BRIDGE_HMAC_SECRET") || "";
  if (Utilities.newBlob(secret).getBytes().length < 32) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - request.timestamp) > LRS_PAYROLL_BRIDGE.maxClockSkewSeconds) return false;
  const canonical = ["LRS-PAYROLL-HMAC-V1", "POST", request.timestamp, request.nonce, request.action].join("\n");
  const bytes = Utilities.computeHmacSha256Signature(canonical, secret, Utilities.Charset.UTF_8);
  const expected = Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, "");
  return payrollBridgeConstantTimeEqual_(expected, request.signature);
}

function payrollBridgeConstantTimeEqual_(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

function payrollBridgeConsumeNonce_(nonce) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return false;
  try {
    const properties = PropertiesService.getScriptProperties();
    const prefix = LRS_PAYROLL_BRIDGE.noncePrefix;
    const now = Math.floor(Date.now() / 1000);
    const nonceKeys = properties.getKeys().filter(key => key.indexOf(prefix) === 0);
    let active = 0;
    nonceKeys.forEach(key => {
      const expiresAt = Number(properties.getProperty(key));
      if (!Number.isFinite(expiresAt) || expiresAt <= now) properties.deleteProperty(key);
      else active++;
    });
    const key = prefix + nonce;
    if (properties.getProperty(key) || active >= LRS_PAYROLL_BRIDGE.maxActiveNonces) return false;
    properties.setProperty(key, String(now + LRS_PAYROLL_BRIDGE.nonceTtlSeconds));
    return true;
  } finally {
    lock.releaseLock();
  }
}

function payrollBridgeRead_() {
  const properties = PropertiesService.getScriptProperties();
  const sheetId = properties.getProperty("LRS_PAYROLL_SOURCE_SHEET_ID") || "";
  if (!sheetId) throw new Error("configuration_missing");
  const response = Sheets.Spreadsheets.Values.batchGet(sheetId, {
    ranges: LRS_PAYROLL_READ_RANGES.slice(),
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "SERIAL_NUMBER"
  });
  const byRange = new Map((response.valueRanges || []).map(item => [String(item.range || "").replace(/\$/g, ""), item.values || []]));
  const ranges = {
    date: LRS_PAYROLL_READ_RANGES[0], period: LRS_PAYROLL_READ_RANGES[1],
    activity: LRS_PAYROLL_READ_RANGES[2], status: LRS_PAYROLL_READ_RANGES[3],
    crew: LRS_PAYROLL_READ_RANGES[4], amount: LRS_PAYROLL_READ_RANGES[5],
    paid: LRS_PAYROLL_READ_RANGES[6], report: LRS_PAYROLL_READ_RANGES[7],
    project: LRS_PAYROLL_READ_RANGES[8]
  };
  const values = Object.fromEntries(Object.entries(ranges).map(([key, range]) => [key, byRange.get(range) || []]));
  if (Object.values(values).some(rows => rows.length > LRS_PAYROLL_BRIDGE.maxRows &&
      rows.slice(LRS_PAYROLL_BRIDGE.maxRows).some(row => row.some(value => value !== "")))) {
    throw new Error("source_row_limit");
  }
  const count = Math.min(LRS_PAYROLL_BRIDGE.maxRows, Math.max(0, ...Object.values(values).map(rows => rows.length)));
  if (!count) return [];
  const value = (group, index, column) => {
    const row = values[group][index];
    return Array.isArray(row) && column < row.length ? row[column] : "";
  };
  const rows = [];
  for (let i = 0; i < count; i++) {
    const row = {
      date: payrollBridgeDateOnly_(value("date", i, 0)),
      period: value("period", i, 0),
      category: value("period", i, 1),
      client: value("period", i, 2),
      activity: value("activity", i, 0),
      caseName: value("activity", i, 1),
      status: value("status", i, 0),
      tp: value("crew", i, 0),
      ta1: value("crew", i, 1),
      ta2: value("crew", i, 2),
      amountTP: value("amount", i, 0),
      amountTA1: value("amount", i, 1),
      amountTA2: value("amount", i, 2),
      paidTP: value("paid", i, 0),
      paidTA1: value("paid", i, 1),
      paidTA2: value("paid", i, 2),
      report: value("report", i, 0),
      project: value("project", i, 0)
    };
    if (row.date || row.tp || row.ta1 || row.ta2 || row.amountTP !== "" || row.amountTA1 !== "" || row.amountTA2 !== "") rows.push(row);
  }
  return rows;
}

function payrollBridgeReadDashboard_() {
  const properties = PropertiesService.getScriptProperties();
  const sheetId = properties.getProperty("LRS_PAYROLL_SOURCE_SHEET_ID") || "";
  if (!sheetId) throw new Error("configuration_missing");
  const response = Sheets.Spreadsheets.Values.batchGet(sheetId, {
    ranges: LRS_DASHBOARD_READ_RANGES.slice(),
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "SERIAL_NUMBER"
  });
  const byRange = new Map((response.valueRanges || []).map(item => [String(item.range || "").replace(/\$/g, ""), item.values || []]));
  if (LRS_DASHBOARD_READ_RANGES.some(range => {
    const rows = byRange.get(range) || [];
    return rows.length > LRS_PAYROLL_BRIDGE.maxRows &&
      rows.slice(LRS_PAYROLL_BRIDGE.maxRows).some(row => row.some(value => value !== ""));
  })) {
    throw new Error("source_row_limit");
  }
  const groups = [
    ["date", LRS_DASHBOARD_READ_RANGES[0]], ["period", LRS_DASHBOARD_READ_RANGES[1]],
    ["address", LRS_DASHBOARD_READ_RANGES[2]], ["activity", LRS_DASHBOARD_READ_RANGES[3]],
    ["insurance", LRS_DASHBOARD_READ_RANGES[4]], ["status", LRS_DASHBOARD_READ_RANGES[5]],
    ["return", LRS_DASHBOARD_READ_RANGES[6]], ["crew", LRS_DASHBOARD_READ_RANGES[7]],
    ["amount", LRS_DASHBOARD_READ_RANGES[8]], ["subtotal", LRS_DASHBOARD_READ_RANGES[9]],
    ["details", LRS_DASHBOARD_READ_RANGES[10]], ["quality", LRS_DASHBOARD_READ_RANGES[11]]
  ];
  const values = Object.fromEntries(groups.map(([key, range]) => [key, byRange.get(range) || []]));
  const count = Math.min(LRS_PAYROLL_BRIDGE.maxRows, Math.max(0, ...Object.values(values).map(rows => rows.length)));
  const value = (group, index, column) => {
    const row = values[group][index];
    return Array.isArray(row) && column < row.length ? row[column] : "";
  };
  const rows = [];
  for (let i = 0; i < count; i++) {
    const row = {
      date: payrollBridgeDateOnly_(value("date", i, 0)),
      period: value("period", i, 0), category: value("period", i, 1), client: value("period", i, 2),
      address: value("address", i, 0), activity: value("activity", i, 0), caseName: value("activity", i, 1),
      insurer: value("insurance", i, 0), limit: value("insurance", i, 1), report: value("insurance", i, 2),
      prv: value("insurance", i, 3), status: value("status", i, 0), observation: value("return", i, 0),
      returnStatus: value("return", i, 1), returnDate: payrollBridgeDateOnly_(value("return", i, 2)),
      tp: value("crew", i, 0), ta1: value("crew", i, 1), ta2: value("crew", i, 2),
      amountTP: value("amount", i, 0), amountTA1: value("amount", i, 1), amountTA2: value("amount", i, 2),
      amountPRV: value("amount", i, 3), subtotal: value("subtotal", i, 0),
      reportStatus: value("details", i, 0), deliveredDate: payrollBridgeDateOnly_(value("details", i, 1)),
      hours360: value("details", i, 2), inspectionHours: value("details", i, 3), workHours: value("details", i, 4),
      temperatures: value("details", i, 5), quality: value("quality", i, 0)
    };
    if (row.date || row.activity || row.tp || row.ta1 || row.ta2) rows.push(row);
  }
  const tabResponse = Sheets.Spreadsheets.Values.batchGet(sheetId, {
    ranges: [LRS_TABULADOR_RANGE], valueRenderOption: "FORMATTED_VALUE"
  });
  const tabRows = tabResponse.valueRanges?.[0]?.values || [];
  if (tabRows.length > 500 || tabRows.some(row => row.length > 26)) throw new Error("tabulador_row_limit");
  const tabCells = [];
  tabRows.forEach((row, ri) => row.forEach((cell, ci) => {
    const text = String(cell == null ? "" : cell).trim();
    if (text && tabCells.length < 13000) tabCells.push([ri, ci, text.slice(0, 500)]);
  }));
  return { rows, tabCells };
}

function payrollBridgeDateOnly_(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(value * 86400000)).toISOString().slice(0, 10);
  }
  const raw = String(value == null ? "" : value).trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

function payrollBridgeReply_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}
