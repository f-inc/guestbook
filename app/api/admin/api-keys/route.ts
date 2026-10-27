import { prisma } from "../../luma/db";
import { requireGuestbookKey } from "../../session-auth";
import { apiError, fail, generateKey, json, keySelect, SCOPES } from "../../v1/shared";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Require the header explicitly for mutations, so ambient cookies alone cannot
// authorize key creation/revocation from a cross-site form.
function admin(request: Request, mutation = false) {
  if (mutation && !request.headers.get("x-guestbook-key")) fail("Guestbook admin key header is required.", 401);
  requireGuestbookKey(request);
}
export async function GET(request: Request) {
  try {
    admin(request);
    return json({ data: await prisma().integrationApiKey.findMany({ select: keySelect, orderBy: { createdAt: "desc" } }) });
  } catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try {
    admin(request, true);
    if (Number(request.headers.get("content-length")) > 8192) fail("Request too large.", 413);
    const text = await request.text();
    if (text.length > 8192) fail("Request too large.", 413);
    let body: any;
    try { body = JSON.parse(text); } catch { fail("Invalid JSON body."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) fail("Invalid key settings.");
    const { name, scopes, eventIds = [], expiresAt = null } = body;
    if (typeof name !== "string" || !name.trim() || name.trim().length > 100) fail("Provide a key name of 1–100 characters.");
    if (!Array.isArray(scopes) || !scopes.length || scopes.some(scope => !SCOPES.includes(scope))) fail("Choose valid API permissions.");
    if (scopes.includes("guests:email") && !scopes.includes("guests:read")) fail("Email access also requires guest access.");
    if (!Array.isArray(eventIds) || eventIds.length > 100 || eventIds.some(id => typeof id !== "string" || !/^[\w-]{1,128}$/.test(id))) fail("Provide at most 100 valid event IDs.");
    const expiry = expiresAt === null ? null : typeof expiresAt === "string" ? new Date(expiresAt) : new Date(NaN);
    if (expiry && (!Number.isFinite(expiry.getTime()) || expiry <= new Date())) fail("Expiration must be in the future.");
    const { secret, ...credentials } = generateKey();
    const key = await prisma().integrationApiKey.create({ data: { name: name.trim(), scopes: [...new Set(scopes)], eventIds: [...new Set(eventIds)], expiresAt: expiry, ...credentials }, select: keySelect });
    return json({ data: key, secret }, 201);
  } catch (error) { return apiError(error); }
}
export async function DELETE(request: Request) {
  try {
    admin(request, true);
    const id = new URL(request.url).searchParams.get("id");
    if (!id || id.length > 128) fail("A key ID is required.");
    const result = await prisma().integrationApiKey.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
    return json({ revoked: result.count > 0 });
  } catch (error) { return apiError(error); }
}
