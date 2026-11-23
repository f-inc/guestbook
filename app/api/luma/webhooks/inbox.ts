import { prisma } from "../db";
import { INBOX_CHANNEL, CHANGE_CHANNEL } from "./notifications";
import { parseWebhookEnvelope, webhookRetryDelay } from "./envelope";

type Envelope = Extract<ReturnType<typeof parseWebhookEnvelope>, { supported: true }>;
export type QueuedWebhook = { webhook_id: string; webhook_type: string; event_id: string | null;
  guest_id: string | null; payload: any; secret_name: string; attempts: number };

export async function enqueueWebhook(webhookId: string, envelope: Envelope, secretName: string) {
  return prisma().$transaction(async (tx) => {
    const inserted = await tx.$queryRaw<Array<{ webhook_id: string }>>`
      INSERT INTO luma_webhook_deliveries
        (webhook_id, webhook_type, event_id, guest_id, payload_sha256, payload, secret_name, status, attempts, next_attempt_at, updated_at)
      VALUES (${webhookId}, ${envelope.type}, ${envelope.eventId}, ${envelope.guestId}, ${envelope.payloadSha256},
        ${JSON.stringify(envelope.payload)}::jsonb, ${secretName}, 'queued', 0, NOW(), NOW())
      ON CONFLICT (webhook_id) DO NOTHING RETURNING webhook_id`;
    if (!inserted.length) {
      const existing = await tx.$queryRaw<Array<{ payload_sha256: string }>>`
        SELECT payload_sha256 FROM luma_webhook_deliveries WHERE webhook_id = ${webhookId}`;
      if (existing[0]?.payload_sha256 !== envelope.payloadSha256) {
        throw Object.assign(new Error("Webhook ID was reused with a different payload."), { status: 409 });
      }
    }
    // Delivered only when the durable insert commits. No identities in notifications.
    await tx.$queryRaw`SELECT pg_notify(${INBOX_CHANNEL}, '')::text`;
    return { duplicate: !inserted.length };
  });
}

export async function claimQueuedWebhook() {
  const rows = await prisma().$queryRaw<QueuedWebhook[]>`
    UPDATE luma_webhook_deliveries SET status = 'processing', attempts = attempts + 1,
      next_attempt_at = NOW() + INTERVAL '2 minutes', updated_at = NOW()
    WHERE webhook_id = (
      SELECT webhook_id FROM luma_webhook_deliveries
      WHERE status IN ('queued', 'retry', 'processing') AND payload IS NOT NULL AND next_attempt_at <= NOW()
      ORDER BY next_attempt_at, received_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) RETURNING webhook_id, webhook_type, event_id, guest_id, payload, secret_name, attempts`;
  return rows[0] || null;
}

export async function completeQueuedWebhook(row: QueuedWebhook) {
  await prisma().$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE luma_webhook_deliveries SET status = 'processed', payload = NULL,
      error = NULL, processed_at = NOW(), next_attempt_at = NULL, updated_at = NOW() WHERE webhook_id = ${row.webhook_id}`;
    await tx.$queryRaw`SELECT pg_notify(${CHANGE_CHANNEL}, ${JSON.stringify({ eventId: row.event_id })})::text`;
  });
}

export async function failQueuedWebhook(row: QueuedWebhook, code: string, retryAfter?: number) {
  const terminal = row.attempts >= 10;
  const delay = Math.max(webhookRetryDelay(row.attempts), Number.isFinite(retryAfter) ? Math.min(86_400_000, Math.max(0, retryAfter!)) : 0);
  const next = new Date(Date.now() + delay);
  // Provider/ORM messages can contain identities or credentials. Save codes only.
  await prisma().$executeRaw`UPDATE luma_webhook_deliveries SET status = ${terminal ? "dead" : "retry"},
    error = ${code}, next_attempt_at = ${terminal ? null : next}, updated_at = NOW() WHERE webhook_id = ${row.webhook_id}`;
}

export async function nextWebhookAttempt() {
  const rows = await prisma().$queryRaw<Array<{ next: Date | null }>>`
    SELECT MIN(next_attempt_at) AS next FROM luma_webhook_deliveries
    WHERE status IN ('queued', 'retry', 'processing') AND payload IS NOT NULL`;
  return rows[0]?.next || null;
}
