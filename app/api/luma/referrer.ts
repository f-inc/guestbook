type AnyRecord = Record<string, any>;

export type LumaReferrer = {
  name: string;
  email: string;
  url: string;
  source: string;
  avatarUrl: string;
  tintColor: string;
};

export function extractLumaReferrer(payload: AnyRecord = {}): LumaReferrer | null {
  const nested = firstRecord(
    payload.opened_from,
    payload.openedFrom,
    payload.referrer,
    payload.referred_by,
    payload.referrer_user,
    payload.invited_by,
    payload.invited_by_user,
  );
  const nestedLabel = typeof nested === "string" ? nested : "";
  const referrer = typeof nested === "object" && nested ? nested : {};
  const value = {
    name: firstString(
      referrer.name,
      referrer.user_name,
      referrer.full_name,
      nestedLabel,
      payload.referrer_name,
      payload.referred_by_name,
      payload.invited_by_name,
    ),
    email: firstString(
      referrer.email,
      referrer.user_email,
      payload.referrer_email,
      payload.referred_by_email,
      payload.invited_by_email,
    ),
    url: normalizeLumaReferrerUrl(
      referrer.url,
      referrer.profile_url,
      payload.referrer_url,
      payload.referral_url,
    ),
    source: firstString(
      referrer.source,
      payload.registration_source,
      payload.referral_source,
      payload.utm_source,
    ),
    avatarUrl: firstHttpUrl(
      referrer.avatar_url,
      referrer.avatarUrl,
      referrer.image_url,
      payload.referrer_avatar_url,
      payload.referrer_image_url,
    ),
    tintColor: firstString(referrer.tint_color, referrer.tintColor, payload.referrer_tint_color),
  };
  return Object.values(value).some(Boolean) ? value : null;
}

function firstRecord(...values: any[]) {
  return values.find((value) => typeof value === "string" || (value && typeof value === "object" && !Array.isArray(value))) || {};
}

function normalizeLumaReferrerUrl(...values: any[]) {
  for (const value of values) {
    const raw = stringifyLinkValue(value);
    if (!raw) continue;
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith("/")) return new URL(raw, "https://luma.com").toString();
  }
  return "";
}

function firstHttpUrl(...values: any[]) {
  for (const value of values) {
    const raw = stringifyLinkValue(value);
    if (/^https?:\/\//i.test(raw)) return raw;
  }
  return "";
}

function stringifyLinkValue(value: any) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") return firstString(value.url, value.href, value.value);
  return String(value).trim();
}

function firstString(...values: any[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}
