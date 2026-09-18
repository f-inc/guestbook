import assert from "node:assert/strict";
import test from "node:test";
import { buildPeopleSearchUrlSearch, parsePeopleSearchUrl } from "../../people-search-url";
import { buildWorkspaceUrlSearch, parseWorkspaceUrl } from "../../workspace-url";

test("restores the people modal with search, tag rules, and comments", () => {
  const state = {
    open: true,
    query: "Alex & Ada",
    filters: {
      includedTags: ["💎 Referred", "Reliable"],
      excludedTags: ["Skip"],
      tagMode: "all" as const,
      comments: "without" as const,
    },
  };
  const search = buildPeopleSearchUrlSearch("?event=evt-1&guest_tag=VIP&debug=1", state);
  assert.deepEqual(parsePeopleSearchUrl(search), state);
  const params = new URLSearchParams(search);
  assert.equal(params.get("event"), "evt-1");
  assert.equal(params.get("guest_tag"), "VIP");
  assert.equal(params.get("debug"), "1");
  assert.deepEqual(parsePeopleSearchUrl(buildWorkspaceUrlSearch(search, parseWorkspaceUrl(search))), state);
});

test("supports opening people with no event and clearing filters while staying open", () => {
  const state = parsePeopleSearchUrl("?people=1");
  assert.equal(buildPeopleSearchUrlSearch("?people=1&people_tag=Referred&people_comments=with", state), "people=1");
  assert.equal(parsePeopleSearchUrl("?people=1&people_comments=with").filters.comments, "with");
});

test("closing removes all people parameters and preserves event navigation", () => {
  const search = "event=evt-1&people=1&people_search=Ada&people_tag=Referred&people_tag_not=Skip&people_tag_mode=all&people_comments=with";
  assert.equal(buildPeopleSearchUrlSearch(search, { ...parsePeopleSearchUrl(search), open: false }), "event=evt-1");
});

test("defaults and bounds malformed shared filters", () => {
  const state = parsePeopleSearchUrl(`?people=no&people_tag=A&people_tag=A&people_tag=&people_comments=bad&people_tag_mode=bad&people_search=${"a".repeat(200)}`);
  assert.equal(state.open, false);
  assert.equal(state.query.length, 120);
  assert.deepEqual(state.filters, { includedTags: ["A"], excludedTags: [], tagMode: "any", comments: "any" });
});
