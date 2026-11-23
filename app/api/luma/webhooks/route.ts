import { requireGuestbookKey } from "../../session-auth";
import { createHash } from "node:crypto";
import { prisma, hasLumaDb } from "../db";
import { optOutFromWebhook } from "../tracking-policy";
import { enqueueWebhook } from "./inbox";
import { parseWebhookEnvelope } from "./envelope";
import { logWebhook } from "./diagnostics";
import { lumaWebhookSecrets, MAX_LUMA_WEBHOOK_BODY_BYTES, verifyLumaWebhook } from "./webhook";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const requestId = `luma-webhook-${crypto.randomUUID()}`;
  try {
    const webhookId = request.headers.get("webhook-id")?.trim() || "";
    if (!/^[a-z0-9_-]{1,255}$/i.test(webhookId)) throw httpError("A valid Webhook-Id header is required.", 400);
    if (!hasLumaDb() || !lumaWebhookSecrets().length) throw httpError("Webhook configuration is unavailable.", 503);
    const rawBody = await boundedWebhookBody(request);
    const verification = verifyLumaWebhook({ rawBody,
      signatureHeader: request.headers.get("webhook-signature"),
      timestampHeader: request.headers.get("webhook-timestamp")?.trim() || null,
      secrets: lumaWebhookSecrets(),
      toleranceSeconds: Math.min(3600, Math.max(60, Number(process.env.LUMA_WEBHOOK_TOLERANCE_SECONDS) || 300)),
    });
    if (!verification.ok) throw httpError("Invalid Luma webhook signature.", 401);
    const envelope = parseWebhookEnvelope(rawBody);
    if (!envelope.supported) return json({ ok: true, ignored: true, type: envelope.type, requestId });
    // Validate secret-to-calendar scope before durably accepting opt-outs.
    optOutFromWebhook(envelope.payload, verification.secretName);
    const result = await enqueueWebhook(webhookId, envelope, verification.secretName);
    await logWebhook("queued", { requestId, type: envelope.type, duplicate: result.duplicate });
    // Acceptance means durably queued, not yet projected into the guest index.
    return json({ ok: true, queued: true, ...result, requestId }, 202);
  } catch (error: any) {
    const status = Number(error?.status) || 503;
    await logWebhook("rejected", { requestId, status });
    return json({ ok: false, error: status >= 500 ? "Unable to accept Luma webhook." : error.message, requestId }, status);
  }
}

export async function GET(request: Request) {
  try {
    requireGuestbookKey(request);
    const summary = await prisma().$queryRaw<Array<{ status: string; count: number; oldest: Date; newest: Date }>>`
      SELECT status, COUNT(*)::int AS count, MIN(received_at) AS oldest, MAX(received_at) AS newest
      FROM luma_webhook_deliveries GROUP BY status`;
    const workers = await prisma().$queryRaw<Array<{ active: boolean }>>`
      SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = 821157032 AND granted) AS active`;
    const target = new URL(process.env.DB_URL!);
    const databaseFingerprint = createHash("sha256").update(JSON.stringify([target.hostname, target.pathname, target.username])).digest("hex");
    return json({ configured: lumaWebhookSecrets().length > 0, workerActive: workers[0]?.active || false, deliveries: summary, databaseFingerprint });
  } catch (error: any) {
    return json({ error: "Webhook status unavailable." }, Number(error?.status) || 503);
  }
}

export async function boundedWebhookBody(request: Request) {
  if (Number(request.headers.get("content-length")) > MAX_LUMA_WEBHOOK_BODY_BYTES) throw httpError("Webhook body is too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw httpError("Webhook body is required.", 400);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_LUMA_WEBHOOK_BODY_BYTES) {
        await reader.cancel();
        throw httpError("Webhook body is too large.", 413);
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}
function httpError(message: string, status: number) { return Object.assign(new Error(message), { status }); }
