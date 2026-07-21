import assert from "node:assert/strict";
import test from "node:test";
import { filterGuestPayload, guestStatusWhere, parseGuestListQuery, priorEventWhere } from "./guest-query";

test("parses bounded server-side guest query parameters", () => {
  const params = new URLSearchParams({
    guest_status: "new_faces",
    guest_search: "  Ada  ",
    guest_tag: "Founder",
    guest_cursor: "20",
    guest_limit: "500",
  });

  assert.deepEqual(parseGuestListQuery(params), {
    filter: "new_faces",
    search: "Ada",
    tags: ["Founder"],
    cursor: 20,
    pageSize: 100,
    includeSummary: true,
  });
});

test("allows guest pages to reuse an event summary already loaded by the client", () => {
  const params = new URLSearchParams({ guest_summary: "0" });
  assert.equal(parseGuestListQuery(params).includeSummary, false);
});

test("recognizes the to-decide guest filter", () => {
  const params = new URLSearchParams({ guest_status: "to_decide" });
  assert.equal(parseGuestListQuery(params).filter, "to_decide");
  assert.deepEqual(guestStatusWhere("event-1", "to_decide"), {
    OR: [
      { status: "registered" },
      {
        AND: [
          { status: "waitlisted" },
          { OR: [{ operatorDecision: null }, { operatorDecision: { not: "waitlisted" } }] },
        ],
      },
    ],
  });
});

test("to-decide includes pending and automatic waitlist guests only", () => {
  const people = ["pending", "automatic", "manual", "accepted"].map((id) => ({ id, name: id }));
  const result = filterGuestPayload({
    people,
    guests: [
      { personId: "pending", status: "registered" },
      { personId: "automatic", status: "waitlisted", operatorDecision: null },
      { personId: "manual", status: "waitlisted", operatorDecision: "waitlisted" },
      { personId: "accepted", status: "going", operatorDecision: "going" },
    ],
  }, {
    filter: "to_decide",
    search: "",
    tags: [],
    cursor: 0,
    pageSize: 50,
  });

  assert.deepEqual(result.guests.map((guest: any) => guest.personId), ["pending", "automatic"]);
});

test("only treats chronologically earlier events as prior history", () => {
  const startsAt = new Date("2026-07-17T17:00:00.000Z");
  const date = new Date("2026-07-17T00:00:00.000Z");
  const priorEvent = priorEventWhere({ startsAt, date });

  assert.deepEqual(priorEvent, {
    OR: [
      { startsAt: { lt: startsAt } },
      { startsAt: null, date: { lt: date } },
    ],
  });
  assert.deepEqual(guestStatusWhere("event-2", "new_faces", { startsAt, date }), {
    AND: [
      { status: "checked_in" },
      {
        person: {
          is: {
            eventGuests: {
              none: {
                eventId: { not: "event-2" },
                event: { is: priorEvent },
              },
            },
          },
        },
      },
    ],
  });
  assert.deepEqual(guestStatusWhere("event-2", "first_registers", { startsAt, date }), {
    AND: [
      { status: { in: ["going", "checked_in", "no_show"] } },
      {
        person: {
          is: {
            eventGuests: {
              none: {
                eventId: { not: "event-2" },
                event: { is: priorEvent },
              },
            },
          },
        },
      },
    ],
  });
  assert.deepEqual(guestStatusWhere("event-2", "accepted", { startsAt, date }), {
    status: { in: ["going", "checked_in", "no_show"] },
  });
  assert.deepEqual(guestStatusWhere("event-2", "registered", { startsAt, date }), {
    status: { in: ["registered", "waitlisted", "going", "checked_in", "no_show"] },
  });
});

test("limits first registers to accepted guests and new faces to check-ins", () => {
  const payload = {
    eventId: "event-1",
    people: [
      { id: "person-1", name: "Ada Lovelace", email: "ada@example.com" },
      { id: "person-2", name: "Grace Hopper", email: "grace@example.com", tags: ["Speaker"] },
      { id: "person-3", name: "Katherine Johnson", email: "katherine@example.com" },
      { id: "person-4", name: "Dorothy Vaughan", email: "dorothy@example.com" },
      { id: "person-5", name: "Mary Jackson", email: "mary@example.com" },
      { id: "person-6", name: "Annie Easley", email: "annie@example.com" },
      { id: "person-7", name: "Margaret Hamilton", email: "margaret@example.com" },
    ],
    guests: [
      { personId: "person-1", status: "checked_in", isFirstRegistration: true, isNewFace: true },
      { personId: "person-2", status: "going", isFirstRegistration: true, isNewFace: false },
      { personId: "person-3", status: "registered", isFirstRegistration: true, isNewFace: false },
      { personId: "person-4", status: "waitlisted", isFirstRegistration: true, isNewFace: false },
      { personId: "person-5", status: "no_show", isFirstRegistration: false, isNewFace: false },
      { personId: "person-6", status: "invited", isFirstRegistration: false, isNewFace: false },
      { personId: "person-7", status: "declined", isFirstRegistration: true, isNewFace: false },
    ],
  };

  const result = filterGuestPayload(payload, {
    filter: "new_faces",
    search: "ada",
    tags: [],
    cursor: 0,
    pageSize: 50,
  });

  assert.deepEqual(result.guests.map((guest: any) => guest.personId), ["person-1"]);
  assert.equal(result.stats.accepted, 3);
  assert.equal(result.stats.registered, 5);
  assert.equal(result.stats.newFaces, 1);
  assert.equal(result.stats.firstRegisters, 2);
  assert.deepEqual(result.pageInfo, { total: 1, pageSize: 50, hasMore: false, nextCursor: null });

  const firstRegisters = filterGuestPayload(payload, {
    filter: "first_registers",
    search: "",
    tags: [],
    cursor: 0,
    pageSize: 50,
  });
  assert.deepEqual(firstRegisters.guests.map((guest: any) => guest.personId), ["person-1", "person-2"]);

  const accepted = filterGuestPayload(payload, {
    filter: "accepted",
    search: "",
    tags: [],
    cursor: 0,
    pageSize: 50,
  });
  assert.deepEqual(accepted.guests.map((guest: any) => guest.personId), ["person-1", "person-2", "person-5"]);

  const registered = filterGuestPayload(payload, {
    filter: "registered",
    search: "",
    tags: [],
    cursor: 0,
    pageSize: 50,
  });
  assert.deepEqual(registered.guests.map((guest: any) => guest.personId), ["person-1", "person-2", "person-3", "person-4", "person-5"]);
});

test("matches any selected person tag before paginating", () => {
  const payload = {
    people: [
      { id: "person-1", name: "Ada", tags: ["Founder"] },
      { id: "person-2", name: "Grace", tags: ["Speaker"] },
      { id: "person-3", name: "Katherine", tags: ["Investor"] },
    ],
    guests: [
      { personId: "person-1", status: "going" },
      { personId: "person-2", status: "going" },
      { personId: "person-3", status: "going" },
    ],
  };

  const result = filterGuestPayload(payload, {
    filter: "all",
    search: "",
    tags: ["Founder", "Speaker"],
    cursor: 0,
    pageSize: 50,
  });

  assert.deepEqual(result.people.map((person: any) => person.id), ["person-1", "person-2"]);
});
