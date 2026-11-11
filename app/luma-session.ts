export const LUMA_SESSION_STORAGE_KEY = "guestbook.lumaAuthSession";
export const LUMA_SESSION_HEADER = "x-luma-session-token";
export const LUMA_SESSION_UPDATED_EVENT = "guestbook:luma-session-updated";
export const OPEN_LUMA_SETTINGS_EVENT = "guestbook:open-luma-settings";

export function normalizeBrowserLumaSession(value: unknown): string {
  const token = String(value || "").trim().replace(/^x-luma-auth-session\s*:\s*/i, "");
  return token.length <= 8192 && !/[\x00-\x20\x7f]/.test(token) ? token : "";
}

// Only these same-origin routes consume the Luma cookie. Never forward it elsewhere.
export function addBrowserLumaSession(headers: Headers, target: string, origin: string, token: string) {
  const url = new URL(target, origin);
  if (url.origin !== origin || !["/api/luma", "/api/luma/connection", "/api/luma/sync"].includes(url.pathname)) return;
  const value = normalizeBrowserLumaSession(token);
  if (value && !headers.has(LUMA_SESSION_HEADER)) headers.set(LUMA_SESSION_HEADER, value);
}
