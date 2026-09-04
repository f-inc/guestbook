import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  lumaWebhookSecrets,
  normalizeLumaWebhookGuest,
  parseLumaGuestWebhook,
  verifyLumaWebhook,
} from "./webhooks/webhook";

const timestamp = "1787100000";
const nowMs = Number(timestamp) * 1000;
const secret = "whsec_test_secret";

function signature(body: string, signingSecret = secret) {
  return createHmac("sha256", signingSecret).update(`${timestamp}.${body}`).digest("hex");
}

function guestPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "guest.updated",
    data: {
      id: "gst-1",
      user_id: "usr-1",
      user_email: "guest@example.com",
      user_name: "Guest Person",
      approval_status: "approved",
      registered_at: "2026-08-01T10:00:00.000Z",
      invited_at: null,
      phone_number: null,
      registration_answers: [],
      event_tickets: [],
      event: {
        id: "evt-1",
        name: "Test Event",
        start_at: "2026-08-20T10:00:00.000Z",
        end_at: "2026-08-20T12:00:00.000Z",
        visibility: "private",
        url: "https://lu.ma/test",
        tags: [],
        geo_address_json: null,
        max_capacity: 100,
      },
      ...overrides,
    },
  };
}

test("discovers numbered webhook secrets in deterministic order", () => {
  assert.deepEqual(lumaWebhookSecrets({
    LUMA_WEBHOOK_SECRET_10: "ten",
    LUMA_WEBHOOK_SECRET_2: "two",
    LUMA_WEBHOOK_SECRET: "base",
    LUMA_WEBHOOK_SECRET_BAD: "ignored",
  }), [
    { envName: "LUMA_WEBHOOK_SECRET", value: "base", order: 0 },
    { envName: "LUMA_WEBHOOK_SECRET_2", value: "two", order: 2 },
    { envName: "LUMA_WEBHOOK_SECRET_10", value: "ten", order: 10 },
  ]);
});

test("verifies the raw body against any configured Luma secret", () => {
  const body = JSON.stringify(guestPayload());
  assert.deepEqual(verifyLumaWebhook({
    rawBody: body,
    signatureHeader: `t=${timestamp},v1=${signature(body, "whsec_second")}`,
    timestampHeader: timestamp,
    secrets: [
      { envName: "LUMA_WEBHOOK_SECRET", value: secret, order: 0 },
      { envName: "LUMA_WEBHOOK_SECRET_2", value: "whsec_second", order: 2 },
    ],
    nowMs,
  }), {
    ok: true,
    secretName: "LUMA_WEBHOOK_SECRET_2",
    timestamp: Number(timestamp),
  });
});

test("rejects stale, mismatched, and invalid signatures", () => {
  const body = JSON.stringify(guestPayload());
  const secrets = [{ envName: "LUMA_WEBHOOK_SECRET", value: secret, order: 0 }];
  assert.equal(verifyLumaWebhook({
    rawBody: body,
    signatureHeader: `t=${timestamp},v1=${signature(body)}`,
    timestampHeader: timestamp,
    secrets,
    nowMs: nowMs + 301_000,
  }).reason, "stale_timestamp");
  assert.equal(verifyLumaWebhook({
    rawBody: body,
    signatureHeader: `t=${timestamp},v1=${signature(body)}`,
    timestampHeader: String(Number(timestamp) + 1),
    secrets,
    nowMs,
  }).reason, "timestamp_mismatch");
  assert.equal(verifyLumaWebhook({
    rawBody: `${body} `,
    signatureHeader: `t=${timestamp},v1=${signature(body)}`,
    timestampHeader: timestamp,
    secrets,
    nowMs,
  }).reason, "invalid_signature");
});

test("parses supported guest webhooks and ignores other signed event types", () => {
  const parsed = parseLumaGuestWebhook(JSON.stringify(guestPayload()));
  assert.equal(parsed.supported, true);
  if (parsed.supported) {
    assert.equal(parsed.eventId, "evt-1");
    assert.equal(parsed.guestId, "gst-1");
    assert.equal(parsed.personId, "usr-1");
    assert.match(parsed.payloadSha256, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(parseLumaGuestWebhook(JSON.stringify({ type: "event.updated", data: {} })), {
    supported: false,
    type: "event.updated",
  });
});

test("normalizes multi-select answers independently and uses ticket-level check-in", () => {
  const payload = guestPayload({
    registration_answers: [
      {
        question_id: "q-1",
        label: "What are you hoping to do?",
        question_type: "multi-select",
        value: ["Meet founders", "Meet investors"],
      },
      {
        question_id: "q-2",
        label: "What is your LinkedIn?",
        question_type: "linkedin",
        value: "/in/guest-person",
      },
    ],
    event_tickets: [
      { id: "t-1", checked_in_at: "2026-08-20T10:05:00.000Z" },
      { id: "t-2", checked_in_at: "2026-08-20T10:03:00.000Z" },
    ],
  });
  const normalized = normalizeLumaWebhookGuest(payload.data as Record<string, unknown>, new Date("2026-08-20T11:00:00.000Z"));
  assert.deepEqual(normalized.guest.registrationAnswers[0], {
    id: "q-1",
    label: "What are you hoping to do?",
    value: "Meet founders Meet investors",
    values: ["Meet founders", "Meet investors"],
    questionType: "multi-select",
  });
  assert.equal(normalized.guest.checkedInAt, "2026-08-20T10:03:00.000Z");
  assert.equal(normalized.guest.status, "checked_in");
  assert.equal(normalized.guest.socialLinks[0].url, "https://www.linkedin.com/in/guest-person");
});

test("normalizes an un-check-in with an empty checked-in timestamp", () => {
  const normalized = normalizeLumaWebhookGuest(guestPayload({ event_tickets: [{ id: "t-1", checked_in_at: null }] }).data as Record<string, unknown>);
  assert.equal(normalized.guest.checkedInAt, "");
  assert.equal(normalized.guest.status, "going");
});
