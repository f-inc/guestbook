import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkspaceUrlSearch, parseWorkspaceUrl } from "../../workspace-url";

test("parses workspace navigation state from the URL", () => {
  assert.deepEqual(parseWorkspaceUrl("?event=evt-1&event_view=past&tab=analytics&guest_status=accepted&guest_search=ada&guest_tag=VIP&guest_tag=Builder&guest_page=3&profile=person-2"), {
    eventId: "evt-1",
    eventView: "past",
    eventSearch: "",
    tab: "analytics",
    guestStatus: "accepted",
    guestSearch: "ada",
    guestTags: ["VIP", "Builder"],
    guestPage: 3,
    profileId: "person-2",
  });
});

test("serializes non-default workspace state and preserves unrelated params", () => {
  const search = buildWorkspaceUrlSearch("?debug=1&event=old", {
    eventId: "evt-2",
    eventView: "all",
    eventSearch: "campus",
    tab: "overview",
    guestStatus: "all",
    guestSearch: "",
    guestTags: [],
    guestPage: 2,
    profileId: "person-3",
  });

  assert.equal(search, "debug=1&event=evt-2&event_view=all&event_search=campus&guest_page=2&profile=person-3");
});

test("falls back from invalid URL values", () => {
  const state = parseWorkspaceUrl("?event_view=nope&tab=nope&guest_status=nope&guest_page=-9");
  assert.equal(state.eventView, "upcoming");
  assert.equal(state.tab, "overview");
  assert.equal(state.guestStatus, "all");
  assert.equal(state.guestPage, 1);
});
