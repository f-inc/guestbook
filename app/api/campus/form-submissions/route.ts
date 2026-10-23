import { requireGuestbookKey } from "../../session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    requireGuestbookKey(request);
    const key = process.env.CAMPUS_API_KEY;
    if (!key) return Response.json({ error: "Configure CAMPUS_API_KEY on the Guestbook server." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    const origin = new URL(process.env.CAMPUS_API_URL || "https://api.f.inc");
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
      return Response.json({ error: "CAMPUS_API_URL must be an API origin." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    const target = new URL("/api/integrations/form-submissions", origin);
    const incoming = new URL(request.url).searchParams;
    for (const [name, value] of incoming) {
      if (!["formKey", "email", "limit", "offset", "q"].includes(name) || incoming.getAll(name).length !== 1) {
        return Response.json({ error: "Invalid form submission query." }, { status: 400, headers: { "Cache-Control": "no-store" } });
      }
      if (name !== "q") target.searchParams.set(name, value);
    }
    const search = incoming.get("q")?.trim();
    const limit = Number(incoming.get("limit") || 25);
    const offset = Number(incoming.get("offset") || 0);
    if (search && (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || search.length > 500)) {
      return Response.json({ error: "Invalid form submission query." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const matches: unknown[] = [];
    let cursor = offset;
    // Bound each read-only search batch; nextOffset resumes at the next unscanned record.
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15000)]);
    for (let page = 0; page < (search ? 20 : 1); page++) {
      if (search) {
        target.searchParams.set("offset", String(cursor));
        target.searchParams.set("limit", String(limit - matches.length));
      }
      const response = await fetch(target, {
        headers: {
          Authorization: `Bearer ${key}`,
          ...(process.env.API_FIREWALL_BYPASS_KEY ? { "x-finc-internal": process.env.API_FIREWALL_BYPASS_KEY } : {}),
        },
        cache: "no-store",
        redirect: "error",
        signal,
      });
      if (!response.ok) {
        if (response.headers.get("x-vercel-mitigated") === "challenge" || response.headers.get("cf-mitigated") === "challenge" || (response.status === 403 && response.headers.get("content-type")?.includes("text/html"))) {
          return Response.json({ error: "Campus is blocking server requests with a browser challenge. Configure API access at the Campus edge." }, { status: 502, headers: { "Cache-Control": "no-store" } });
        }
        const message = response.status === 403
          ? "Campus API key requires form-submissions.read."
          : response.status === 401 ? "Campus API key is invalid or revoked."
          : response.status === 400 ? "Invalid form submission query." : "Campus form submissions are unavailable.";
        return Response.json({ error: message }, { status: response.status >= 500 ? 502 : response.status, headers: { "Cache-Control": "no-store" } });
      }
      const body = await response.json() as { data?: unknown; pagination?: { nextOffset?: unknown } };
      if (!search) return Response.json(body, { headers: { "Cache-Control": "no-store" } });
      const next = body.pagination?.nextOffset;
      if (!Array.isArray(body.data) || body.data.length > limit - matches.length || !(next === null || (typeof next === "number" && Number.isSafeInteger(next) && next > cursor))) {
        throw new Error("Invalid Campus pagination.");
      }
      const terms = search.normalize("NFKC").toLocaleLowerCase("en-US").split(/\s+/).filter(Boolean);
      for (const submission of body.data) {
        const values = searchableValues(submission).normalize("NFKC").toLocaleLowerCase("en-US");
        if (terms.every(term => values.includes(term))) matches.push(submission);
      }
      if (next === null || matches.length === limit || page === 19) {
        return Response.json({ data: matches, pagination: { limit, offset, nextOffset: next } }, { headers: { "Cache-Control": "no-store" } });
      }
      if (typeof next !== "number") throw new Error("Invalid Campus pagination.");
      cursor = next;
    }
    throw new Error("Search batch incomplete.");
  } catch (error) {
    const status = (error as Error & { status?: number }).status;
    return Response.json({ error: status ? (error as Error).message : "Campus form submissions are unavailable." }, { status: status || 502, headers: { "Cache-Control": "no-store" } });
  }
}

// Search scalar values at any depth, including custom answers, name, and email.
function searchableValues(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(searchableValues).join(" ");
  if (typeof value === "object") return Object.values(value).map(searchableValues).join(" ");
  return String(value);
}
