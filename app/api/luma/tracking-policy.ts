const minute = 60_000;
export function nextTrackingCheck(
  status: string,
  requestedAt: Date | null,
  now = new Date(),
  eventEnded = false,
) {
  if (["bounced", "reported", "skipped"].includes(status) || eventEnded)
    return null;
  const age = requestedAt ? now.getTime() - requestedAt.getTime() : Infinity;
  let delay =
    age < 2 * minute
      ? 30_000
      : age < 10 * minute
        ? 2 * minute
        : age < 60 * minute
          ? 10 * minute
          : age < 86400000
            ? 30 * minute
            : age < 7 * 86400000
              ? 4 * 60 * minute
              : 86400000;
  if (["opened", "clicked"].includes(status))
    delay = Math.max(delay, 4 * 60 * minute);
  return new Date(now.getTime() + delay);
}
export function trackingRetryDelay(attempt: number, retryAfter?: number) {
  return Math.max(
    retryAfter || 0,
    Math.min(3600_000, 60_000 * 2 ** Math.min(attempt, 6)),
  );
}
export function calendarIdFromEvent(raw: any): string | null {
  return (
    raw?.calendar?.id ||
    raw?.calendar?.api_id ||
    raw?.calendar_id ||
    raw?.calendar_api_id ||
    null
  );
}
export function optOutFromWebhook(
  payload: any,
  secretName: string,
  env: Record<string, string | undefined> = process.env,
) {
  if (payload?.type !== "calendar.person.unsubscribed") return null;
  // The payload has no calendar ID. Bind scope to the verified signing secret, never a caller-supplied ID.
  const calendarId =
    env[secretName.replace("LUMA_WEBHOOK_SECRET", "LUMA_WEBHOOK_CALENDAR_ID")];
  if (!calendarId)
    throw Object.assign(
      new Error(
        "Opt-out webhook requires a calendar mapping for its signing secret.",
      ),
      { status: 503 },
    );
  const email = payload.data?.email;
  if (typeof email !== "string" || !email.includes("@"))
    throw Object.assign(new Error("Opt-out webhook requires an email."), {
      status: 400,
    });
  return { calendarId, emailLower: email.trim().toLowerCase() };
}
