export const inviteStatusLabels: Record<string, string> = {
  invited: "Invited",
  not_loaded: "Invited · Tracking not loaded",
  unknown: "Invited · No tracking returned",
  processing: "Invite Processing",
  sent: "Invite Sent",
  delivered: "Invite Delivered",
  opened: "Invite Opened",
  clicked: "Invite Clicked",
  bounced: "Invite Bounced",
  reported: "Invite Reported",
  skipped: "Invite Skipped",
  failed: "Send Failed",
  unconfirmed: "Send Unconfirmed",
};
export function emailStatus(email: any): string {
  if (email.marked_as_spam_at || email.status === "marked-spam")
    return "reported";
  if (email.bounced_at || email.status === "bounced") return "bounced";
  if (email.clicked_at || email.status === "clicked") return "clicked";
  if (email.opened_at || email.status === "opened") return "opened";
  if (email.delivered_at || email.status === "delivered") return "delivered";
  if (email.sent_at || email.status === "sent") return "sent";
  return "unknown";
}
export function invitationMessages(payload: any) {
  const entries = Array.isArray(payload) ? payload : payload?.entries;
  if (!Array.isArray(entries))
    throw new Error("Unrecognized guest timeline response.");
  return entries
    .filter(
      (e) =>
        e?.type === "email-sent" &&
        e?.email?.email_type === "to-guest--event-invitation" &&
        e.email.api_id,
    )
    .map((e) => ({
      id: String(e.email.api_id),
      timelineId: String(e.id),
      status: emailStatus(e.email),
      sentAt: validDate(e.email.sent_at || e.timestamp),
      deliveredAt: validDate(e.email.delivered_at),
      openedAt: validDate(e.email.opened_at),
      clickedAt: validDate(e.email.clicked_at),
      bouncedAt: validDate(e.email.bounced_at),
      reportedAt: validDate(e.email.marked_as_spam_at),
    }))
    .sort((a, b) => (b.sentAt || "").localeCompare(a.sentAt || ""));
}
function validDate(v: unknown) {
  return typeof v === "string" && Number.isFinite(Date.parse(v))
    ? new Date(v).toISOString()
    : null;
}
export function latestInviteStatus(
  messages: any[],
  requestedAt?: Date | string | null,
  fallback = "unknown",
) {
  const latest = messages[0];
  if (
    !latest ||
    (requestedAt &&
      Date.parse(latest.sentAt || "") < new Date(requestedAt).getTime())
  )
    return fallback;
  return latest.status;
}

// Never erase previously observed timestamps when an upstream response is partial.
export function mergeInvitationMessages(previous: any[], incoming: any[]) {
  const byId = new Map(previous.map((m) => [m.id, m]));
  for (const message of incoming) {
    const old = byId.get(message.id) || {};
    const merged = {
      ...old,
      ...Object.fromEntries(
        Object.entries(message).filter(([, v]) => v != null),
      ),
    };
    merged.status = emailStatus({
      status: merged.status,
      sent_at: merged.sentAt,
      delivered_at: merged.deliveredAt,
      opened_at: merged.openedAt,
      clicked_at: merged.clickedAt,
      bounced_at: merged.bouncedAt,
      marked_as_spam_at: merged.reportedAt,
    });
    byId.set(message.id, merged);
  }
  return [...byId.values()].sort((a, b) =>
    (b.sentAt || "").localeCompare(a.sentAt || ""),
  );
}

// An invitation ID is not an email message ID. Keep these evidence streams separate.
export function bulkInvitationStatus(row: any, invite: any): string {
  const created = Date.parse(invite.createdAt || "");
  const requested = row?.requestedAt ? new Date(row.requestedAt).getTime() : 0;
  if (
    requested > created &&
    ["processing", "unconfirmed", "skipped", "failed"].includes(row?.status)
  )
    return row.status;
  const messages = Array.isArray(row?.messages) ? row.messages : [];
  const detail = messages.find(
    (m: any) => Date.parse(m.sentAt || "") >= created,
  );
  if (detail && ["bounced", "reported", "clicked"].includes(detail.status))
    return detail.status;
  if (
    invite.openedAt &&
    (!detail || Date.parse(invite.openedAt) >= Date.parse(detail.sentAt))
  )
    return "opened";
  if (detail) return detail.status;
  return "invited";
}
export function parseInvitationPage(payload: any) {
  if (
    !Array.isArray(payload?.entries) ||
    typeof payload.has_more !== "boolean" ||
    (payload.has_more &&
      (typeof payload.next_cursor !== "string" || !payload.next_cursor))
  )
    throw new Error("Unrecognized invitation list response.");
  const entries = payload.entries.map((entry: any) => {
    if (
      entry?.object !== "event_invite" ||
      typeof entry.api_id !== "string" ||
      !validDate(entry.created_at)
    )
      throw new Error("Unrecognized invitation record.");
    return {
      id: entry.api_id,
      createdAt: validDate(entry.created_at),
      openedAt: validDate(entry.opened_at),
      emailLower:
        typeof entry.email === "string"
          ? entry.email.trim().toLowerCase()
          : null,
      name: typeof entry.name === "string" ? entry.name : null,
      userId: entry.rsvp?.user_api_id || entry.user?.api_id || null,
      guestId: entry.rsvp?.api_id || null,
      rsvp: entry.rsvp?.approval_status || null,
    };
  });
  return {
    entries,
    hasMore: payload.has_more,
    cursor: payload.has_more ? payload.next_cursor : null,
  };
}
