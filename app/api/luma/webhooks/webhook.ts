import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lumaEventDate } from "../event-date";

type AnyRecord = Record<string, any>;

export const LUMA_GUEST_WEBHOOK_TYPES = new Set(["guest.registered", "guest.updated"]);
export const DEFAULT_LUMA_WEBHOOK_TOLERANCE_SECONDS = 300;
export const MAX_LUMA_WEBHOOK_BODY_BYTES = 1_000_000;

const approvalToStatus: Record<string, string> = {
  approved: "going",
  pending_approval: "registered",
  invited: "invited",
  declined: "declined",
  waitlist: "waitlisted",
  session: "going",
};

export type LumaWebhookSecret = { envName: string; value: string; order: number };

export function lumaWebhookSecrets(environment: Record<string, string | undefined> = process.env): LumaWebhookSecret[] {
  return Object.entries(environment)
    .flatMap(([envName, rawValue]) => {
      const match = envName.match(/^LUMA_WEBHOOK_SECRET(?:_(\d+))?$/);
      const value = typeof rawValue === "string" ? rawValue.trim() : "";
      if (!match || !value) return [];
      return [{ envName, value, order: match[1] ? Number(match[1]) : 0 }];
    })
    .sort((left, right) => left.order - right.order || left.envName.localeCompare(right.envName));
}

export function verifyLumaWebhook({
  rawBody,
  signatureHeader,
  timestampHeader,
  secrets,
  nowMs = Date.now(),
  toleranceSeconds = DEFAULT_LUMA_WEBHOOK_TOLERANCE_SECONDS,
}: {
  rawBody: string;
  signatureHeader: string | null;
  timestampHeader: string | null;
  secrets: LumaWebhookSecret[];
  nowMs?: number;
  toleranceSeconds?: number;
}) {
  if (!secrets.length) return { ok: false as const, reason: "missing_secret" };
  const fields = parseSignatureHeader(signatureHeader);
  const timestamp = fields.timestamp;
  if (!timestamp || !fields.signatures.length || !/^\d+$/.test(timestamp)) {
    return { ok: false as const, reason: "invalid_signature_header" };
  }
  if (timestampHeader !== timestamp) return { ok: false as const, reason: "timestamp_mismatch" };

  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) return { ok: false as const, reason: "invalid_timestamp" };
  const ageSeconds = Math.abs(nowMs / 1000 - timestampSeconds);
  if (ageSeconds > toleranceSeconds) return { ok: false as const, reason: "stale_timestamp" };

  const signedPayload = `${timestamp}.${rawBody}`;
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret.value).update(signedPayload).digest("hex");
    if (fields.signatures.some((actual) => constantTimeHexEqual(expected, actual))) {
      return { ok: true as const, secretName: secret.envName, timestamp: timestampSeconds };
    }
  }
  return { ok: false as const, reason: "invalid_signature" };
}

export function parseLumaGuestWebhook(rawBody: string) {
  let payload: AnyRecord;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw webhookError("Webhook body must be valid JSON.", 400);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw webhookError("Webhook body must be a JSON object.", 400);
  }
  const type = stringValue(payload.type);
  if (!type) throw webhookError("Webhook type is required.", 400);
  if (!LUMA_GUEST_WEBHOOK_TYPES.has(type)) return { supported: false as const, type };

  const data = payload.data;
  const event = data?.event;
  const guestId = stringValue(data?.id);
  const eventId = stringValue(event?.id);
  const personId = stringValue(data?.user_id);
  if (!data || typeof data !== "object" || !guestId || !eventId || !personId) {
    throw webhookError("Guest webhook data must include guest, user, and event IDs.", 400);
  }
  return {
    supported: true as const,
    type,
    data,
    eventId,
    guestId,
    personId,
    payloadSha256: createHash("sha256").update(rawBody).digest("hex"),
  };
}

export function normalizeLumaWebhookGuest(data: AnyRecord, _now = new Date()) {
  const rawEvent = data.event;
  const event = normalizeWebhookEvent(rawEvent);
  const registrationAnswers = normalizeWebhookAnswers(data.registration_answers);
  const checkedInAt = earliestCheckIn(data.event_tickets);
  const approvalStatus = stringValue(data.approval_status);
  const status = checkedInAt
    ? "checked_in"
    : approvalToStatus[approvalStatus] || "registered";
  const email = stringValue(data.user_email);
  const lumaUserId = stringValue(data.user_id);
  const name = stringValue(data.user_name)
    || [stringValue(data.user_first_name), stringValue(data.user_last_name)].filter(Boolean).join(" ")
    || email
    || "Unnamed guest";
  const profileDescription = profileDescriptionFromAnswers(registrationAnswers);
  const socialLinks = socialLinksFromAnswers(registrationAnswers);
  const title = titleFromCompanyAnswer(data.registration_answers);
  const phoneNumber = stringValue(data.phone_number) || phoneFromAnswers(data.registration_answers);
  const searchText = [profileDescription, answersSearchText(registrationAnswers), phoneNumber, ...socialLinks.map((link) => link.display)]
    .filter(Boolean)
    .join(" ");

  return {
    rawEvent,
    event,
    rawGuest: data,
    guest: {
      person: {
        id: lumaUserId,
        lumaUserId,
        name,
        email,
        title,
        profileDescription,
        bio: profileDescription,
        avatarUrl: "",
        avatarCandidates: [],
        profileUrl: lumaUserId.startsWith("usr-") ? `https://luma.com/user/${encodeURIComponent(lumaUserId)}` : "",
        socialLinks,
        referrer: null,
        groups: [],
        notes: profileDescription,
        source: "luma",
      },
      personId: lumaUserId,
      lumaGuestId: stringValue(data.id),
      lumaUserId,
      lumaApprovalStatus: approvalStatus,
      phoneNumber,
      profileDescription,
      avatarUrl: "",
      avatarCandidates: [],
      profileUrl: lumaUserId.startsWith("usr-") ? `https://luma.com/user/${encodeURIComponent(lumaUserId)}` : "",
      socialLinks,
      referrer: null,
      registrationAnswers,
      searchText,
      source: "luma",
      status,
      registeredAt: stringValue(data.registered_at, data.joined_at),
      invitedAt: stringValue(data.invited_at),
      createdAt: "",
      updatedAt: "",
      approvedAt: "",
      checkedInAt,
    },
  };
}

function normalizeWebhookEvent(event: AnyRecord) {
  const address = event.geo_address_json || {};
  const location = [address.address, address.full_address, address.city, address.region, address.country]
    .map((value) => stringValue(value))
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(", ");
  return {
    id: stringValue(event.id),
    title: stringValue(event.name) || "Untitled event",
    date: lumaEventDate(event),
    startsAt: stringValue(event.start_at) || null,
    endsAt: stringValue(event.end_at) || null,
    visibility: stringValue(event.visibility) || null,
    location,
    category: stringValue(event.tags?.[0]?.name) || "Luma",
    capacity: Number.isFinite(event.max_capacity) ? event.max_capacity : null,
    lumaUrl: stringValue(event.url),
    imageUrl: stringValue(event.cover_url),
    description: stringValue(event.description, event.description_md),
    cancelled: false,
    guests: [],
    guestsLoaded: false,
    source: "luma",
  };
}

function normalizeWebhookAnswers(answers: unknown) {
  if (!Array.isArray(answers)) return [];
  return answers.map((answer: AnyRecord, index) => {
    const values = answerValues(answer?.value);
    return {
      id: stringValue(answer?.question_id, answer?.id) || `answer-${index}`,
      label: stringValue(answer?.label) || "Question",
      value: values.join(" "),
      values,
      questionType: stringValue(answer?.question_type),
    };
  }).filter((answer) => answer.value || answer.label);
}

function answerValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(answerValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(answerValues);
  if (typeof value === "boolean") return value ? ["Yes"] : ["No"];
  const normalized = stringValue(value);
  return normalized ? [normalized] : [];
}

function earliestCheckIn(tickets: unknown) {
  if (!Array.isArray(tickets)) return "";
  return tickets
    .map((ticket) => stringValue(ticket?.checked_in_at))
    .filter(Boolean)
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0] || "";
}

function profileDescriptionFromAnswers(answers: ReturnType<typeof normalizeWebhookAnswers>) {
  return answers.find((answer) => /bio|about|description|profile/i.test(answer.label))?.value || "";
}

function titleFromCompanyAnswer(answers: unknown) {
  if (!Array.isArray(answers)) return "Luma guest";
  const companyAnswer = answers.find((answer) => answer?.question_type === "company" || /company|organization/i.test(String(answer?.label || "")));
  const jobTitle = stringValue(companyAnswer?.value?.job_title, companyAnswer?.value?.title, companyAnswer?.value?.role);
  const company = stringValue(companyAnswer?.value?.company, companyAnswer?.value?.company_name, companyAnswer?.value?.organization);
  return [jobTitle, company].filter(Boolean).join(" at ") || company || "Luma guest";
}

function phoneFromAnswers(answers: unknown) {
  if (!Array.isArray(answers)) return "";
  return stringValue(answers.find((answer) => answer?.question_type === "phone-number")?.value);
}

function answersSearchText(answers: ReturnType<typeof normalizeWebhookAnswers>) {
  return answers.map((answer) => `${answer.label} ${answer.value}`.trim()).join(" ");
}

function socialLinksFromAnswers(answers: ReturnType<typeof normalizeWebhookAnswers>) {
  return answers.flatMap((answer) => {
    const type = socialType(answer.questionType, answer.label);
    if (!type || !answer.value) return [];
    const url = socialUrl(type, answer.value);
    if (!url) return [];
    return [{ type, label: socialLabel(type), url, display: displaySocial(type, answer.value, url) }];
  });
}

function socialType(questionType: string, label: string) {
  const value = `${questionType} ${label}`.toLowerCase();
  if (value.includes("linkedin")) return "linkedin";
  if (value.includes("twitter") || /(^|\s)x(\s|$)/.test(value)) return "x";
  if (value.includes("instagram")) return "instagram";
  if (value.includes("github")) return "github";
  if (value.includes("youtube")) return "youtube";
  if (value.includes("website") || value.includes("portfolio") || questionType === "url") return "website";
  return "";
}

function socialUrl(type: string, rawValue: string) {
  const raw = rawValue.trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  const handle = raw.replace(/^@/, "").replace(/^\/+/, "").trim();
  if (!handle) return "";
  if (type === "website") return handle.includes(".") ? `https://${handle}` : "";
  if (type === "linkedin") return handle.includes("linkedin.com") ? `https://${handle}` : `https://www.linkedin.com/in/${encodeURIComponent(handle.replace(/^in\//i, ""))}`;
  if (type === "x") return handle.includes("twitter.com") || handle.includes("x.com") ? `https://${handle}` : `https://x.com/${encodeURIComponent(handle)}`;
  if (type === "instagram") return handle.includes("instagram.com") ? `https://${handle}` : `https://www.instagram.com/${encodeURIComponent(handle)}`;
  if (type === "github") return handle.includes("github.com") ? `https://${handle}` : `https://github.com/${encodeURIComponent(handle)}`;
  if (type === "youtube") return handle.includes("youtube.com") || handle.includes("youtu.be") ? `https://${handle}` : `https://www.youtube.com/@${encodeURIComponent(handle)}`;
  return "";
}

function socialLabel(type: string) {
  return ({ linkedin: "LinkedIn", x: "X", instagram: "Instagram", github: "GitHub", youtube: "YouTube", website: "Website" } as Record<string, string>)[type] || type;
}

function displaySocial(type: string, rawValue: string, url: string) {
  if (type !== "website" && !/^https?:\/\//i.test(rawValue)) return rawValue.startsWith("@") ? rawValue : `@${rawValue}`;
  return url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}

function parseSignatureHeader(header: string | null) {
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of String(header || "").split(",")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") timestamp = value;
    if (key === "v1" && /^[a-f0-9]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  return { timestamp, signatures };
}

function constantTimeHexEqual(expected: string, actual: string) {
  if (!/^[a-f0-9]{64}$/i.test(actual)) return false;
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function stringValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function webhookError(message: string, status: number) {
  return Object.assign(new Error(message), { status });
}
