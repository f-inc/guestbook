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
  checkedInAt?: unknown;
  status?: unknown;
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
  type RegistrationResponse = {
    id: string;
    value: string;
    values: string[];
    hasExplicitValues: boolean;
    multiSelect: boolean;
    personId: string;
    checkedIn: boolean;
  };
  const answerGroups = new Map<string, { id: string; label: string; responses: RegistrationResponse[] }>();
  rows.forEach(({ personId, registrationAnswers, checkedInAt, status }) => {
    if (!Array.isArray(registrationAnswers)) return;
    registrationAnswers.forEach((answer: any) => {
      const label = String(answer?.label || "Question").trim();
      const value = String(answer?.value ?? "").trim();
      if (!value || !isAnalyticQuestion(label)) return;
      const explicitValues: string[] = Array.isArray(answer?.values)
        ? [...new Set<string>((answer.values as unknown[]).map((item) => String(item ?? "").trim()).filter(Boolean))]
        : [];
      const multiSelect = isMultiSelectQuestionType(answer?.questionType) || explicitValues.length > 1;
      const id = label.toLocaleLowerCase();
      if (!answerGroups.has(id)) answerGroups.set(id, { id, label, responses: [] });
      answerGroups.get(id)?.responses.push({
        id: `${personId}:${answer?.id || label}`,
        value,
        values: explicitValues.length ? explicitValues : [value],
        hasExplicitValues: explicitValues.length > 0,
        multiSelect,
        personId,
        checkedIn: Boolean(checkedInAt) || status === "checked_in",
      });
    });
  });

  return [...answerGroups.values()]
    .map((question) => {
      const groups = new Map<string, { answerKey: string; count: number; checkedInCount: number; variants: Map<string, number> }>();
      const multiSelect = question.responses.some((response) => response.multiSelect);
      const legacySelections = inferLegacyMultiSelectSelections(question.responses);
      question.responses.forEach((response, responseIndex) => {
        const selections = response.hasExplicitValues
          ? response.values
          : multiSelect
            ? legacySelections[responseIndex]
            : [response.value];
        const uniqueSelections = new Map(selections.map((selection) => [normalizeRegistrationAnswer(selection), selection]));
        uniqueSelections.forEach((selection, answerKey) => {
          const group = groups.get(answerKey) || { answerKey, count: 0, checkedInCount: 0, variants: new Map<string, number>() };
          group.count += 1;
          if (response.checkedIn) group.checkedInCount += 1;
          group.variants.set(selection, (group.variants.get(selection) || 0) + 1);
          groups.set(answerKey, group);
        });
      });
      const maxCount = Math.max(...[...groups.values()].map((group) => group.count));
      const options = [...groups.values()].map((group) => {
        const label = [...group.variants.entries()]
          .sort((left, right) => right[1] - left[1] || registrationAnswerLabelScore(right[0]) - registrationAnswerLabelScore(left[0]))[0][0];
        return {
          label,
          answerKey: group.answerKey,
          count: group.count,
          checkedInCount: group.checkedInCount,
          percent: maxCount ? Math.max(1, Math.round((group.count / maxCount) * 100)) : 0,
          checkedInPercent: maxCount && group.checkedInCount ? Math.max(1, Math.round((group.checkedInCount / maxCount) * 100)) : 0,
          attendanceRate: group.count ? Math.round((group.checkedInCount / group.count) * 100) : 0,
        };
      });
      sortRegistrationQuestionOptions(options);
      const categorical = (multiSelect || options.length <= 8 || isFounderStageQuestion(options))
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

function isMultiSelectQuestionType(value: unknown): boolean {
  const normalized = String(value ?? "").toLocaleLowerCase().replace(/[_\s]+/g, "-");
  return ["multi-select", "multiselect", "checkbox", "checkboxes"].includes(normalized);
}

function inferLegacyMultiSelectSelections<T extends { value: string; values: string[]; hasExplicitValues: boolean }>(responses: T[]): string[][] {
  const explicitChoices = responses.flatMap((response) => response.hasExplicitValues ? response.values : []);
  const legacyValues = [...new Map(
    responses
      .filter((response) => !response.hasExplicitValues)
      .map((response) => [normalizedSelectionText(response.value), response.value]),
  ).entries()].filter(([key]) => key);
  const containedChoices = legacyValues
    .filter(([candidate]) => legacyValues.some(([other]) => other !== candidate && containsTokenSequence(other, candidate)))
    .map(([, display]) => display);
  const candidates = [...new Map([...explicitChoices, ...containedChoices]
    .map((choice) => [normalizedSelectionText(choice), choice]))]
    .filter(([key]) => key)
    .sort(([left], [right]) => left.split(" ").length - right.split(" ").length || left.length - right.length)
    .reduce<Array<{ key: string; label: string; tokens: string[] }>>((atomic, [key, label]) => {
      const tokens = key.split(" ");
      const segmented = segmentSelectionTokens(tokens, atomic);
      if (!segmented || segmented.length < 2) atomic.push({ key, label, tokens });
      return atomic;
    }, []);

  return responses.map((response) => {
    if (response.hasExplicitValues) return response.values;
    const segmented = segmentSelectionTokens(normalizedSelectionText(response.value).split(" "), candidates);
    return segmented?.map((choice) => choice.label) || [response.value];
  });
}

function normalizedSelectionText(value: string): string {
  return String(value).normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function containsTokenSequence(value: string, candidate: string): boolean {
  return (` ${value} `).includes(` ${candidate} `);
}

function segmentSelectionTokens<T extends { tokens: string[] }>(tokens: string[], choices: T[]): T[] | null {
  if (!tokens.length || !choices.length) return null;
  const memo = new Map<number, T[] | null>();
  const visit = (offset: number): T[] | null => {
    if (offset === tokens.length) return [];
    if (memo.has(offset)) return memo.get(offset) || null;
    for (const choice of choices) {
      if (!choice.tokens.every((token, index) => tokens[offset + index] === token)) continue;
      const remainder = visit(offset + choice.tokens.length);
      if (remainder) {
        const result = [choice, ...remainder];
        memo.set(offset, result);
        return result;
      }
    }
    memo.set(offset, null);
    return null;
  };
  return visit(0);
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
