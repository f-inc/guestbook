import assert from "node:assert/strict";
import test from "node:test";
import { eventGuestWhere, filterGuestPayload, guestFilterRequiresIndex, guestQueryRequiresIndex, guestStatusWhere, isRegisteredGuest, parseGuestListQuery, priorEventWhere } from "./guest-query";

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
    filters: ["new_faces"],
    filterMode: "any",
    excludedFilters: [],
    search: "Ada",
    tags: ["Founder"],
    tagMode: "any",
    excludedTags: [],
    sortBy: "status_date",
    sortDirection: "desc",
    cursor: 20,
    pageSize: 100,
    includeSummary: true,
  });
});

test("supports multiple included statuses, ALL matching, and excluded statuses", () => {
  const query = parseGuestListQuery(new URLSearchParams([
    ["guest_status", "accepted"],
    ["guest_status", "checked_in"],
    ["guest_status_mode", "all"],
    ["guest_status_not", "no_show"],
  ]));
  const result = filterGuestPayload({
    people: [
      { id: "checked", tags: [] },
      { id: "going", tags: [] },
      { id: "no-show", tags: [] },
    ],
    guests: [
      { personId: "checked", status: "checked_in" },
      { personId: "going", status: "going" },
      { personId: "no-show", status: "no_show" },
    ],
  }, query);

  assert.deepEqual(query.filters, ["accepted", "checked_in"]);
  assert.equal(query.filterMode, "all");
  assert.deepEqual(query.excludedFilters, ["no_show"]);
  assert.deepEqual(result.people.map((person) => person.id), ["checked"]);
});

test("supports ALL included tags and excludes guests with any blocked tag", () => {
  const query = parseGuestListQuery(new URLSearchParams([
    ["guest_tag", "Builder"],
    ["guest_tag", "Referred"],
    ["guest_tag_mode", "all"],
    ["guest_tag_not", "Flaker"],
  ]));
  const result = filterGuestPayload({
    people: [
      { id: "match", tags: ["Builder", "Referred"] },
      { id: "missing", tags: ["Builder"] },
      { id: "blocked", tags: ["Builder", "Referred", "Flaker"] },
    ],
    guests: [
      { personId: "match", status: "going" },
      { personId: "missing", status: "going" },
      { personId: "blocked", status: "going" },
    ],
  }, query);

  assert.equal(query.tagMode, "all");
  assert.deepEqual(query.excludedTags, ["Flaker"]);
  assert.deepEqual(result.people.map((person) => person.id), ["match"]);
});

test("parses ascending guest date order through the indexed query", () => {
  const query = parseGuestListQuery(new URLSearchParams({ guest_sort: "asc" }));
  assert.equal(query.sortDirection, "asc");
  assert.equal(guestQueryRequiresIndex(query), true);
});

test("parses EA and ER sorting through the indexed guest query", () => {
  const attended = parseGuestListQuery(new URLSearchParams({
    guest_sort_by: "events_attended",
    guest_sort: "asc",
  }));
  assert.equal(attended.sortBy, "events_attended");
  assert.equal(attended.sortDirection, "asc");
  assert.equal(guestQueryRequiresIndex(attended), true);

  const registered = parseGuestListQuery(new URLSearchParams({
    guest_sort_by: "events_registered",
    guest_sort: "desc",
  }));
  assert.equal(registered.sortBy, "events_registered");
  assert.equal(registered.sortDirection, "desc");
  assert.equal(guestQueryRequiresIndex(registered), true);
});

test("allows guest pages to reuse an event summary already loaded by the client", () => {
  const params = new URLSearchParams({ guest_summary: "0" });
  assert.equal(parseGuestListQuery(params).includeSummary, false);
});

test("parses note and lifetime attendance filters through the indexed query", () => {
  const query = parseGuestListQuery(new URLSearchParams({
    guest_has_notes: "1",
    guest_attended_gt: "3",
  }));
  assert.equal(query.hasNotes, true);
  assert.equal(query.attendedGreaterThan, 3);
  assert.equal(guestQueryRequiresIndex(query), true);
});

test("filters guests with comments through the comment relation", () => {
  const query = parseGuestListQuery(new URLSearchParams({ guest_has_notes: "1" }));
  assert.deepEqual(eventGuestWhere("event-1", query), {
    eventId: "event-1",
    AND: [{ person: { is: { comments: { some: {} } } } }],
  });
});

test("preserves a complete cached summary and omits it when the client already has it", () => {
  const stats = {
    registered: 88,
    checkedIn: 33,
    invitationTotal: 57,
    invitedReferralTotal: 9,
  };
  const payload = {
    people: [{ id: "person-1", name: "Ada" }],
    guests: [{ personId: "person-1", status: "checked_in" }],
    stats,
    analyticsQuestions: [{ id: "question-1" }],
  };
  const query = {
    filter: "all" as const,
    search: "",
    tags: [],
    cursor: 0,
    pageSize: 50,
  };

  const withSummary = filterGuestPayload(payload, query);
  assert.deepEqual(withSummary.stats, stats);
  assert.deepEqual(withSummary.analyticsQuestions, payload.analyticsQuestions);

  const withoutSummary = filterGuestPayload(payload, { ...query, includeSummary: false });
  assert.equal("stats" in withoutSummary, false);
  assert.equal("analyticsQuestions" in withoutSummary, false);
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

test("recognizes the new-referrals guest filter", () => {
  const params = new URLSearchParams({ guest_status: "new_referrals" });
  assert.equal(parseGuestListQuery(params).filter, "new_referrals");
});

test("routes referral cohorts through the indexed guest query", () => {
  for (const filter of [
    "referrals",
    "new_referrals",
    "invited_referrals",
    "invited_referral_no_response",
    "invited_referral_accepted",
    "invited_referral_declined",
  ] as const) {
    assert.equal(guestFilterRequiresIndex(filter), true);
  }
  assert.equal(guestFilterRequiresIndex("registered"), false);
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
      {
        OR: [
          { status: { in: ["registered", "waitlisted", "going", "checked_in", "no_show"] } },
          { status: "declined", registeredAt: { not: null } },
        ],
      },
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
  assert.deepEqual(guestStatusWhere("event-2", "accepted_first_registers", { startsAt, date }), {
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
    OR: [
      { status: { in: ["registered", "waitlisted", "going", "checked_in", "no_show"] } },
      { status: "declined", registeredAt: { not: null } },
    ],
  });
  assert.deepEqual(guestStatusWhere("event-2", "invited", { startsAt, date }), {
    OR: [{ invitedAt: { not: null } }, { status: "invited" }],
  });
});

test("counts declined registrations but excludes declined invitations", () => {
  assert.equal(isRegisteredGuest({
    status: "declined",
    registeredAt: "2026-07-24T18:00:00.000Z",
    invitedAt: null,
  }), true);
  assert.equal(isRegisteredGuest({
    status: "declined",
    registeredAt: null,
    invitedAt: "2026-07-20T18:00:00.000Z",
  }), false);

  const result = filterGuestPayload({
    people: [
      { id: "registered-decline", name: "Registered decline" },
      { id: "invited-decline", name: "Invited decline" },
    ],
    guests: [
      { personId: "registered-decline", status: "declined", registeredAt: "2026-07-24T18:00:00.000Z" },
      { personId: "invited-decline", status: "declined", invitedAt: "2026-07-20T18:00:00.000Z" },
    ],
  }, {
    filter: "registered",
    search: "",
    tags: [],
    cursor: 0,
    pageSize: 50,
  });

  assert.deepEqual(result.guests.map((guest: any) => guest.personId), ["registered-decline"]);
  assert.equal(result.stats.registered, 1);
  assert.equal(result.stats.declined, 2);
});

test("separates new registrations from accepted first registers and new faces", () => {
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
      { personId: "person-2", status: "going", invitedAt: "2026-07-01T00:00:00.000Z", isFirstRegistration: true, isNewFace: false },
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
  assert.equal(result.stats.invited, 2);
  assert.equal(result.stats.newFaces, 1);
  assert.equal(result.stats.firstRegisters, 2);
  assert.equal(result.stats.newRegistrations, 4);
  assert.deepEqual(result.pageInfo, { total: 1, pageSize: 50, hasMore: false, nextCursor: null });

  const firstRegisters = filterGuestPayload(payload, {
    filter: "first_registers",
    search: "",
    tags: [],
    cursor: 0,
    pageSize: 50,
  });
  assert.deepEqual(firstRegisters.guests.map((guest: any) => guest.personId), ["person-1", "person-2", "person-3", "person-4"]);

  const acceptedFirstRegisters = filterGuestPayload(payload, {
    filter: "accepted_first_registers",
    search: "",
    tags: [],
    cursor: 0,
    pageSize: 50,
  });
  assert.deepEqual(acceptedFirstRegisters.guests.map((guest: any) => guest.personId), ["person-1", "person-2"]);

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

  const invited = filterGuestPayload(payload, {
    filter: "invited",
    search: "",
    tags: [],
    cursor: 0,
    pageSize: 50,
  });
  assert.deepEqual(invited.guests.map((guest: any) => guest.personId), ["person-2", "person-6"]);
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

test("filters exact invitation and referral funnel cohorts", () => {
  const payload = {
    people: ["going", "checked", "pending", "no-show", "declined", "organic-going", "organic"].map((id) => ({ id, name: id })),
    guests: [
      { personId: "going", status: "going", invitedAt: "2026-07-01T00:00:00.000Z", isReferred: true },
      { personId: "checked", status: "checked_in", invitedAt: "2026-07-01T00:00:00.000Z", checkedInAt: "2026-07-21T18:00:00.000Z", isReferred: true },
      { personId: "pending", status: "invited", isReferred: true },
      { personId: "no-show", status: "no_show", invitedAt: "2026-07-01T00:00:00.000Z", isReferred: false },
      { personId: "declined", status: "declined", invitedAt: "2026-07-01T00:00:00.000Z", isReferred: true },
      { personId: "organic-going", status: "going", isReferred: false },
      { personId: "organic", status: "checked_in", isReferred: true },
    ],
  };
  const matchingIds = (filter: any) => filterGuestPayload(payload, {
    filter,
    search: "",
    tags: [],
    cursor: 0,
    pageSize: 50,
  }).guests.map((guest: any) => guest.personId);

  assert.deepEqual(matchingIds("invited"), ["going", "checked", "no-show", "pending", "declined"]);
  assert.deepEqual(matchingIds("invited_no_response"), ["pending"]);
  assert.deepEqual(matchingIds("invited_accepted"), ["going", "checked", "no-show", "organic-going", "organic"]);
  assert.deepEqual(matchingIds("invited_going"), ["going", "organic-going"]);
  assert.deepEqual(matchingIds("invited_checked_in"), ["checked", "organic"]);
  assert.deepEqual(matchingIds("invited_no_show"), ["no-show"]);
  assert.deepEqual(matchingIds("invited_declined"), ["declined"]);
  assert.deepEqual(matchingIds("referrals"), ["checked", "organic"]);
  assert.deepEqual(matchingIds("invited_referrals"), ["going", "checked", "pending", "declined"]);
  assert.deepEqual(matchingIds("invited_referral_no_response"), ["pending"]);
  assert.deepEqual(matchingIds("invited_referral_accepted"), ["going", "checked", "organic"]);
  assert.deepEqual(matchingIds("invited_referral_declined"), ["declined"]);
});

test("keeps historical active referrals in totals without marking them new", () => {
  const payload = {
    people: ["historical", "new", "not-referred"].map((id) => ({ id, name: id })),
    guests: [
      { personId: "historical", status: "checked_in", isReferred: true, isNewReferral: false },
      { personId: "new", status: "checked_in", isReferred: true, isNewReferral: true },
      { personId: "not-referred", status: "checked_in", isReferred: false, isNewReferral: false },
    ],
  };
  const matchingIds = (filter: any) => filterGuestPayload(payload, {
    filter,
    search: "",
    tags: [],
    cursor: 0,
    pageSize: 50,
  }).guests.map((guest: any) => guest.personId);

  assert.deepEqual(matchingIds("referrals"), ["historical", "new"]);
  assert.deepEqual(matchingIds("new_referrals"), ["new"]);
});
