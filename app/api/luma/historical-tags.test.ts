import assert from "node:assert/strict";
import test from "node:test";
import { parsePeopleSearchQuery } from "../search/people/query";
import { buildPeopleSearchUrlSearch, parsePeopleSearchUrl } from "../../people-search-url";
import { buildWorkspaceUrlSearch, guestsPageUrlSearch, parseWorkspaceUrl } from "../../workspace-url";
import { parseAllMatchingGuestQuery } from "./all-matching-guest-selection";
import { filterGuestPayload, guestQueryRequiresIndex, parseGuestListQuery } from "./guest-query";

test("historical manual tag filters survive people and event shared URLs independently", () => {
  const search = "people=1&people_tag=VIP&people_tag_scope=ever&event=event-1&guest_tag=Host&guest_tag_not=Skip&guest_tag_scope=ever";
  const people = parsePeopleSearchUrl(search);
  const event = parseWorkspaceUrl(search);
  assert.equal(people.filters.tagScope, "ever");
  assert.equal(event.guestTagScope, "ever");
  const updated = buildWorkspaceUrlSearch(buildPeopleSearchUrlSearch(search, people), event);
  assert.deepEqual(parsePeopleSearchUrl(updated), people);
  assert.deepEqual(parseWorkspaceUrl(updated), event);
  assert.equal(new URLSearchParams(guestsPageUrlSearch(updated)).has("guest_tag_scope"), false);
  assert.equal(new URLSearchParams(guestsPageUrlSearch(updated)).get("people_tag_scope"), "ever");
  assert.equal(new URLSearchParams(buildPeopleSearchUrlSearch(updated, { ...people, open: false })).has("people_tag_scope"), false);
});

test("history is opt-in, including for filter-only people searches and all-matching actions", () => {
  const people = parsePeopleSearchQuery(new URLSearchParams("tag=VIP&tag_scope=ever&tag_mode=all&exclude_tag=Skip&offset=20"));
  assert.equal(people.tagScope, "ever");
  assert.equal(people.hasFilters, true);
  assert.equal(people.offset, 20);
  assert.equal(parsePeopleSearchQuery(new URLSearchParams("tag_scope=invalid")).tagScope, "current");
  assert.equal(parseGuestListQuery(new URLSearchParams("guest_tag_scope=invalid")).tagScope, "current");
  const selected = parseAllMatchingGuestQuery({
    guestStatus: "all", guestTags: ["VIP", "Host"], guestTagMode: "all", guestTagScope: "ever", guestExcludedTags: ["Skip"],
  });
  assert.equal(selected.tagScope, "ever");
  assert.equal(selected.tagMode, "all");
  assert.deepEqual(selected.excludedTags, ["Skip"]);
  assert.throws(() => parseAllMatchingGuestQuery({ guestStatus: "all", guestTagScope: "invalid" }), /current or ever/);
});

test("historical queries require indexed history and cannot silently use current-tag snapshots", () => {
  const query = parseGuestListQuery(new URLSearchParams("guest_tag=VIP&guest_tag_scope=ever&guest_tag_not=Skip"));
  assert.equal(guestQueryRequiresIndex(query), true);
  assert.throws(() => filterGuestPayload({ people: [], guests: [] }, query), /require the Luma index/);
});
