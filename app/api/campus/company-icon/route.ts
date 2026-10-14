import { createHash } from "node:crypto";
import { requireGuestbookKey } from "../../session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const MAX_BYTES = 1_000_000;

async function readBounded(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("Response too large");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
async function download(url: URL, allowPlaceholder = false) {
  let target = url;
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetch(target, { cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(5000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Missing redirect");
      const next = new URL(location, target);
      if (next.protocol !== "https:" || next.username || next.password || next.port ||
        !(next.hostname === "www.google.com" || /^t[0-3]\.gstatic\.com$/.test(next.hostname) || next.hostname === "www.linkedin.com" || next.hostname.endsWith(".licdn.com"))) throw new Error("Invalid redirect");
      await response.body?.cancel();
      target = next;
      continue;
    }
    if (!response.ok && !(allowPlaceholder && response.status === 404)) throw new Error("Image unavailable");
    const type = response.headers.get("content-type")?.split(";")[0] || "";
    const bytes = await readBounded(response);
    return { bytes, type };
  }
  throw new Error("Too many redirects");
}
function favicon(domain: string) {
  const url = new URL("https://www.google.com/s2/favicons");
  url.searchParams.set("domain", domain); url.searchParams.set("sz", "64");
  return url;
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/x-icon", "image/vnd.microsoft.icon"]);

export async function GET(request: Request) {
  try {
    requireGuestbookKey(request);
    const query = new URL(request.url).searchParams;
    const website = query.get("website");
    if (website) {
      try {
        const site = new URL(website);
        if (!["https:", "http:"].includes(site.protocol) || site.username || site.password) throw new Error("Invalid website");
        // Fetch through a fixed public favicon service, never arbitrary user-controlled hosts.
        const icon = await download(favicon(site.hostname));
        const placeholder = await download(favicon("guestbook-no-company-icon.invalid"), true);
        if (imageTypes.has(icon.type) && hash(icon.bytes) !== hash(placeholder.bytes)) return new Response(Buffer.from(icon.bytes), { headers: { ...headers, "Content-Type": icon.type, "X-Content-Type-Options": "nosniff" } });
      } catch { /* Missing or default favicon: try the company LinkedIn page. */ }
    }
    const linkedin = query.get("linkedin");
    if (linkedin) {
      try {
        const profile = new URL(linkedin);
        if (profile.protocol !== "https:" || !["linkedin.com", "www.linkedin.com"].includes(profile.hostname) || !/^\/company\/[^/]+\/?$/.test(profile.pathname) || profile.username || profile.password || profile.port) throw new Error("Invalid company page");
        profile.hostname = "www.linkedin.com"; profile.search = ""; profile.hash = "";
        const page = await download(profile);
        if (page.type !== "text/html") throw new Error("Invalid page");
        const html = Buffer.from(page.bytes).toString("utf8");
        const tags = html.match(/<meta\b[^>]*>/gi) || [];
        const tag = tags.find(tag => /(?:property|name)\s*=\s*["']og:image["']/i.test(tag));
        const content = tag?.match(/content\s*=\s*["']([^"']+)["']/i)?.[1];
        if (!content) throw new Error("No company image");
        const image = new URL(content.replace(/&amp;/g, "&"));
        if (image.protocol !== "https:" || !image.hostname.endsWith(".licdn.com") || image.username || image.password || image.port) throw new Error("Invalid image host");
        const icon = await download(image);
        if (!imageTypes.has(icon.type)) throw new Error("Invalid image type");
        return new Response(Buffer.from(icon.bytes), { headers: { ...headers, "Content-Type": icon.type, "X-Content-Type-Options": "nosniff" } });
      } catch { /* LinkedIn may restrict access; the UI falls back to company initials. */ }
    }
    return new Response(null, { status: 404, headers });
  } catch (cause) {
    const status = (cause as Error & { status?: number }).status || 502;
    return Response.json({ error: "Company icon unavailable." }, { status, headers });
  }
}
