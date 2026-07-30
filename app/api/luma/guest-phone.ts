type UnknownRecord = Record<string, unknown>;

const PHONE_QUESTION_TYPES = new Set([
  "phone",
  "phone-number",
  "telephone",
  "tel",
  "mobile",
]);

export function extractGuestPhoneNumber(guest: unknown, registrationAnswers: unknown[] = []) {
  const guestRecord = asRecord(guest);
  const user = asRecord(guestRecord.user);
  const direct = firstScalar(
    guestRecord.phone_number,
    guestRecord.phoneNumber,
    guestRecord.mobile_number,
    guestRecord.mobileNumber,
    user.phone_number,
    user.phoneNumber,
    user.mobile_number,
    user.mobileNumber,
  );
  if (direct) return direct;

  for (const value of registrationAnswers) {
    const answer = asRecord(value);
    const questionType = normalizeQuestionType(answer.questionType ?? answer.question_type ?? answer.type);
    const questionText = [
      firstScalar(answer.id),
      firstScalar(answer.label),
      firstScalar(answer.question_label),
      firstScalar(answer.question_text),
    ].join(" ");
    if (!PHONE_QUESTION_TYPES.has(questionType) && !/\b(phone|mobile|telephone)\b/i.test(questionText)) continue;

    const phoneNumber = firstScalar(answer.value, answer.answer, answer.response);
    if (phoneNumber) return phoneNumber;
  }

  return "";
}

function normalizeQuestionType(value: unknown) {
  return firstScalar(value).toLowerCase().replace(/[\s_]+/g, "-");
}

function firstScalar(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}
