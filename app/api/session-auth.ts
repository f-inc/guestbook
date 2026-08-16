export const GUESTBOOK_KEY_HEADER = "x-guestbook-key";
export const GUESTBOOK_KEY_COOKIE = "guestbook_key";

// Keep accepting the old transport names while deployed clients migrate.
export const LEGACY_SESSION_KEY_HEADER = "x-guestbook-session-key";
export const LEGACY_SESSION_KEY_COOKIE = "guestbook_session_key";

type HttpError = Error & { status?: number };

export function requireGuestbookKey(request: Request): void {
  const expectedKey = process.env.GUESTBOOK_KEY || "";
  if (!expectedKey) {
    throw httpError("Missing GUESTBOOK_KEY. Configure it before serving Guestbook.", 503);
  }
  if (!isGuestbookRequestAuthorized(request, expectedKey)) {
    throw httpError("Invalid Guestbook key.", 401);
  }
}

export function isGuestbookRequestAuthorized(request: Request, expectedKey: string): boolean {
  if (!expectedKey) return false;
  const providedKey = request.headers.get(GUESTBOOK_KEY_HEADER)
    ?? request.headers.get(LEGACY_SESSION_KEY_HEADER)
    ?? readCookie(request, GUESTBOOK_KEY_COOKIE)
    ?? readCookie(request, LEGACY_SESSION_KEY_COOKIE);
  return constantTimeEqual(providedKey ?? "", expectedKey);
}

function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie") || "";
  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator === -1 || cookie.slice(0, separator).trim() !== name) continue;
    const value = cookie.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

function constantTimeEqual(leftValue: string, rightValue: string): boolean {
  const left = String(leftValue);
  const right = String(rightValue);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function httpError(message: string, status: number): HttpError {
  const error = new Error(message) as HttpError;
  error.status = status;
  return error;
}
