type AnalyticsCounts = {
  accepted: number;
  checkedIn: number;
  newPeople: number;
  registrations: number;
  returning: number;
};

type GuestStats = {
  accepted?: unknown;
  checkedIn?: unknown;
  invited?: unknown;
  newFaces?: unknown;
  total?: unknown;
};

type RegistrationAnswerRow = {
  personId: string;
  registrationAnswers?: unknown;
};

export function eventWideAnalyticsCounts(stats: GuestStats | null | undefined, fallback: AnalyticsCounts): AnalyticsCounts {
  const total = nonnegativeCount(stats?.total);
  if (total === null) return fallback;

  const invited = nonnegativeCount(stats?.invited) ?? 0;
  const registrations = Math.max(0, total - invited);
  const accepted = Math.min(registrations, nonnegativeCount(stats?.accepted) ?? fallback.accepted);
  const checkedIn = Math.min(accepted, nonnegativeCount(stats?.checkedIn) ?? fallback.checkedIn);
  const newPeople = Math.min(registrations, nonnegativeCount(stats?.newFaces) ?? fallback.newPeople);

  return {
    registrations,
    accepted,
    checkedIn,
    newPeople,
    returning: Math.max(0, registrations - newPeople),
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
