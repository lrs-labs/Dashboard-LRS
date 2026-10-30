import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateSessionLease, MAX_PRIVATE_SESSION_AGE_MS, PRIVATE_SESSION_STARTED_AT_KEY } from "../session-lease.mjs";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}

test("private session lease survives token refreshes and expires at a fixed eight-hour deadline", () => {
  let now = 10_000;
  const scheduled = [];
  const storage = memoryStorage();
  const lease = createPrivateSessionLease({ storage, now: () => now, maxAgeMs: 1_000,
    schedule: (callback, delay) => { const entry = { callback, delay, canceled: false }; scheduled.push(entry); return entry; },
    cancel: entry => { entry.canceled = true; } });
  assert.equal(lease.begin().ok, true);
  now += 600;
  const refreshed = lease.begin();
  assert.equal(refreshed.startedAt, 10_000);
  assert.equal(refreshed.expiresAt, 11_000);
  assert.equal(scheduled.at(-1).delay, 400);
  assert.equal(lease.getStartedAt(), 10_000);
  now = 11_000;
  assert.equal(lease.begin().reason, "session_expired");
  assert.equal(lease.getStartedAt(), null);
  assert.equal(MAX_PRIVATE_SESSION_AGE_MS, 8 * 60 * 60 * 1000);
});

test("a fresh sign-in resets the lease and expiration callback clears the marker", () => {
  let now = 20_000, expired = 0;
  let task;
  const storage = memoryStorage();
  const lease = createPrivateSessionLease({ storage, now: () => now, maxAgeMs: 500, onExpire: () => { expired++; },
    schedule: (callback, delay) => { task = { callback, delay }; return task; }, cancel: () => {} });
  lease.begin();
  now += 200;
  const next = lease.begin({ newAuthentication: true });
  assert.equal(next.startedAt, 20_200);
  assert.equal(task.delay, 500);
  task.callback();
  assert.equal(expired, 1);
  assert.equal(storage.getItem(PRIVATE_SESSION_STARTED_AT_KEY), null);
});

test("a storage failure prevents establishing a private lease", () => {
  const storage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() {} };
  const lease = createPrivateSessionLease({ storage, now: () => 25_000, schedule: () => 1 });
  assert.deepEqual(lease.begin(), { ok: false, reason: "lease_storage_unavailable" });
});
