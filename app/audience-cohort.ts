export function audienceCohortLabel(cohort: string): string {
  return cohort === "not_attended" ? "Didn’t attend" : cohort;
}

// Registration question analytics contain registered guests only.
export function audienceAnswerCount(option: { count?: number; checkedInCount?: number }, cohort: string): number {
  const count = Number(option.count) || 0;
  const attended = Number(option.checkedInCount) || 0;
  if (cohort === "attended") return attended;
  if (cohort === "not_attended") return Math.max(0, count - attended);
  return count;
}
