import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { LUMA_SESSION_HEADER, normalizeBrowserLumaSession } from "../../luma-session";

type BrowserSession = {
  token: string;
  credentials: Map<string, any>;
  cache: Map<string, any>;
  guestScans: Map<string, Promise<any>>;
};

const sessionContext = new AsyncLocalStorage<BrowserSession>();
// Routing survives requests, but never crosses browser identities. Store only a
// token digest and credential names here; the token stays request-local.
const routing = new Map<string, { credentials: Map<string, any>; expiresAt: number }>();
const ROUTING_TTL_MS = 6 * 60 * 60 * 1000;

function sessionCredentials(token: string) {
  const now = Date.now();
  for (const [key, entry] of routing) if (entry.expiresAt <= now) routing.delete(key);
  const key = createHash("sha256").update(token).digest("hex");
  const entry = routing.get(key) || { credentials: new Map(), expiresAt: now + ROUTING_TTL_MS };
  routing.delete(key);
  routing.set(key, entry);
  while (routing.size > 100) routing.delete(routing.keys().next().value!);
  return entry.credentials;
}
export function browserLumaSession() { return sessionContext.getStore(); }

export function withBrowserLumaSession(request: Request, action: () => Promise<Response>): Promise<Response> {
  const supplied = request.headers.get(LUMA_SESSION_HEADER);
  if (!supplied) return action();
  const token = normalizeBrowserLumaSession(supplied);
  if (!token) return Promise.resolve(Response.json({ error: "Invalid Luma session token." }, { status: 400, headers: { "cache-control": "private, no-store" } }));
  return sessionContext.run({ token, credentials: sessionCredentials(token), cache: new Map(), guestScans: new Map() }, action);
}
