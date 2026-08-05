type AnalyticsCounts = {
  accepted: number;
  checkedIn: number;
  firstRegisters: number;
  newRegistrations: number;
  newReferrals: number;
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
  newRegistrations?: unknown;
  newReferrals?: unknown;
  newFaces?: unknown;
  invited?: unknown;
  referredAccepted?: unknown;
  referredCheckedIn?: unknown;
  referredFirstRegisters?: unknown;
  referredRegistrations?: unknown;
  referredReturning?: unknown;
  registered?: unknown;
  total?: unknown;
  invitationTotal?: unknown;
  invitedGoing?: unknown;
  invitedCheckedIn?: unknown;
  invitedNoShow?: unknown;
  invitedNoResponse?: unknown;
  invitedDeclined?: unknown;
  invitedReferralTotal?: unknown;
  invitedReferralGoing?: unknown;
  invitedReferralCheckedIn?: unknown;
  invitedReferralNoShow?: unknown;
  invitedReferralNoResponse?: unknown;
  invitedReferralDeclined?: unknown;
};

type InvitationGuest = {
  status?: unknown;
  invitedAt?: unknown;
  checkedInAt?: unknown;
  isReferred?: unknown;
};

type RegistrationAnswerRow = {
  personId: string;
  registrationAnswers?: unknown;
};

export const REFERRED_PERSON_TAG = "\u{1f48e} Referred";

export function invitationOutcomeCounts(stats: GuestStats | null | undefined, guests: InvitationGuest[]) {
  const invitedGuests = guests.filter((guest) => Boolean(guest.invitedAt) || guest.status === "invited");
  const fallback = {
    total: invitedGuests.length,
    going: invitedGuests.filter((guest) => guest.status === "going").length,
    checkedIn: invitedGuests.filter((guest) => guest.status === "checked_in" || Boolean(guest.checkedInAt)).length,
    noShow: invitedGuests.filter((guest) => guest.status === "no_show").length,
    noResponse: invitedGuests.filter((guest) => guest.status === "invited").length,
    declined: invitedGuests.filter((guest) => guest.status === "declined").length,
    referralTotal: invitedGuests.filter((guest) => guest.isReferred).length,
    referralGoing: invitedGuests.filter((guest) => guest.isReferred && guest.status === "going").length,
    referralCheckedIn: invitedGuests.filter((guest) => guest.isReferred && (guest.status === "checked_in" || Boolean(guest.checkedInAt))).length,
    referralNoShow: invitedGuests.filter((guest) => guest.isReferred && guest.status === "no_show").length,
    referralNoResponse: invitedGuests.filter((guest) => guest.isReferred && guest.status === "invited").length,
    referralDeclined: invitedGuests.filter((guest) => guest.isReferred && guest.status === "declined").length,
  };
  return {
    total: nonnegativeCount(stats?.invitationTotal) ?? fallback.total,
    going: nonnegativeCount(stats?.invitedGoing) ?? fallback.going,
    checkedIn: nonnegativeCount(stats?.invitedCheckedIn) ?? fallback.checkedIn,
    noShow: nonnegativeCount(stats?.invitedNoShow) ?? fallback.noShow,
    noResponse: nonnegativeCount(stats?.invitedNoResponse) ?? fallback.noResponse,
    declined: nonnegativeCount(stats?.invitedDeclined) ?? fallback.declined,
    referralTotal: nonnegativeCount(stats?.invitedReferralTotal) ?? fallback.referralTotal,
    referralGoing: nonnegativeCount(stats?.invitedReferralGoing) ?? fallback.referralGoing,
    referralCheckedIn: nonnegativeCount(stats?.invitedReferralCheckedIn) ?? fallback.referralCheckedIn,
    referralNoShow: nonnegativeCount(stats?.invitedReferralNoShow) ?? fallback.referralNoShow,
    referralNoResponse: nonnegativeCount(stats?.invitedReferralNoResponse) ?? fallback.referralNoResponse,
    referralDeclined: nonnegativeCount(stats?.invitedReferralDeclined) ?? fallback.referralDeclined,
  };
}

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
  const newRegistrations = Math.min(
    registrations,
    nonnegativeCount(stats?.newRegistrations) ?? fallback.newRegistrations,
  );
  const newFaces = Math.min(
    checkedIn,
    nonnegativeCount(stats?.newFaces) ?? fallback.newFaces,
  );
  const referredRegistrations = Math.min(
    registrations,
    nonnegativeCount(stats?.referredRegistrations) ?? fallback.referredRegistrations,
  );
  const newReferrals = Math.min(
    checkedIn,
    referredRegistrations,
    nonnegativeCount(stats?.newReferrals) ?? fallback.newReferrals,
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
    newRegistrations,
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
    newRegistrations,
    newFaces,
    newReferrals,
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
      const groups = new Map<string, { answerKey: string; count: number; variants: Map<string, number> }>();
      question.responses.forEach((response) => {
        const answerKey = normalizeRegistrationAnswer(response.value);
        const group = groups.get(answerKey) || { answerKey, count: 0, variants: new Map<string, number>() };
        group.count += 1;
        group.variants.set(response.value, (group.variants.get(response.value) || 0) + 1);
        groups.set(answerKey, group);
      });
      const maxCount = Math.max(...[...groups.values()].map((group) => group.count));
      const options = [...groups.values()].map((group) => {
        const label = [...group.variants.entries()]
          .sort((left, right) => right[1] - left[1] || registrationAnswerLabelScore(right[0]) - registrationAnswerLabelScore(left[0]))[0][0];
        return {
          label,
          answerKey: group.answerKey,
          count: group.count,
          percent: maxCount ? Math.round((group.count / maxCount) * 100) : 0,
        };
      });
      sortRegistrationQuestionOptions(options);
      const categorical = (options.length <= 8 || isFounderStageQuestion(options))
        && options.every((option) => option.label.length <= 64);
      const aggregate = !categorical && maxCount > 3;
      return {
        ...question,
        responseCount: question.responses.length,
        kind: categorical ? "categorical" : aggregate ? "aggregated" : "text",
        options: categorical || aggregate ? options : [],
        responses: categorical || aggregate ? [] : question.responses,
      };
    })
    .sort((left, right) => right.responseCount - left.responseCount || left.label.localeCompare(right.label));
}

export function normalizeRegistrationAnswer(value: string): string {
  const normalized = String(value).normalize("NFKC").toLocaleLowerCase().trim();
  return normalized.replace(/[^\p{L}\p{N}]+/gu, "") || normalized;
}

function registrationAnswerLabelScore(label: string): number {
  const hasReadableWordBreak = /[\p{L}\p{N}]\s+[\p{L}\p{N}]/u.test(label);
  const hasNaturalCapitalization = /\p{Lu}/u.test(label) && /\p{Ll}/u.test(label);
  return Number(hasReadableWordBreak) * 2 + Number(hasNaturalCapitalization);
}

export function sortRegistrationQuestionOptions<T extends { label: string; count: number }>(options: T[]): T[] {
  if (!isFounderStageQuestion(options)) {
    return options.sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  }
  return options.sort((left, right) => {
    const stageOrder = founderStageOrder(left.label) - founderStageOrder(right.label);
    return stageOrder || right.count - left.count || left.label.localeCompare(right.label);
  });
}

function isFounderStageQuestion(options: Array<{ label: string }>): boolean {
  const labels = options.map(({ label }) => normalizedOptionLabel(label));
  return ["launched", "shipped prototype", "tinkering", "quitting job soon"]
    .every((stage) => labels.some((label) => label.includes(stage)));
}

function founderStageOrder(label: string): number {
  const normalized = normalizedOptionLabel(label);
  if (normalized.includes("quitting job soon")) return 1;
  if (normalized.includes("have a job") || normalized.includes("working a job") || normalized.includes("employed")) return 0;
  if (normalized.includes("tinkering")) return 2;
  if (normalized.includes("shipped prototype")) return 3;
  if (normalized.includes("launched")) return 4;
  if (normalized.includes("off zero")) return 5;
  if (normalized.includes("raised pre seed") || normalized.includes("raised preseed")) return 6;
  if (normalized.includes("raised seed")) return 7;
  return 8;
}

function normalizedOptionLabel(label: string): string {
  return String(label).toLocaleLowerCase().replace(/[\u2010-\u2015_-]+/g, " ").replace(/\s+/g, " ").trim();
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
