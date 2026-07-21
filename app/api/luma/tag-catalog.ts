import { MAX_TAG_LENGTH } from "./person-tags";

export const DEFAULT_TAG_COLOR = "#0f766e";
export const TAG_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

type HttpError = Error & { status?: number };

export function normalizeTagName(value: unknown): string {
  if (typeof value !== "string") throw httpError("A tag name is required.", 400);
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw httpError("A tag name is required.", 400);
  if (name.length > MAX_TAG_LENGTH) throw httpError(`Tag names must be ${MAX_TAG_LENGTH} characters or fewer.`, 400);
  return name;
}

export function normalizeTagColor(value: unknown): string {
  if (value === undefined || value === null || value === "") return DEFAULT_TAG_COLOR;
  if (typeof value !== "string" || !TAG_COLOR_PATTERN.test(value)) {
    throw httpError("Tag colors must use a six-digit hex value.", 400);
  }
  return value.toLowerCase();
}

function httpError(message: string, status: number): HttpError {
  const error = new Error(message) as HttpError;
  error.status = status;
  return error;
}
