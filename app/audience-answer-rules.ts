export const ANY_REGISTRATION_ANSWER_KEY = "__any_registration_answer__";
export const ANY_REGISTRATION_ANSWER_LABEL = "Any response";

export function isAnyRegistrationAnswer(answerKey: unknown): boolean {
  return answerKey === ANY_REGISTRATION_ANSWER_KEY;
}
