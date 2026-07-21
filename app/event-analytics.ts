type AnalyticsCounts = {
  accepted: number;
  checkedIn: number;
  firstRegisters: number;
  newFaces: number;
  referredAccepted: number;
  referredCheckedIn: number;
  referredFirstRegisters: number;
  referredRegistrations: number;
  referredReturning: number;
  registrations: number;
  returningAccepted: number;
};

type GuestStats = {
  accepted?: unknown;
  checkedIn?: unknown;
  firstRegisters?: unknown;
  newFaces?: unknown;
  invited?: unknown;
  referredAccepted?: unknown;
  referredCheckedIn?: unknown;
  referredFirstRegisters?: unknown;
  referredRegistrations?: unknown;
  referredReturning?: unknown;
  registered?: unknown;
  total?: unknown;
};

type RegistrationAnswerRow = {
  personId: string;
  registrationAnswers?: unknown;
};

export const REFERRED_PERSON_TAG = "\u{1f48e} Referred";

export function eventWideAnalyticsCounts(stats: GuestStats | null | undefined, fallback: AnalyticsCounts): AnalyticsCounts {
  const total = nonnegativeCount(stats?.total);
  if (total === null) return fallback;

  const registrations = Math.min(total, nonnegativeCount(stats?.registered) ?? fallback.registrations);
  const accepted = Math.min(registrations, nonnegativeCount(stats?.accepted) ?? fallback.accepted);
  const checkedIn = Math.min(accepted, nonnegativeCount(stats?.checkedIn) ?? fallback.checkedIn);
  const firstRegisters = Math.min(
    accepted,
    nonnegativeCount(stats?.firstRegisters) ?? fallback.firstRegisters,
  );
  const newFaces = Math.min(
    checkedIn,
    nonnegativeCount(stats?.newFaces) ?? fallback.newFaces,
  );
  const referredRegistrations = Math.min(
    registrations,
    nonnegativeCount(stats?.referredRegistrations) ?? fallback.referredRegistrations,
  );
  const referredAccepted = Math.min(
    accepted,
    referredRegistrations,
    nonnegativeCount(stats?.referredAccepted) ?? fallback.referredAccepted,
  );
  const referredCheckedIn = Math.min(
    checkedIn,
    referredAccepted,
    nonnegativeCount(stats?.referredCheckedIn) ?? fallback.referredCheckedIn,
  );
  const referredFirstRegisters = Math.min(
    firstRegisters,
    referredAccepted,
    nonnegativeCount(stats?.referredFirstRegisters) ?? fallback.referredFirstRegisters,
  );
  const returningAccepted = Math.max(0, accepted - firstRegisters);
  const referredReturning = Math.min(
    returningAccepted,
    Math.max(0, referredAccepted - referredFirstRegisters),
    nonnegativeCount(stats?.referredReturning) ?? fallback.referredReturning,
  );

  return {
    registrations,
    accepted,
    checkedIn,
    firstRegisters,
    newFaces,
    referredRegistrations,
    referredAccepted,
    referredCheckedIn,
    referredFirstRegisters,
    referredReturning,
    returningAccepted,
  };
}

export function buildRegistrationQuestionAnalytics(rows: RegistrationAnswerRow[]) {
  const answerGroups = new Map<string, { id: string; label: string; responses: Array<{ id: string; value: string; personId: string }> }>();
  rows.forEach(({ personId, registrationAnswers }) => {
    if (!Array.isArray(registrationAnswers)) return;
    registrationAnswers.forEach((answer: any) => {
      const label = String(answer?.label || "Question").trim();
      const value = String(answer?.value ?? "").trim();
      if (!value || !isAnalyticQuestion(label)) return;
      const id = label.toLocaleLowerCase();
      if (!answerGroups.has(id)) answerGroups.set(id, { id, label, responses: [] });
      answerGroups.get(id)?.responses.push({ id: `${personId}:${answer?.id || label}`, value, personId });
    });
  });

  return [...answerGroups.values()]
    .map((question) => {
      const counts = new Map<string, number>();
      question.responses.forEach((response) => counts.set(response.value, (counts.get(response.value) || 0) + 1));
      const options = [...counts.entries()]
        .map(([label, count]) => ({ label, count, percent: Math.round((count / question.responses.length) * 100) }))
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
      const categorical = options.length <= 8 && options.every((option) => option.label.length <= 64);
      return {
        ...question,
        responseCount: question.responses.length,
        kind: categorical ? "categorical" : "text",
        options: categorical ? options : [],
        responses: categorical ? [] : question.responses.slice(0, 6),
      };
    })
    .sort((left, right) => right.responseCount - left.responseCount || left.label.localeCompare(right.label));
}

function nonnegativeCount(value: unknown): number | null {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
}

function isAnalyticQuestion(label: string) {
  const normalized = label.toLocaleLowerCase();
  return !["twitter", "linkedin", "instagram", "github", "website", "portfolio", "phone number", "email address"]
    .some((term) => normalized.includes(term));
}
