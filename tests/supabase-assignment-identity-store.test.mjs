import test from "node:test";
import assert from "node:assert/strict";
import { createSupabaseAssignmentIdentityStore } from "../supabase/functions/payroll-api/supabase-assignment-identity-store.mjs";

test("assignment identity storage sends only hashes and opaque IDs through private RPCs", async () => {
  const calls = [];
  const identity = { identity_key_sha256: "a".repeat(64), assignment_id: "018f47a2-13a4-7b2c-8d2a-000000000001",
    source_fingerprint_sha256: "b".repeat(64), state: "pending_review" };
  const client = { async rpc(name, args) {
    calls.push({ name, args });
    if (name === "lrs_assignment_identity_get") return { data: identity, error: null };
    if (name === "lrs_assignment_identity_insert_pending") return { data: true, error: null };
    if (name === "lrs_assignment_identity_verify") return { data: { ...identity, state: "verified", verified_by: "user-fixture" }, error: null };
    if (name === "lrs_assignment_identity_revoke") return { data: true, error: null };
    throw new Error("unexpected_rpc");
  } };
  const store = createSupabaseAssignmentIdentityStore(client);
  assert.deepEqual(await store.findByIdentityHash(identity.identity_key_sha256), {
    state: "pending_review", assignmentId: identity.assignment_id, identityKeyHash: identity.identity_key_sha256, sourceFingerprintHash: identity.source_fingerprint_sha256
  });
  assert.deepEqual(await store.createPending({ identityKeyHash: "c".repeat(64), assignmentId: identity.assignment_id, sourceFingerprintHash: "d".repeat(64) }), { inserted: true });
  assert.equal((await store.verifyPending({ identityKeyHash: "a".repeat(64), sourceFingerprintHash: "b".repeat(64), actorId: "user-fixture" })).state, "verified");
  assert.equal(await store.revoke({ identityKeyHash: "a".repeat(64), actorId: "user-fixture" }), true);
  assert.deepEqual(calls.map(call => call.name), ["lrs_assignment_identity_get", "lrs_assignment_identity_insert_pending", "lrs_assignment_identity_verify", "lrs_assignment_identity_revoke"]);
  assert.equal(JSON.stringify(calls).includes("Fixture Tech"), false);
  assert.equal(JSON.stringify(calls).includes("example.invalid"), false);
  assert.deepEqual(Object.keys(calls[1].args).sort(), ["p_assignment_id", "p_identity_key_sha256", "p_source_fingerprint_sha256"]);
  assert.deepEqual(calls[3].args, { p_identity_key_sha256: "a".repeat(64), p_actor_id: "user-fixture" });
});

test("assignment identity adapter hides database details and treats conflicts as review", async () => {
  const errorStore = createSupabaseAssignmentIdentityStore({ async rpc() { return { data: null, error: { message: "sensitive database detail" } }; } });
  await assert.rejects(errorStore.findByIdentityHash("a".repeat(64)), error => {
    assert.equal(error.message, "assignment_identity_store_unavailable");
    return true;
  });
  const conflictStore = createSupabaseAssignmentIdentityStore({ async rpc() { return { data: false, error: null }; } });
  assert.deepEqual(await conflictStore.createPending({ identityKeyHash: "a".repeat(64), assignmentId: "018f47a2-13a4-7b2c-8d2a-000000000001", sourceFingerprintHash: "b".repeat(64) }), { conflict: true });
});
