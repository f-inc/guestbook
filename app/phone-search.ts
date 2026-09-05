const PHONE_QUERY_CHARACTERS = /^[\d\s()+.\-\u00a0]+$/;

export function phoneSearchDigits(value: unknown): string {
  const text = String(value || "").trim();
  if (!text || !PHONE_QUERY_CHARACTERS.test(text)) return "";
  const digits = text.replace(/\D/g, "");
  return digits.length >= 3 ? digits : "";
}

export function phoneMatchesSearch(phoneNumber: unknown, search: unknown): boolean {
  const queryDigits = phoneSearchDigits(search);
  if (!queryDigits) return false;
  return String(phoneNumber || "").replace(/\D/g, "").includes(queryDigits);
}
