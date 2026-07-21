import assert from "node:assert/strict";
import test from "node:test";
import { filterGuestPayload, parseGuestListQuery } from "./guest-query";

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
  });
});

test("filters, searches, and paginates a live fallback payload", () => {
  const payload = {
    eventId: "event-1",
    people: [
      { id: "person-1", name: "Ada Lovelace", email: "ada@example.com" },
      { id: "person-2", name: "Grace Hopper", email: "grace@example.com", tags: ["Speaker"] },
    ],
    guests: [
      { personId: "person-1", status: "registered", isNewFace: true },
      { personId: "person-2", status: "going", isNewFace: false },
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
  assert.equal(result.stats.accepted, 1);
  assert.equal(result.stats.newFaces, 1);
  assert.deepEqual(result.pageInfo, { total: 1, pageSize: 50, hasMore: false, nextCursor: null });
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
