import assert from "node:assert/strict";
import test from "node:test";
import { avatarSource, orderAvatarCandidates } from "../../avatar-order.mjs";

test("orders Luma, resolver, LinkedIn, then X avatars", () => {
  const luma = "https://images.lumacdn.com/avatars/example.jpg";
  const linkedin = "https://media.licdn.com/dms/image/example.jpg";
  const x = "https://pbs.twimg.com/profile_images/example.jpg";
  const resolver = "/api/luma/avatar?person_id=usr-1";

  assert.deepEqual(orderAvatarCandidates(x, linkedin, resolver, luma), [luma, resolver, linkedin, x]);
});

test("treats unclassified direct images as Luma payload images", () => {
  const lumaProxy = "https://cdn.example.com/luma-profile.jpg";
  const linkedin = "https://media.licdn.com/dms/image/example.jpg";

  assert.equal(avatarSource(lumaProxy), "luma");
  assert.deepEqual(orderAvatarCandidates(linkedin, lumaProxy), [lumaProxy, linkedin]);
});
