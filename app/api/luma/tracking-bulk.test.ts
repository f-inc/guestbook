import test from "node:test";
import assert from "node:assert/strict";
import {
  bulkInvitationStatus,
  parseInvitationPage,
} from "../../invite-tracking";
import { fetchBulkPage } from "./tracking-bulk";
const invite = {
  id: "evinv-one",
  createdAt: "2026-09-30T03:57:41.810Z",
  openedAt: "2026-09-30T03:57:47.176Z",
};
test("bulk opens never manufacture email IDs or delivery evidence", () => {
  const page = parseInvitationPage({
    entries: [
      {
        object: "event_invite",
        api_id: invite.id,
        created_at: invite.createdAt,
        opened_at: invite.openedAt,
        email: " TEST@example.com ",
        rsvp: {
          approval_status: "invited",
          user_api_id: "usr-one",
          api_id: "gst-one",
        },
      },
    ],
    has_more: false,
  });
  assert.equal(page.entries[0].emailLower, "test@example.com");
  assert.equal(page.entries[0].userId, "usr-one");
  assert.equal(bulkInvitationStatus(null, page.entries[0]), "opened");
  assert.equal(
    bulkInvitationStatus(null, { ...invite, openedAt: null }),
    "invited",
  );
  assert.equal("deliveredAt" in page.entries[0], false);
});
test("new sends and stronger timeline evidence survive bulk refresh", () => {
  assert.equal(
    bulkInvitationStatus(
      { requestedAt: "2026-10-01", status: "processing" },
      invite,
    ),
    "processing",
  );
  for (const status of ["clicked", "bounced", "reported"]) {
    assert.equal(
      bulkInvitationStatus(
        { messages: [{ sentAt: invite.createdAt, status }] },
        invite,
      ),
      status,
    );
  }
  assert.equal(
    bulkInvitationStatus(
      { messages: [{ sentAt: "2026-09-01", status: "bounced" }] },
      invite,
    ),
    "opened",
  );
});
test("malformed pagination is not mistaken for completion", () => {
  assert.throws(() => parseInvitationPage({ entries: [], has_more: true }));
  assert.throws(() => parseInvitationPage({ entries: [{}], has_more: false }));
});
test("one page persists twenty records, with no timelines, and commits cursor with observations", async () => {
  const rows = new Map();
  let state: any;
  const database: any = {
    lumaEventGuest: { findMany: async () => [] },
    lumaEvent: { findUnique: async () => ({ title: "Example", endsAt: null }) },
    lumaInviteTracking: {
      findMany: async () => [...rows.values()],
      findUnique: async ({ where }) =>
        rows.get(where.eventId_emailLower.emailLower),
      createMany: async ({ data }) => {
        for (const row of data) rows.set(row.emailLower, row);
      },
      updateMany: async ({ where, data }) =>
        Object.assign(rows.get(where.emailLower), data),
    },
    lumaTrackingState: {
      update: async ({ data }) => {
        state = data;
      },
    },
    $transaction: async (fn) => fn(database),
  };
  let calls = 0;
  const client = {
    privateGet: async ({ path, params }) => {
      calls++;
      assert.equal(path, "/event/admin/get-invites");
      assert.equal(params.pagination_limit, 20);
      assert.equal(params.pagination_cursor, "previous");
      return {
        entries: Array.from({ length: 20 }, (_, n) => ({
          object: "event_invite",
          api_id: `evinv-${n}`,
          email: `test${n}@example.com`,
          created_at: invite.createdAt,
          opened_at: n % 2 ? invite.openedAt : null,
        })),
        has_more: true,
        next_cursor: "next",
      };
    },
  };
  assert.equal(
    await fetchBulkPage(
      { key: "bulk:evt-one", cursor: "previous" },
      client,
      "test",
      "test",
      database,
    ),
    20,
  );
  assert.equal(calls, 1);
  assert.equal(rows.size, 20);
  assert.equal(
    [...rows.values()].filter((r) => r.status === "opened").length,
    10,
  );
  assert.ok([...rows.values()].every((r) => r.nextCheckAt === null));
  assert.equal(state.cursor, "next");
  assert.equal(state.active, true);
});
test("repeated cursors fail before writes", async () => {
  const client = {
    privateGet: async () => ({
      entries: [],
      has_more: true,
      next_cursor: "same",
    }),
  };
  await assert.rejects(
    fetchBulkPage(
      { key: "bulk:evt-one", cursor: "same" },
      client,
      "test",
      "test",
      {},
    ),
    /did not advance/,
  );
});

test("indexed invite times are not mistaken for a new send, and old opens cannot describe a reinvite", () => {
  assert.equal(
    bulkInvitationStatus(
      { requestedAt: "2026-09-30T03:57:42Z", status: "unknown" },
      { ...invite, openedAt: null },
    ),
    "invited",
  );
  assert.equal(
    bulkInvitationStatus(
      { messages: [{ sentAt: "2026-10-01T00:00:00Z", status: "delivered" }] },
      invite,
    ),
    "delivered",
  );
});
