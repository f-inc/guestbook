import { appendFile, mkdir } from "node:fs/promises";
import nodePath from "node:path";
import {
  claimLumaWebhookDelivery,
  finishLumaWebhookDelivery,
  hasLumaDb,
  invalidateIndexedAudienceCaches,
  recordLumaWebhookState,
  refreshIndexedEventOverviewStats,
  runAutomaticTagClassifier,
  upsertNormalizedLumaSnapshot,
} from "../db";
import {
  lumaWebhookSecrets,
  MAX_LUMA_WEBHOOK_BODY_BYTES,
  normalizeLumaWebhookGuest,
  parseLumaGuestWebhook,
  verifyLumaWebhook,
} from "./webhook";

export const runtime = "nodejs";

type HttpError = Error & { status?: number };
const DEFAULT_DEBUG_LOG_PATH = nodePath.join(process.cwd(), ".debug", "luma-api.log");
const CACHE_KEY = "__guestbookLumaCache";

export async function POST(request: Request) {
  const startedAt = Date.now();
  const webhookId = request.headers.get("webhook-id")?.trim() || "";
  const requestId = webhookId ? `luma-webhook-${webhookId.slice(0, 80)}` : `luma-webhook-${Date.now().toString(36)}`;
  let claimed = false;

  try {
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_LUMA_WEBHOOK_BODY_BYTES) {
      throw httpError("Webhook body is too large.", 413);
    }
    if (!webhookId || webhookId.length > 255 || /[\r\n]/.test(webhookId)) {
      throw httpError("A valid Webhook-Id header is required.", 400);
    }
    if (!hasLumaDb()) throw httpError("Luma webhooks require DB_URL.", 503);

    const secrets = lumaWebhookSecrets();
    if (!secrets.length) throw httpError("Luma webhooks require LUMA_WEBHOOK_SECRET.", 503);

    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_LUMA_WEBHOOK_BODY_BYTES) {
      throw httpError("Webhook body is too large.", 413);
    }
    const verification = verifyLumaWebhook({
      rawBody,
      signatureHeader: request.headers.get("webhook-signature"),
      timestampHeader: request.headers.get("webhook-timestamp")?.trim() || null,
      secrets,
      toleranceSeconds: webhookToleranceSeconds(),
    });
    if (!verification.ok) {
      await webhookLog(requestId, "signature rejected", { reason: verification.reason });
      throw httpError("Invalid Luma webhook signature.", 401);
    }

    const parsed = parseLumaGuestWebhook(rawBody);
    if (!parsed.supported) {
      await webhookLog(requestId, "event ignored", { webhookType: parsed.type, durationMs: Date.now() - startedAt });
      return json({ ok: true, ignored: true, webhookId, type: parsed.type });
    }

    const claim = await claimLumaWebhookDelivery({
      webhookId,
      webhookType: parsed.type,
      eventId: parsed.eventId,
      guestId: parsed.guestId,
      payloadSha256: parsed.payloadSha256,
    });
    if (!claim.claimed) {
      await webhookLog(requestId, "duplicate acknowledged", {
        webhookType: parsed.type,
        eventId: parsed.eventId,
        attempt: claim.attempt,
        durationMs: Date.now() - startedAt,
      });
      return json({ ok: true, duplicate: true, webhookId });
    }
    claimed = true;

    const normalized = normalizeLumaWebhookGuest(parsed.data);
    await upsertNormalizedLumaSnapshot({
      rawEvent: normalized.rawEvent,
      event: normalized.event,
      guests: [normalized.guest],
      rawGuests: [normalized.rawGuest],
    });
    await refreshIndexedEventOverviewStats([parsed.eventId]);
    const automaticTags = await runAutomaticTagClassifier({ personIds: [parsed.personId] });
    await recordLumaWebhookState({ eventId: parsed.eventId, webhookId });
    invalidateIndexedAudienceCaches();
    clearWebhookCaches({
      eventId: parsed.eventId,
      personId: parsed.personId,
      email: normalized.guest.person.email,
    });
    await finishLumaWebhookDelivery(webhookId);

    await webhookLog(requestId, "guest reconciled", {
      webhookType: parsed.type,
      eventId: parsed.eventId,
      attempt: claim.attempt,
      checkedIn: Boolean(normalized.guest.checkedInAt),
      automaticTagMode: automaticTags.mode,
      automaticTagChanges: automaticTags.changedCount,
      durationMs: Date.now() - startedAt,
    });
    return json({
      ok: true,
      webhookId,
      eventId: parsed.eventId,
      guestId: parsed.guestId,
      reconciled: true,
    });
  } catch (error: any) {
    if (claimed) await finishLumaWebhookDelivery(webhookId, error).catch(() => {});
    const status = Number(error?.status) || 500;
    await webhookLog(requestId, "processing error", {
      status,
      message: safeErrorMessage(error),
      durationMs: Date.now() - startedAt,
    });
    return json({ ok: false, error: status >= 500 ? "Unable to process Luma webhook." : error.message, webhookId }, status);
  }
}

function clearWebhookCaches({ eventId, personId, email }: { eventId: string; personId: string; email: string }) {
  const cache = (globalThis as typeof globalThis & { [CACHE_KEY]?: Map<string, unknown> })[CACHE_KEY];
  if (!cache) return;
  cache.delete("events");
  cache.delete(`event-guests:v3:${eventId}`);
  cache.delete(`event-guests:v2:${eventId}`);
  cache.delete(`event-guests:${eventId}`);
  const normalizedPersonId = personId.trim().toLowerCase();
  const normalizedEmail = email.trim().toLowerCase();
  cache.delete(`trace-person:${normalizedPersonId || "no-id"}:${normalizedEmail || "no-email"}`);
  cache.delete(`trace-person:${normalizedPersonId || "no-id"}:no-email`);
  cache.delete(`trace-person:no-id:${normalizedEmail || "no-email"}`);
}

function webhookToleranceSeconds() {
  const configured = Number(process.env.LUMA_WEBHOOK_TOLERANCE_SECONDS);
  return Number.isFinite(configured) ? Math.min(3600, Math.max(60, Math.floor(configured))) : 300;
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

function httpError(message: string, status: number) {
  return Object.assign(new Error(message), { status }) as HttpError;
}

function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}

async function webhookLog(requestId: string, event: string, details: Record<string, unknown>) {
  try {
    const path = process.env.GUESTBOOK_DEBUG_LOG_PATH || DEFAULT_DEBUG_LOG_PATH;
    await mkdir(nodePath.dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify({ timestamp: new Date().toISOString(), requestId, event: `webhook ${event}`, ...details })}\n`, "utf8");
  } catch {
    // Diagnostics must never change webhook acknowledgement behavior.
  }
}
