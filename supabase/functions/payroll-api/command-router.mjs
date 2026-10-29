import { authorizeDashboardRead, authorizePayrollRead } from "./policy.mjs";

const READ_ONLY_FIELDS = Object.freeze({ "payroll.read": ["action"], "dashboard.read": ["action"] });
const WORKFLOW_ACTIONS = new Set(["invoice.archive", "invoice.retry-preview", "invoice.send-confirm", "invoice.retry-confirm"]);

export function classifyPayrollCommand(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.action !== "string") return { ok: false, reason: "invalid_request" };
  if (READ_ONLY_FIELDS[body.action]) {
    if (Object.keys(body).some(key => !READ_ONLY_FIELDS[body.action].includes(key))) return { ok: false, reason: "invalid_request" };
    return { ok: true, kind: "read", action: body.action };
  }
  if (WORKFLOW_ACTIONS.has(body.action)) return { ok: true, kind: "workflow", action: body.action };
  return { ok: false, reason: "invalid_request" };
}

export async function dispatchPayrollCommand({ body, access, actorId, workflow, readPayroll, readDashboard } = {}) {
  const command = classifyPayrollCommand(body);
  if (!command.ok) return { status: 400, body: { error: command.reason } };
  if (command.kind === "workflow") {
    if (typeof workflow !== "function") return { status: 503, body: { error: "payroll_workflows_not_configured" } };
    const result = await workflow({ body, access, actorId });
    if (!result || !Number.isInteger(result.status) || !result.body || typeof result.body !== "object") {
      return { status: 503, body: { error: "payroll_workflow_unavailable" } };
    }
    return result;
  }
  if (command.action === "payroll.read") {
    const authorization = authorizePayrollRead(access);
    if (!authorization.ok) return { status: 403, body: { error: authorization.reason } };
    if (typeof readPayroll !== "function") return { status: 503, body: { error: "payroll_read_unavailable" } };
    return { status: 200, body: { schema: 1, ...(await readPayroll()) } };
  }
  const authorization = authorizeDashboardRead(access);
  if (!authorization.ok) return { status: 403, body: { error: authorization.reason } };
  if (typeof readDashboard !== "function") return { status: 503, body: { error: "dashboard_read_unavailable" } };
  return { status: 200, body: { schema: 1, ...(await readDashboard()) } };
}
