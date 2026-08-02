import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SELECTED_EVENT_IDS } from "../../event-selection";
import { buildWorkspaceUrlSearch, isEventDirectoryPath, parseWorkspaceUrl, workspacePathname } from "../../workspace-url";

test("uses a dedicated path for the event directory", () => {
  assert.equal(workspacePathname(true), "/events");
  assert.equal(workspacePathname(false), "/");
  assert.equal(isEventDirectoryPath("/events"), true);
  assert.equal(isEventDirectoryPath("/events/"), true);
  assert.equal(isEventDirectoryPath("/"), false);
});

test("round-trips event directory sorting", () => {
  const state = parseWorkspaceUrl("?sort=average_rating&direction=asc");
  assert.equal(state.eventSort, "averageRating");
  assert.equal(state.eventSortDirection, "asc");
  assert.match(buildWorkspaceUrlSearch("", state), /sort=average_rating/);
  assert.match(buildWorkspaceUrlSearch("", state), /direction=asc/);
});

test("parses workspace navigation state from the URL", () => {
  assert.deepEqual(parseWorkspaceUrl("?event=evt-1&event_view=past&tab=analytics&guest_status=accepted&guest_search=ada&guest_tag=VIP&guest_tag=Builder&guest_page=3&profile=person-2"), {
    eventId: "evt-1",
    eventIds: ["evt-1"],
    eventView: "past",
    eventSearch: "",
    tab: "analytics",
    guestStatus: "accepted",
    guestStatuses: ["accepted"],
    guestStatusMode: "any",
    guestExcludedStatuses: [],
    guestSearch: "ada",
    guestTags: ["VIP", "Builder"],
    guestTagMode: "any",
    guestExcludedTags: [],
    guestPage: 3,
    profileId: "person-2",
  });
});

test("preserves the feedback event tab in workspace URLs", () => {
  const state = parseWorkspaceUrl("?event=evt-1&tab=feedback");
  assert.equal(state.tab, "feedback");
  assert.match(buildWorkspaceUrlSearch("", state), /tab=feedback/);
});

test("round-trips included, excluded, and ALL status rules", () => {
  const state = parseWorkspaceUrl("?guest_status=accepted&guest_status=checked_in&guest_status_mode=all&guest_status_not=no_show");
  assert.deepEqual(state.guestStatuses, ["accepted", "checked_in"]);
  assert.equal(state.guestStatusMode, "all");
  assert.deepEqual(state.guestExcludedStatuses, ["no_show"]);

  const reparsed = parseWorkspaceUrl(buildWorkspaceUrlSearch("", state));
  assert.deepEqual(reparsed.guestStatuses, state.guestStatuses);
  assert.equal(reparsed.guestStatusMode, "all");
  assert.deepEqual(reparsed.guestExcludedStatuses, ["no_show"]);
});

test("persists ALL tag matching and excluded tags", () => {
  const state = parseWorkspaceUrl("?guest_tag=Builder&guest_tag=Referred&guest_tag_mode=all&guest_tag_not=Flaker");
  assert.equal(state.guestTagMode, "all");
  assert.deepEqual(state.guestExcludedTags, ["Flaker"]);
  const search = buildWorkspaceUrlSearch("", state);
  assert.match(search, /guest_tag_mode=all/);
  assert.match(search, /guest_tag_not=Flaker/);
});

test("parses ordered multi-event selections and keeps the last event primary", () => {
  const state = parseWorkspaceUrl("?event=evt-1&event=evt-2&event=evt-3");
  assert.deepEqual(state.eventIds, ["evt-1", "evt-2", "evt-3"]);
  assert.equal(state.eventId, "evt-3");
});

test("restores stacked event selections up to the shared catalog limit", () => {
  const params = new URLSearchParams();
  for (let index = 0; index < MAX_SELECTED_EVENT_IDS + 10; index += 1) {
    params.append("event", `evt-${index}`);
  }
  const state = parseWorkspaceUrl(params.toString());
  assert.equal(state.eventIds.length, MAX_SELECTED_EVENT_IDS);
  assert.equal(state.eventId, `evt-${MAX_SELECTED_EVENT_IDS - 1}`);
});

test("persists guest note and attendance filters", () => {
  const state = parseWorkspaceUrl("?guest_has_notes=1&guest_attended_gt=4");
  assert.equal(state.guestHasNotes, true);
  assert.equal(state.guestAttendedGreaterThan, 4);
  assert.match(buildWorkspaceUrlSearch("", state), /guest_has_notes=1/);
  assert.match(buildWorkspaceUrlSearch("", state), /guest_attended_gt=4/);
});

test("serializes non-default workspace state and preserves unrelated params", () => {
  const search = buildWorkspaceUrlSearch("?debug=1&event=old", {
    eventId: "evt-2",
    eventIds: ["evt-1", "evt-2"],
    eventView: "all",
    eventSearch: "campus",
    tab: "overview",
    guestStatus: "all",
    guestSearch: "",
    guestTags: [],
    guestPage: 2,
    profileId: "person-3",
  });

  assert.equal(search, "debug=1&event=evt-1&event=evt-2&event_view=all&event_search=campus&guest_page=2&profile=person-3");
});

test("falls back from invalid URL values", () => {
  const state = parseWorkspaceUrl("?event_view=nope&tab=nope&guest_status=nope&guest_page=-9");
  assert.equal(state.eventView, "upcoming");
  assert.equal(state.tab, "overview");
  assert.equal(state.guestStatus, "all");
  assert.equal(state.guestPage, 1);
});

test("preserves the new-referrals guest filter in workspace URLs", () => {
  const state = parseWorkspaceUrl("?event=evt-1&guest_status=new_referrals");
  assert.equal(state.guestStatus, "new_referrals");
  assert.match(buildWorkspaceUrlSearch("", state), /guest_status=new_referrals/);
});

test("preserves analytics funnel guest filters in workspace URLs", () => {
  for (const guestStatus of ["referrals", "invited_accepted", "invited_referral_no_response"]) {
    const state = parseWorkspaceUrl(`?event=evt-1&guest_status=${guestStatus}`);
    assert.equal(state.guestStatus, guestStatus);
    assert.match(buildWorkspaceUrlSearch("", state), new RegExp(`guest_status=${guestStatus}`));
  }
});

test("preserves accepted first-register drill-downs in workspace URLs", () => {
  const state = parseWorkspaceUrl("?guest_status=accepted_first_registers");
  assert.equal(state.guestStatus, "accepted_first_registers");
});
