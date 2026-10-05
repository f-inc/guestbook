import assert from "node:assert/strict";
import test from "node:test";
import { guestIndexIsReady } from "./guest-index-readiness";

test("empty unsynced or failed indexes need a live load", async () => {
  for (const sync of [null, { lastGuestSyncAt: new Date(), lastStatus: "error", truncated: false, lastGuestCount: 0 }, { lastGuestSyncAt: new Date(), lastStatus: "success", truncated: true, lastGuestCount: 0 }]) {
    assert.equal(await guestIndexIsReady(false, async () => ({ hasAnyGuests: false, sync })), false);
  }
});
test("confirmed empty events and empty filters use the index", async () => {
  assert.equal(await guestIndexIsReady(false, async () => ({ hasAnyGuests: true, sync: null })), true);
  assert.equal(await guestIndexIsReady(false, async () => ({ hasAnyGuests: false, sync: { lastGuestSyncAt: new Date(), lastStatus: "success", truncated: false, lastGuestCount: 0 } })), true);
  assert.equal(await guestIndexIsReady(true, async () => { throw new Error("unnecessary inspection"); }), true);
});
