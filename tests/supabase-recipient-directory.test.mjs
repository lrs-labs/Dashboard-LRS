import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createSupabaseRecipientDirectory } from "../supabase/functions/payroll-api/supabase-snapshot-recipient-store.mjs";

const dbRow = { technician_id: "tech-fixture-1", directory_id: "directory-fixture-1", display_name: "Fixture Tech",
  email: "fixture@example.invalid", active: true, email_verified: true, verified_at: "2026-10-29T12:00:00Z", directory_version: 3 };

test("recipient directory is private, versioned, and technician roster omits email", async () => {
  const calls = [];
  const client = { async rpc(name, args) {
    calls.push({ name, args });
    if (name === "lrs_recipient_directory_get") return { data: dbRow, error: null };
    if (name === "lrs_technician_directory_list") return { data: [{ technician_id: "tech-fixture-1", display_name: "Fixture Tech", active: true }], error: null };
    if (name === "lrs_recipient_directory_upsert") return { data: dbRow, error: null };
    throw new Error("unexpected_rpc");
  } };
  const directory = createSupabaseRecipientDirectory(client);
  assert.deepEqual(await directory.resolve("tech-fixture-1"), { technicianId: "tech-fixture-1", directoryId: "directory-fixture-1",
    displayName: "Fixture Tech", email: "fixture@example.invalid", active: true, verified: true,
    verifiedAt: dbRow.verified_at, directoryVersion: "3" });
  const roster = await directory.listTechnicians();
  assert.deepEqual(roster, [{ technicianId: "tech-fixture-1", displayName: "Fixture Tech", active: true }]);
  assert.equal(JSON.stringify(roster).includes("example.invalid"), false);
  assert.equal((await directory.upsert({ technicianId: "tech-fixture-1", displayName: "Fixture Tech", email: "fixture@example.invalid",
    active: true, verified: true, actorId: "user-fixture" })).directoryVersion, "3");
  assert.deepEqual(calls.map(call => call.name), ["lrs_recipient_directory_get", "lrs_technician_directory_list", "lrs_recipient_directory_upsert"]);
  assert.equal(calls[2].args.p_actor_id, "user-fixture");
});

test("recipient directory rejects invalid emails, missing actor, and database failures", async () => {
  const unused = createSupabaseRecipientDirectory({ async rpc() { throw new Error("must_not_call"); } });
  await assert.rejects(unused.upsert({ technicianId: "t", displayName: "Fixture", email: "bad", active: true, verified: true, actorId: "u" }), /recipient_email_invalid/);
  await assert.rejects(unused.upsert({ technicianId: "t", displayName: "Fixture", email: "t@example.invalid", active: true, verified: true }), /recipient_directory_input_invalid/);
  const failure = createSupabaseRecipientDirectory({ async rpc() { return { data: null, error: { message: "sensitive" } }; } });
  await assert.rejects(failure.resolve("tech-fixture-1"), error => error.message === "private_payroll_state_store_unavailable");
});

test("local migration protects recipient email and grants RPCs only to service role", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20261029061000_snapshot_recipient_calendar.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS private\.technician_recipients/);
  assert.match(sql, /CREATE POLICY technician_recipients_deny_clients[\s\S]+USING \(false\) WITH CHECK \(false\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.lrs_recipient_directory_get\(text\) FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.lrs_recipient_directory_get\(text\) TO service_role/);
  assert.match(sql, /directory_version = current_recipient\.directory_version \+ CASE WHEN/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS private\.payroll_closed_snapshots[\s\S]+period_key text PRIMARY KEY/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS private\.payroll_technicians/);
  assert.match(sql, /lrs_payroll_technician_roster_list\(\)[\s\S]+WHERE active = true/);
  assert.match(sql, /lrs_assignment_identity_find_many\(uuid\[\]\)/);
  assert.match(sql, /workflow_jobs_one_unresolved_drive_per_tech_period/);
  assert.match(sql, /lrs_workflow_job_claim_expired_queued/);
  assert.match(sql, /ON CONFLICT \(period_key\) DO NOTHING/);
});
