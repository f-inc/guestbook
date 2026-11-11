import { AsyncLocalStorage } from "node:async_hooks";
import { LUMA_SESSION_HEADER, normalizeBrowserLumaSession } from "../../luma-session";

type BrowserSession = {
  token: string;
  credentials: Map<string, any>;
  cache: Map<string, any>;
  guestScans: Map<string, Promise<any>>;
};

const sessionContext = new AsyncLocalStorage<BrowserSession>();
export function browserLumaSession() { return sessionContext.getStore(); }

export function withBrowserLumaSession(request: Request, action: () => Promise<Response>): Promise<Response> {
  const supplied = request.headers.get(LUMA_SESSION_HEADER);
  if (!supplied) return action();
  const token = normalizeBrowserLumaSession(supplied);
  if (!token) return Promise.resolve(Response.json({ error: "Invalid Luma session token." }, { status: 400, headers: { "cache-control": "private, no-store" } }));
  return sessionContext.run({ token, credentials: new Map(), cache: new Map(), guestScans: new Map() }, action);
}
