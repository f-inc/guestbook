export type LiveEventCounts = {
  eventId: string;
  accepted: number;
  waitlisted: number;
  pending: number;
  invited: number;
  declined: number;
  checkedIn: number;
  registered: number;
};

export type WrapperEventStats = {
  accepted?: unknown;
  confirmed?: unknown;
  waitlisted?: unknown;
  pending?: unknown;
  invitedNoResponse?: unknown;
  declined?: unknown;
  checkedIn?: unknown;
  registered?: unknown;
};

function guestCount(value: unknown) {
  const nested = value && typeof value === "object" && "guests" in value
    ? (value as { guests?: unknown }).guests
    : value;
  const count = Number(nested);
  return Number.isFinite(count) ? Math.max(0, count) : 0;
}

export function liveEventCountsFromLumaEvent(event: Record<string, any>): LiveEventCounts {
  const counts = event?.guest_counts || {};
  const accepted = guestCount(counts.approved);
  const waitlisted = guestCount(counts.waitlist);
  const pending = guestCount(counts.pending_approval);
  return {
    eventId: String(event?.id || ""),
    accepted,
    waitlisted,
    pending,
    invited: guestCount(counts.invited),
    declined: guestCount(counts.declined),
    checkedIn: guestCount(counts.checked_in),
    registered: accepted + waitlisted + pending,
  };
}

export function changedLiveEventCountKeys(stats: WrapperEventStats | null | undefined, live: LiveEventCounts) {
  if (!stats) return [];
  const wrapper = {
    accepted: Number(stats.accepted ?? stats.confirmed),
    waitlisted: Number(stats.waitlisted),
    pending: Number(stats.pending),
    invited: Number(stats.invitedNoResponse),
    declined: Number(stats.declined),
    checkedIn: Number(stats.checkedIn),
  };
  if (Object.values(wrapper).some((value) => !Number.isFinite(value))) return [];
  // Guestbook's Registered cohort also includes declined guests with an actual
  // registration timestamp. Luma's event summary cannot distinguish those from
  // invite-only declines, so compare the underlying status counts instead.
  return (["accepted", "waitlisted", "pending", "invited", "declined", "checkedIn"] as const)
    .filter((key) => wrapper[key] !== live[key]);
}

export function mergeLiveEventCounts(
  stats: WrapperEventStats | null | undefined,
  live: LiveEventCounts,
): WrapperEventStats {
  return {
    ...(stats || {}),
    accepted: live.accepted,
    confirmed: live.accepted,
    waitlisted: live.waitlisted,
    pending: live.pending,
    invitedNoResponse: live.invited,
    declined: live.declined,
    checkedIn: live.checkedIn,
    registered: live.registered,
  };
}
