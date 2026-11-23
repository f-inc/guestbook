import { createHash } from "node:crypto";
import { LUMA_EVENT_WEBHOOK_TYPES, LUMA_GUEST_WEBHOOK_TYPES } from "./webhook";

export function parseWebhookEnvelope(rawBody: string) {
  let payload: any;
  try { payload = JSON.parse(rawBody); }
  catch { throw Object.assign(new Error("Webhook body must be valid JSON."), { status: 400 }); }
  if (!payload || Array.isArray(payload) || typeof payload !== "object" || typeof payload.type !== "string") {
    throw Object.assign(new Error("Webhook type is required."), { status: 400 });
  }
  const { type, data } = payload;
  const guest = LUMA_GUEST_WEBHOOK_TYPES.has(type);
  const event = LUMA_EVENT_WEBHOOK_TYPES.has(type);
  const optOut = type === "calendar.person.unsubscribed";
  if (!guest && !event && !optOut) return { supported: false as const, type };
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("Webhook data is required."), { status: 400 });
  }
  if (type === "calendar.event.added" && data.platform === "external") return { supported: false as const, type };
  const eventId = guest ? data.event?.id : event ? data.id : null;
  const guestId = guest ? data.id : null;
  if ((!optOut && !validId(eventId)) || (guest && (!validId(guestId) || !validId(data.user_id)))) {
    throw Object.assign(new Error("Webhook resource IDs are required."), { status: 400 });
  }
  if (optOut && (typeof data.email !== "string" || !data.email.includes("@"))) {
    throw Object.assign(new Error("Opt-out webhook requires an email."), { status: 400 });
  }
  return { supported: true as const, type, payload, eventId: eventId as string | null,
    guestId: guestId as string | null, payloadSha256: createHash("sha256").update(rawBody).digest("hex") };
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_-]{1,160}$/i.test(value);
}

export function webhookRetryDelay(attempt: number) {
  return Math.min(3_600_000, 5_000 * 2 ** Math.max(0, Math.min(attempt - 1, 10)));
}
