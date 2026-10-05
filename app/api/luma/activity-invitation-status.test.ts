import test from "node:test";
import assert from "node:assert/strict";
import { withActivityInvitationStatuses } from "./activity-invitation-status";

test("activity uses event-specific invitation outcomes, not unrelated email failures", async () => {
  let query: any;
  const db = { lumaInviteTracking: { findMany: async (args: any) => {
    query = args;
    return [
      { eventId: "evt-one", status: "bounced" },
      { eventId: "evt-two", status: "opened", issueReason: "bounced" },
    ];
  } } };
  const payload = { records: [
    { eventId: "evt-one", status: "invited" },
    { eventId: "evt-two", status: "going" },
    { eventId: "evt-three", status: "invited" },
  ] };
  const result = await withActivityInvitationStatuses(db, payload, "usr-one", " Person@Example.com ");
  assert.equal(query.where.emailLower, "person@example.com");
  assert.deepEqual(query.where.eventId.in, ["evt-one", "evt-two", "evt-three"]);
  assert.equal(result.records[0].invitationStatus, "bounced");
  assert.equal(result.records[1].invitationStatus, "opened");
  assert.equal(result.records[1].status, "going");
  assert.equal(result.records[2].invitationStatus, null);
  assert.equal(payload.records[0].status, "invited");
});

test("cached activity receives fresh tracking outcomes and supports ID-only lookup", async () => {
  let status = "sent";
  const db = { lumaInviteTracking: { findMany: async (query: any) => {
    assert.deepEqual(query.where.OR, [{ personId: "usr-one" }, { lumaUserId: "usr-one" }]);
    return [{ eventId: "evt-one", status }];
  } } };
  const payload = { records: [{ eventId: "evt-one", status: "invited" }] };
  assert.equal((await withActivityInvitationStatuses(db, payload, "usr-one")).records[0].invitationStatus, "sent");
  status = "bounced";
  assert.equal((await withActivityInvitationStatuses(db, payload, "usr-one")).records[0].invitationStatus, "bounced");
});

test("empty activity does not query tracking", async () => {
  const payload = { records: [] };
  assert.equal(await withActivityInvitationStatuses({}, payload, "usr-one"), payload);
});
