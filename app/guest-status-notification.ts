export const MAX_GUEST_STATUS_MESSAGE_LENGTH = 200;

type GuestStatusNotificationInput = {
  message?: unknown;
  sendEmail?: unknown;
};

type HttpError = Error & { status?: number };

export function normalizeGuestStatusNotification({ sendEmail, message }: GuestStatusNotificationInput = {}) {
  if (message !== undefined && message !== null && typeof message !== "string") {
    throw badRequest("Guest status message must be text.");
  }

  const normalizedMessage = typeof message === "string" ? message.trim() : "";
  if (normalizedMessage.length > MAX_GUEST_STATUS_MESSAGE_LENGTH) {
    throw badRequest(`Guest status message must be ${MAX_GUEST_STATUS_MESSAGE_LENGTH} characters or fewer.`);
  }

  const normalizedSendEmail = sendEmail === true;
  if (normalizedMessage && !normalizedSendEmail) {
    throw badRequest("Guest status message requires email notification to be enabled.");
  }

  return {
    sendEmail: normalizedSendEmail,
    message: normalizedMessage || null,
  };
}

function badRequest(message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.status = 400;
  return error;
}
