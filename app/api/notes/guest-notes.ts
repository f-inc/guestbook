export const MAX_GUEST_NOTE_LENGTH = 20_000;

export function normalizeGuestNote(value: unknown): string {
  if (typeof value !== "string") {
    const error = new Error("Guest notes must be text.") as Error & { status?: number };
    error.status = 400;
    throw error;
  }

  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length > MAX_GUEST_NOTE_LENGTH) {
    const error = new Error(`Guest notes cannot exceed ${MAX_GUEST_NOTE_LENGTH.toLocaleString()} characters.`) as Error & { status?: number };
    error.status = 400;
    throw error;
  }
  return normalized;
}

export function normalizeGuestComment(value: unknown): string {
  const normalized = normalizeGuestNote(value);
  if (normalized) return normalized;
  const error = new Error("Write a comment before adding it.") as Error & { status?: number };
  error.status = 400;
  throw error;
}

export function normalizeGuestCommentId(value: unknown): bigint {
  const normalized = typeof value === "bigint" ? value.toString() : typeof value === "string" ? value.trim() : "";
  if (/^[1-9]\d*$/.test(normalized)) return BigInt(normalized);
  const error = new Error("A valid comment id is required.") as Error & { status?: number };
  error.status = 400;
  throw error;
}
