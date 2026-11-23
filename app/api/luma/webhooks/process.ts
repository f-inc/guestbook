import { prisma, sourcePrisma, invalidateIndexedAudienceCaches, recordLumaWebhookState,
  refreshIndexedEventOverviewStats, runAutomaticTagClassifier, upsertNormalizedLumaSnapshot } from "../db";
import { optOutFromWebhook } from "../tracking-policy";
import { LUMA_GUEST_WEBHOOK_TYPES, normalizeLumaWebhookGuest, normalizeWebhookEvent } from "./webhook";
import type { QueuedWebhook } from "./inbox";
import { retryAfterMs } from "../rate-limit-retry";

type Json = Record<string, any>;

// Fetch only the notified resource with the calendar credential paired to its
// signing secret. Re-reading current state also makes delayed deliveries safe.
export async function readWebhookResource(path: string, params: Record<string, string>, secretName: string, fetchImpl = fetch) {
  const keyName = secretName.replace("LUMA_WEBHOOK_SECRET", "LUMA_API_KEY");
  const key = process.env[keyName];
  if (!key) throw Object.assign(new Error("Missing paired calendar API key."), { code: "MISSING_CALENDAR_KEY" });
  const url = new URL(path, "https://public-api.luma.com");
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const response = await fetchImpl(url, { headers: { "x-luma-api-key": key }, signal: AbortSignal.timeout(15_000), cache: "no-store" });
  if (!response.ok) {
    const retryAfter = retryAfterMs(response.headers.get("retry-after"));
    await response.body?.cancel();
    throw Object.assign(new Error("Luma resource unavailable."), { code: `LUMA_HTTP_${response.status}`, retryAfter });
  }
  return response.json();
}

export async function processQueuedWebhook(row: QueuedWebhook) {
  const optOut = optOutFromWebhook(row.payload, row.secret_name);
  if (optOut) {
    await prisma().lumaCalendarOptOut.upsert({ where: { calendarId_emailLower: optOut }, create: optOut, update: {} });
    return;
  }
  const eventId = row.event_id!;
  const previous = await sourcePrisma().lumaEvent.findUnique({ where: { eventId }, select: { raw: true } });
  // A canceled Luma event is deleted upstream and cannot be restored. Keep its
  // history and a tombstone so a delayed guest/update delivery cannot revive it.
  const canceled = row.webhook_type === "event.canceled";
  if (!canceled && ["canceled", "cancelled"].includes((previous?.raw as Json)?.status)) return;
  const rawEvent: Json = canceled ? { ...row.payload.data, status: "canceled" }
    : await readWebhookResource("/v1/events/get", { event_id: eventId }, row.secret_name);
  if (rawEvent.id !== eventId && rawEvent.api_id !== eventId) throw Object.assign(new Error("Event identity mismatch."), { code: "EVENT_ID_MISMATCH" });
  const event = normalizeWebhookEvent({ ...rawEvent, id: eventId });
  if (LUMA_GUEST_WEBHOOK_TYPES.has(row.webhook_type)) {
    const guest: Json = await readWebhookResource("/v1/events/guests/get", { event_id: eventId, id: row.guest_id! }, row.secret_name);
    if (guest.id !== row.guest_id || typeof guest.user_id !== "string") {
      throw Object.assign(new Error("Guest identity mismatch."), { code: "GUEST_ID_MISMATCH" });
    }
    const normalized = normalizeLumaWebhookGuest({ ...guest, event: { ...rawEvent, id: eventId } });
    await upsertNormalizedLumaSnapshot({ rawEvent, event, guests: [normalized.guest], rawGuests: [guest] });
    if (guest.approval_status !== "invited") {
      await prisma().lumaInviteTracking.updateMany({
        where: { eventId, personId: guest.user_id, status: { in: ["sent", "delivered", "opened", "clicked"] }, checkedAt: { not: null }, nextCheckAt: { not: null } },
        data: { nextCheckAt: null, priority: 0 },
      });
    }
    await runAutomaticTagClassifier({ personIds: [guest.user_id] });
  } else {
    await upsertNormalizedLumaSnapshot({ rawEvent, event });
    if (canceled) await sourcePrisma().lumaEvent.update({ where: { eventId }, data: { catalogActive: false } });
    // The eligible event window can change after creation, edits or cancellation.
    await runAutomaticTagClassifier({});
  }
  await refreshIndexedEventOverviewStats([eventId]);
  await recordLumaWebhookState({ eventId, webhookId: row.webhook_id });
  invalidateIndexedAudienceCaches();
}
