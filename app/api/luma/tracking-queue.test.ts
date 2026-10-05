import test from "node:test";
import assert from "node:assert/strict";
import { runTrackingBatch } from "./tracking-queue";
function fixture() {
  const states = new Map<string, any>();
  const cached = [
    { id: "message-1", sentAt: "2026-10-01T00:00:00Z", status: "delivered" },
  ];
  const row: any = {
    eventId: "evt-test",
    emailLower: "test@example.com",
    lumaUserId: "usr-test",
    messages: cached,
    status: "delivered",
    requestedAt: null,
    retryCount: 0,
    priority: 20,
    nextCheckAt: new Date(0),
  };
  const database: any = {
    lumaTrackingState: {
      findUnique: async ({ where }) => states.get(where.key),
      findFirst: async () => null,
      deleteMany: async ({ where }) => states.delete(where.key),
      upsert: async ({ where, create, update }) => {
        const old = states.get(where.key);
        states.set(where.key, old ? { ...old, ...update } : create);
      },
      updateMany: async ({ where, data }) => {
        const old = states.get(where.key);
        if (where.owner && old?.owner !== where.owner) return { count: 0 };
        if (where.OR && old?.leaseUntil > new Date()) return { count: 0 };
        states.set(where.key, { ...old, ...data });
        return { count: 1 };
      },
    },
    lumaInviteTracking: {
      findFirst: async () =>
        row.nextCheckAt && row.nextCheckAt <= new Date() ? { ...row } : null,
      updateMany: async ({ data }) => {
        Object.assign(row, data);
        return { count: 1 };
      },
      update: async ({ data }) => {
        Object.assign(row, data);
      },
    },
    lumaEvent: { findUnique: async () => ({ endsAt: null }) },
    $executeRaw: async () => 1,
  };
  return { row, states, database };
}
test("expired credentials pause once, preserving cached data and queued work", async () => {
  const f = fixture();
  let calls = 0;
  const services = {
    database: f.database,
    wait: async () => {},
    client: {
      privateGet: async () => {
        calls++;
        throw Object.assign(new Error("expired"), {
          code: "LUMA_SESSION_INVALID",
          status: 403,
        });
      },
    },
  };
  await assert.rejects(
    runTrackingBatch("test-token", "test", false, undefined, services),
  );
  await assert.rejects(
    runTrackingBatch("test-token", "test", false, undefined, services),
  );
  assert.equal(calls, 1);
  assert.equal(f.row.status, "delivered");
  assert.equal(f.row.messages.length, 1);
  assert.equal(f.row.nextCheckAt.getTime(), 0);
});
test("overlapping callers share one worker lease and fetch once", async () => {
  const f = fixture();
  let calls = 0;
  let release: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finish: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const services = {
    database: f.database,
    wait: async () => {},
    client: {
      privateGet: async () => {
        calls++;
        release();
        await blocked;
        return [
          {
            type: "email-sent",
            id: "timeline-1",
            email: {
              api_id: "message-1",
              email_type: "to-guest--event-invitation",
              sent_at: "2026-10-01T00:00:00Z",
              opened_at: "2026-10-02T00:00:00Z",
            },
          },
        ];
      },
    },
  };
  const first = runTrackingBatch(
    "test-token",
    "first",
    false,
    undefined,
    services,
  );
  await started;
  const second = await runTrackingBatch(
    "test-token",
    "second",
    false,
    undefined,
    services,
  );
  assert.equal(second.busy, true);
  finish();
  await first;
  assert.equal(calls, 1);
  assert.equal(f.row.status, "opened");
  assert.equal(f.row.messages.length, 1);
  assert.equal(f.row.nextCheckAt, null);
});
test("rate limiting retains observations and schedules retry instead of dropping work", async () => {
  const f = fixture();
  let calls = 0;
  await runTrackingBatch("test-token", "test", false, undefined, {
    database: f.database,
    wait: async () => {},
    client: {
      privateGet: async () => {
        calls++;
        throw Object.assign(new Error("limited"), { status: 429 });
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(f.row.status, "delivered");
  assert.equal(f.row.lastError, "RATE_LIMITED");
  assert.ok(f.row.nextCheckAt.getTime() > Date.now() + 59000);
});
test("bulk session expiry preserves the cursor and pauses credentials", async () => {
  const f = fixture();
  const job = { key: "bulk:evt-test", cursor: "resume-here", active: true };
  f.database.lumaTrackingState.findFirst = async () => job;
  const services = {
    database: f.database,
    client: {
      privateGet: async () => {
        throw Object.assign(new Error("expired"), {
          code: "LUMA_SESSION_INVALID",
          status: 403,
        });
      },
    },
  };
  await assert.rejects(
    runTrackingBatch("token", "test", false, undefined, services),
  );
  assert.equal(job.cursor, "resume-here");
  assert.equal(f.row.status, "delivered");
  assert.ok([...f.states.keys()].some((key) => key.startsWith("credential:")));
});
test("bulk rate limit keeps the cursor and applies a shared cooldown", async () => {
  const f = fixture();
  const job: any = {
    key: "bulk:evt-test",
    cursor: "resume-here",
    active: true,
  };
  f.database.lumaTrackingState.findFirst = async () => job;
  f.database.lumaTrackingState.update = async ({ data }) =>
    Object.assign(job, data);
  await assert.rejects(
    runTrackingBatch("token", "test", false, undefined, {
      database: f.database,
      client: {
        privateGet: async () => {
          throw Object.assign(new Error("limited"), { status: 429 });
        },
      },
    }),
  );
  assert.equal(job.cursor, "resume-here");
  assert.equal(job.owner, "RATE_LIMITED");
  assert.ok(job.leaseUntil.getTime() > Date.now() + 59000);
  assert.ok(f.states.get("worker").leaseUntil.getTime() > Date.now() + 59000);
});
