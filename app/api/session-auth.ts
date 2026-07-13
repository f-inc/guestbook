export const SESSION_KEY_HEADER = "x-guestbook-session-key";
export const SESSION_KEY_COOKIE = "guestbook_session_key";

type HttpError = Error & { status?: number };

export function requireSessionKey(request: Request): void {
  const expectedKey = process.env.GUESTBOOK_KEY || "";
  if (!expectedKey) {
    throw httpError("Missing GUESTBOOK_KEY. Configure it before serving Guestbook.", 503);
  }
  if (!isSessionRequestAuthorized(request, expectedKey)) {
    throw httpError("Unauthorized session key.", 401);
  }
}

export function isSessionRequestAuthorized(request: Request, expectedKey: string): boolean {
  if (!expectedKey) return false;
  const headerKey = request.headers.get(SESSION_KEY_HEADER);
  const providedKey = headerKey !== null ? headerKey : readCookie(request, SESSION_KEY_COOKIE);
  return constantTimeEqual(providedKey, expectedKey);
}

function readCookie(request: Request, name: string): string {
  const cookieHeader = request.headers.get("cookie") || "";
  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator === -1 || cookie.slice(0, separator).trim() !== name) continue;
    const value = cookie.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return "";
    }
  }
  return "";
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
