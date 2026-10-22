import { createHash } from "node:crypto";

// Guestbook owns only this namespace. Never copy raw answers, names, location,
// subscriptions, application status or arbitrary Luma traits into CIO.
export const CIO_SCHEMA_VERSION = 1;
type Row = Record<string, any>;
export function normalizeCioEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
const iso = (value: unknown): string | null => {
  if (!value) return null;
  const date = new Date(value as string);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
// Track API timestamp conditions require Unix seconds, including nested traits.
const timestamp = (value: unknown): number | null => {
  const date = iso(value);
  return date ? Math.floor(Date.parse(date) / 1000) : null;
};
const unique = (values: string[]) => [...new Set(values)].sort();

export function buildCioProjection({ email, guests, optOuts = [], address = null,
  inactive = false, newsletterCalendarIds = [], now = new Date(), identityConflict = false, coverage = {},
}: { email: string; guests: Row[]; optOuts?: Row[]; address?: Row | null;
  inactive?: boolean; newsletterCalendarIds?: string[]; now?: Date; identityConflict?: boolean;
  coverage?: Record<string, string> }) {
  const normalized = normalizeCioEmail(email);
  if (!normalized) throw new Error("invalid_email");
  const byEvent = new Map<string, Row[]>();
  for (const row of guests) {
    if (normalizeCioEmail(row.emailLower || row.email) !== normalized) continue;
    const cutoff = iso(coverage[row.eventId]);
    const observed = iso(row.lastSeenAt);
    if (cutoff && observed && observed < cutoff) continue;
    const rows = byEvent.get(row.eventId) || [];
    rows.push(row); byEvent.set(row.eventId, rows);
    if (row.person?.emailLower && normalizeCioEmail(row.person.emailLower) !== normalized) identityConflict = true;
  }
  const records = [...byEvent.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([eventId, rows]) => {
    // An address assigned to conflicting registrations needs identity review.
    // We do not combine one person's approval with somebody else's check-in.
    rows.sort((a, b) => (iso(b.syncedAt) || "").localeCompare(iso(a.syncedAt) || "") || a.personId.localeCompare(b.personId));
    if (unique(rows.map(r => JSON.stringify([r.lumaApprovalStatus, iso(r.checkedInAt)]))).length > 1) identityConflict = true;
    const row = rows[0];
    const event = row.event || {};
    const approval = row.lumaApprovalStatus || "unknown";
    const checkedIn = timestamp(row.checkedInAt);
    const registeredAt = timestamp(row.registeredAt);
    // Older normalization can fall back to created_at for a declined invitation.
    // A declined row therefore needs real registration/check-in evidence.
    const registrationProof = Boolean(checkedIn || iso(row.raw?.registered_at) || (!row.raw && registeredAt));
    const registered = approval !== "invited" && (registrationProof || ["approved", "session", "pending_approval", "waitlist"].includes(approval));
    const cancelled = ["canceled", "cancelled"].includes(event.raw?.status) || Boolean(event.raw?.canceled_at || event.raw?.cancelled_at);
    const state = event.syncState;
    return {
      event_id: eventId, name: String(event.title || "").slice(0,200),
      category: String(event.category || "").slice(0,100),
      starts_at: timestamp(event.startsAt), ends_at: timestamp(event.endsAt),
      registered, registered_at: registeredAt, approval_status: approval,
      checked_in_at: checkedIn, canceled: cancelled,
      active: registered && !cancelled && ["approved", "session", "pending_approval", "waitlist"].includes(approval),
      source_complete: Boolean(state?.lastGuestSyncAt && !state.truncated && !state.error &&
        (state.lastStatus === "success" || (state.lastStatus === "webhook" && coverage[eventId]))),
    };
  }).filter(row => row.registered);
  const verified = records.filter(row => row.checked_in_at);
  const calendarIds = unique(optOuts.map(r => r.calendarId));
  const verificationFresh = address?.checkedAt && now.getTime() - new Date(address.checkedAt).getTime() <= 30 * 86400_000;
  const restricted = Boolean(address?.lumaBlockedReason && (!address.lumaClearedAt || new Date(address.lumaBlockedAt || 0) >= new Date(address.lumaClearedAt)));
  const blocked = Boolean(inactive || identityConflict || restricted || (verificationFresh && address?.state === "undeliverable") || calendarIds.some(id => newsletterCalendarIds.includes(id)));
  const attrs = {
    finc_luma_schema_version: CIO_SCHEMA_VERSION,
    finc_luma_event_records: records,
    finc_luma_registered_event_ids: records.map(r => r.event_id),
    finc_luma_active_event_ids: records.filter(r => r.active).map(r => r.event_id),
    finc_luma_approved_event_ids: records.filter(r => !r.canceled && ["approved", "session"].includes(r.approval_status)).map(r => r.event_id),
    finc_luma_waitlisted_event_ids: records.filter(r => !r.canceled && r.approval_status === "waitlist").map(r => r.event_id),
    finc_luma_checked_in_event_ids: verified.map(r => r.event_id),
    finc_luma_attended_categories: unique(verified.map(r => r.category).filter(Boolean)),
    finc_luma_registration_count: records.length,
    finc_luma_checkin_count: verified.length,
    finc_luma_last_checked_in_at: verified.map(r => r.checked_in_at!).sort((a,b) => a-b).at(-1) || null,
    finc_luma_indexed_records_complete: records.length > 0 && records.every(r => r.source_complete),
    finc_luma_calendar_opt_out_ids: calendarIds,
    finc_luma_identity_review: identityConflict,
    finc_luma_marketing_blocked: blocked,
  };
  const payload = JSON.stringify(attrs);
  if (Buffer.byteLength(payload) > 60_000) throw new Error("projection_too_large");
  return { attrs, hash: createHash("sha256").update(payload).digest("hex"), hasRegistrations: records.length > 0 };
}

export function cioRetryDelay(attempt: number, retryAfter: string | null, now = Date.now()) {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  const parsed = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) - now : seconds * 1000;
  return Math.max(1000, Math.min(86400_000, Number.isFinite(parsed) ? parsed : 30_000 * 2 ** Math.min(attempt, 10)));
}

export function requireCioProductionIdentity(env: Record<string, string | undefined> = process.env) {
  if (env.NODE_ENV !== "production" || env.GUESTBOOK_ENVIRONMENT !== "production" ||
      (env.VERCEL_ENV && env.VERCEL_ENV !== "production")) throw new Error("production_identity_required");
}

export function cioRuntimeMode(env: Record<string, string | undefined> = process.env) {
  if (env.CIO_SYNC_ENABLED !== "true") return "disabled";
  if (env.CIO_SYNC_SEND_ENABLED !== "true") return "preview";
  requireCioProductionIdentity(env);
  if (!env.CUSTOMERIO_SITE_ID || !env.CUSTOMERIO_TRACK_API_KEY || !env.CUSTOMERIO_APP_API_KEY) throw new Error("cio_credentials_required");
  if (env.CUSTOMERIO_REGION && !["us", "eu"].includes(env.CUSTOMERIO_REGION)) throw new Error("cio_region_invalid");
  if (env.CIO_SYNC_IDENTITY_CONFIRMED !== "email_lookup") throw new Error("cio_identity_confirmation_required");
  if (env.CIO_SYNC_PROFILE_MODE && !["existing_only", "create_reviewed"].includes(env.CIO_SYNC_PROFILE_MODE)) throw new Error("cio_profile_mode_invalid");
  if (env.CIO_SYNC_AUTOMATIONS_REVIEWED !== "true") throw new Error("cio_automation_review_required");
  const canary = (env.CIO_SYNC_ALLOWED_EMAILS || "").split(",").map(normalizeCioEmail).filter(Boolean);
  if (!canary.length && env.CIO_SYNC_FULL_ROLLOUT !== "true") throw new Error("cio_canary_or_rollout_required");
  return "send";
}
