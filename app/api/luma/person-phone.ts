export const MAX_PERSON_PHONE_LENGTH = 80;

export function normalizePersonPhoneNumber(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw badRequest("Phone number must be text.");

  const phoneNumber = value.trim().replace(/\s+/g, " ");
  if (phoneNumber.length > MAX_PERSON_PHONE_LENGTH) {
    throw badRequest(`Phone number must be ${MAX_PERSON_PHONE_LENGTH} characters or fewer.`);
  }
  if (phoneNumber && !/\d/.test(phoneNumber)) {
    throw badRequest("Phone number must contain at least one digit.");
  }
  return phoneNumber;
}

function badRequest(message: string) {
  const error = new Error(message) as Error & { status?: number };
  error.status = 400;
  return error;
}
