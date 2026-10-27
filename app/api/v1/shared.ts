import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../luma/db";

export const SCOPES = ["events:read", "guests:read", "guests:email"] as const;
export type Scope = typeof SCOPES[number];
export type ApiKey = { id: string; scopes: string[]; eventIds: string[]; revokedAt: Date | null; expiresAt: Date | null };
export const keySelect = { id: true, name: true, prefix: true, scopes: true, eventIds: true, createdAt: true, expiresAt: true, revokedAt: true };
export function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
export function apiError(error: unknown) {
  const e = error as Error & { status?: number };
  return json({ error: e.status ? e.message : "Unable to process the API request. Check database setup and try again." }, e.status || 500);
}
export function hashKey(key: string) { return createHash("sha256").update(key).digest("hex"); }
export function generateKey() {
  const secret = `gb_live_${randomBytes(32).toString("hex")}`;
  return { secret, keyHash: hashKey(secret), prefix: secret.slice(0, 16) };
}
export async function authorize(request: Request, scope: Scope, db?: ReturnType<typeof prisma>): Promise<ApiKey> {
  const token = /^Bearer (gb_live_[a-f0-9]{64})$/i.exec(request.headers.get("authorization") || "")?.[1];
  if (!token) fail("A Guestbook integration Bearer API key is required.", 401);
  db ??= prisma();
  const key = await db.integrationApiKey.findUnique({ where: { keyHash: hashKey(token) } });
  if (!key || key.revokedAt || (key.expiresAt && key.expiresAt <= new Date())) fail("Invalid, revoked, or expired API key.", 401);
  if (!key.scopes.includes(scope)) fail(`This API key requires ${scope}.`, 403);
  return key;
}
export function checkEventAccess(key: ApiKey, eventId: string) {
  if (key.eventIds.length && !key.eventIds.includes(eventId)) fail("This API key cannot access this event.", 403);
}
export function pagination(params: URLSearchParams, allowed: string[] = []) {
  for (const name of params.keys()) {
    if (!["limit", "cursor", ...allowed].includes(name) || params.getAll(name).length !== 1) fail(`Invalid query parameter: ${name}.`);
  }
  const limitText = params.get("limit") ?? "100";
  if (!/^\d+$/.test(limitText) || +limitText < 1 || +limitText > 500) fail("limit must be an integer from 1 to 500.");
  const cursor = params.get("cursor");
  if (cursor !== null && (!cursor.length || cursor.length > 256)) fail("Invalid cursor.");
  return { limit: +limitText, cursor };
}
export function page<T>(rows: T[], limit: number, id: (row: T) => string) {
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);
  return { data, pagination: { hasMore, nextCursor: hasMore ? id(data[data.length - 1]) : null } };
}
