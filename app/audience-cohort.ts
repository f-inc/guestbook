export const NO_SHOW_AUDIENCE_STATUSES = ["going", "no_show"];

export function isNoShowAudienceGuest(guest: { status?: unknown; checkedInAt?: unknown }): boolean {
  return NO_SHOW_AUDIENCE_STATUSES.includes(typeof guest.status === "string" ? guest.status : "") && !guest.checkedInAt;
}

export function audienceCohortLabel(cohort: string): string {
  return cohort === "not_attended" ? "Didn’t attend" : cohort;
}

// Registration question analytics contain registered guests only.
export function audienceAnswerCount(option: { count?: number; checkedInCount?: number; noShowCount?: number }, cohort: string): number {
  const count = Number(option.count) || 0;
  const attended = Number(option.checkedInCount) || 0;
  if (cohort === "attended") return attended;
  if (cohort === "not_attended") return Number(option.noShowCount) || 0;
  return count;
}
