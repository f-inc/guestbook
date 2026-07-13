import assert from "node:assert/strict";
import test from "node:test";
import { lumaEventManageUrl } from "../../luma-event-url";

test("builds the precise Luma management URL from the API event id", () => {
  assert.equal(
    lumaEventManageUrl({ id: "evt-XvrE6X2kxtiWOrK", source: "luma" }),
    "https://luma.com/event/manage/evt-XvrE6X2kxtiWOrK",
  );
});

test("does not expose management links for non-Luma or malformed ids", () => {
  assert.equal(lumaEventManageUrl({ id: "evt-XvrE6X2kxtiWOrK", source: "local" }), "");
  assert.equal(lumaEventManageUrl({ id: "javascript:alert(1)", source: "luma" }), "");
});
