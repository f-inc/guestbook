export const MAX_BULK_EMAILS = 2_000;

export type ParsedBulkEmails = {
  emails: string[];
  invalidEmails: string[];
};

export function parseBulkEmails(value: unknown): ParsedBulkEmails {
  const source = Array.isArray(value)
    ? value.map((item) => String(item ?? "")).join("\n")
    : typeof value === "string"
      ? value
      : "";
  const tokens = source
    .split(/[\s,;]+/)
    .map((item) => item.trim().toLocaleLowerCase())
    .filter(Boolean);
  const uniqueTokens = [...new Set(tokens)];
  if (!uniqueTokens.length) throw badRequest("Paste at least one email address.");
  if (uniqueTokens.length > MAX_BULK_EMAILS) {
    throw badRequest(`Bulk tagging supports up to ${MAX_BULK_EMAILS.toLocaleString()} unique emails at a time.`);
  }
  const emails: string[] = [];
  const invalidEmails: string[] = [];
  for (const email of uniqueTokens) {
    if (isEmail(email)) emails.push(email);
    else invalidEmails.push(email);
  }
  return { emails, invalidEmails };
}

function isEmail(value: string) {
  return value.length <= 320
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function badRequest(message: string) {
  const error = new Error(message) as Error & { status?: number };
  error.status = 400;
  return error;
}
