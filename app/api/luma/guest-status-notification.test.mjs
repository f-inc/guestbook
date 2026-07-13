import assert from "node:assert/strict";
import test from "node:test";
import { MAX_GUEST_STATUS_MESSAGE_LENGTH, normalizeGuestStatusNotification } from "../../guest-status-notification.mjs";

test("normalizes an emailed guest status message", () => {
  assert.deepEqual(
    normalizeGuestStatusNotification({ sendEmail: true, message: "  Welcome aboard.  " }),
    { sendEmail: true, message: "Welcome aboard." },
  );
});

test("keeps a no-notification status update explicit", () => {
  assert.deepEqual(
    normalizeGuestStatusNotification({ sendEmail: false, message: "" }),
    { sendEmail: false, message: null },
  );
});

test("rejects a message when email notification is disabled", () => {
  assert.throws(
    () => normalizeGuestStatusNotification({ sendEmail: false, message: "Hello" }),
    /requires email notification/i,
  );
});

test("rejects messages over Luma's character limit", () => {
  assert.throws(
    () => normalizeGuestStatusNotification({ sendEmail: true, message: "x".repeat(MAX_GUEST_STATUS_MESSAGE_LENGTH + 1) }),
    /200 characters or fewer/i,
  );
});
