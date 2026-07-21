export const MAX_PERSON_TAGS = 30;
export const MAX_TAG_LENGTH = 40;

type HttpError = Error & { status?: number };

export function normalizePersonTags(value: unknown): string[] {
  if (!Array.isArray(value)) throw httpError("Tags must be an array.", 400);
  if (value.length > MAX_PERSON_TAGS) throw httpError(`A person can have at most ${MAX_PERSON_TAGS} tags.`, 400);

  const tags: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") throw httpError("Every tag must be text.", 400);
    const tag = item.trim().replace(/\s+/g, " ");
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) throw httpError(`Tags must be ${MAX_TAG_LENGTH} characters or fewer.`, 400);
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags.sort((left, right) => left.localeCompare(right));
}

export function parseTagFilters(values: string[]): string[] {
  return normalizePersonTags(values.slice(0, MAX_PERSON_TAGS));
}

function httpError(message: string, status: number): HttpError {
  const error = new Error(message) as HttpError;
  error.status = status;
  return error;
}
