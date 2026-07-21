export const MAX_INVITE_MESSAGE_LENGTH = 200;

export function normalizeInviteMessage(message: unknown): string | null {
  if (message === undefined || message === null || message === "") return null;
  if (typeof message !== "string") throw badRequest("Invite message must be text.");
  const normalized = message.trim();
  if (!normalized) return null;
  if (normalized.length > MAX_INVITE_MESSAGE_LENGTH) {
    throw badRequest(`Invite message must be ${MAX_INVITE_MESSAGE_LENGTH} characters or fewer.`);
  }
  return normalized;
}

function badRequest(message: string) {
  const error: Error & { status?: number } = new Error(message);
  error.status = 400;
  return error;
}
