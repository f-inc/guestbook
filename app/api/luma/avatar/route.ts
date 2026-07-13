import { getIndexedPersonAvatarSource, updateIndexedPersonAvatar } from "../db";
import { avatarSource } from "../../../avatar-order";
import { requireSessionKey } from "../../session-auth";

export const runtime = "nodejs";

const resolveInFlight = new Map();
const missCache = new Map();
const MISS_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

export async function GET(request: Request) {
  try {
    requireSessionKey(request);
  } catch (error: any) {
    return Response.json(
      { ok: false, error: error.message || "Unable to validate the session key." },
      {
        status: error.status || 500,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }

  const personId = new URL(request.url).searchParams.get("person_id")?.trim();
  if (!personId || personId.length > 200) return new Response(null, { status: 400 });

  const missedAt = missCache.get(personId);
  if (missedAt && Date.now() - missedAt < MISS_TTL_MS) return new Response(null, { status: 404 });

  try {
    const avatarUrl = await resolveAvatarOnce(personId);
    if (!avatarUrl) {
      missCache.set(personId, Date.now());
      return new Response(null, { status: 404 });
    }
    missCache.delete(personId);
    return new Response(null, {
      status: 307,
      headers: {
        location: avatarUrl,
        "cache-control": "private, no-store",
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}

async function resolveAvatarOnce(personId) {
  if (!resolveInFlight.has(personId)) {
    resolveInFlight.set(
      personId,
      resolveAvatar(personId).finally(() => resolveInFlight.delete(personId)),
    );
  }
  return resolveInFlight.get(personId);
}

async function resolveAvatar(personId) {
  const person = await getIndexedPersonAvatarSource(personId);
  if (!person) return "";
  const storedAvatar = isUsefulAvatarUrl(person.avatarUrl) ? person.avatarUrl : "";
  const storedSource = avatarSource(storedAvatar);
  if (storedAvatar && storedSource === "luma") return storedAvatar;

  const lumaUserId = firstString(
    person.lumaUserId,
    person.raw?.user_id,
    person.raw?.user_api_id,
    person.raw?.user?.id,
    person.raw?.user?.user_id,
    person.raw?.user?.api_id,
    personId.startsWith("usr-") ? personId : "",
  );
  const lumaAvatar = lumaUserId ? await resolveLumaAvatar(lumaUserId) : "";
  if (lumaAvatar) return persistAvatar(personId, lumaAvatar);

  const socialLinks = Array.isArray(person.socialLinks) ? person.socialLinks : [];
  if (storedAvatar && storedSource === "linkedin") return storedAvatar;
  const linkedinUrl = allowedSocialUrl(socialLinks.find((link) => link?.type === "linkedin")?.url, "linkedin");
  const linkedinAvatar = linkedinUrl ? await resolveOpenGraphImage(linkedinUrl) : "";
  if (linkedinAvatar) return persistAvatar(personId, linkedinAvatar);

  if (storedAvatar && storedSource === "x") return storedAvatar;
  const xUrl = allowedSocialUrl(socialLinks.find((link) => link?.type === "x")?.url, "x");
  const xAvatar = xUrl ? await resolveOpenGraphImage(xUrl) : "";
  if (xAvatar) return persistAvatar(personId, xAvatar);

  return "";
}

async function resolveLumaAvatar(lumaUserId) {
  const html = await fetchHtml(`https://luma.com/user/${encodeURIComponent(lumaUserId)}`);
  if (!html) return "";
  const decodedHtml = decodeHtmlUrl(html);
  const matches = decodedHtml.match(/https:\/\/images\.lumacdn\.com\/(?:cdn-cgi\/image\/[^"'<>\s]+\/)?avatars\/[^"'<>\s\\]+/g) || [];
  return matches.map(decodeHtmlUrl).find(isHttpUrl) || "";
}

async function resolveOpenGraphImage(profileUrl) {
  const html = await fetchHtml(profileUrl);
  if (!html) return "";
  const tags = html.match(/<meta\s+[^>]*>/gi) || [];
  for (const tag of tags) {
    const property = attribute(tag, "property") || attribute(tag, "name");
    if (!["og:image", "og:image:secure_url", "twitter:image"].includes(property?.toLowerCase())) continue;
    const content = decodeHtmlUrl(attribute(tag, "content") || "");
    if (isUsefulAvatarUrl(content)) return content;
  }
  return "";
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Guestbook/1.0 (+profile-image-resolution)",
      },
      cache: "no-store",
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return "";
    return response.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

async function persistAvatar(personId, avatarUrl) {
  try {
    await updateIndexedPersonAvatar(personId, avatarUrl);
  } catch {
    // The resolved URL is still usable when a concurrent sync updates this row.
  }
  return avatarUrl;
}

function allowedSocialUrl(value, type) {
  if (!isHttpUrl(value)) return "";
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (type === "linkedin" && (hostname === "linkedin.com" || hostname.endsWith(".linkedin.com"))) return url.toString();
    if (type === "x" && ["x.com", "twitter.com"].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) return url.toString();
  } catch {
    return "";
  }
  return "";
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match?.[1] || "";
}

function decodeHtmlUrl(value) {
  return value.replaceAll("&amp;", "&").replaceAll("\\u0026", "&").replaceAll("\\/", "/");
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function isUsefulAvatarUrl(value) {
  if (!isHttpUrl(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    if (host === "images.lumacdn.com") return path.includes("/avatars/");
    if (host === "pbs.twimg.com") return path.includes("/profile_images/");
    if (host === "media.licdn.com") return path.includes("/dms/image/");
    if (host === "abs.twimg.com" || host.endsWith(".static.licdn.com")) return false;
    return !path.includes("/default") && !path.includes("placeholder");
  } catch {
    return false;
  }
}
