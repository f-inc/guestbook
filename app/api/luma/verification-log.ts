import { appendFile, mkdir } from "node:fs/promises";

// Select diagnostic fields explicitly; never serialize whole requests or errors.
export function redactVerificationMessage(value: unknown, emails: string[] = []) {
  if (typeof value !== "string") return undefined;
  let message = value;
  for (const secret of [process.env.EMAILABLE_API_KEY, process.env.LUMA_API_KEY, ...emails]) {
    if (secret?.trim()) message = message.split(secret.trim()).join("[redacted]");
  }
  return message
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [redacted]")
    .replace(/[^\s"'<>(),;:]+@[^\s"'<>(),;:]+/g, "[email]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]")
    .replace(/[\r\n\t]/g, " ").slice(0, 500);
}

export async function logVerification(event: string, details: {
  runId?: string; batchId?: string | null; method?: string; endpoint?: string;
  httpStatus?: number; message?: string; providerMessage?: string; definitive?: boolean;
}) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), event: `email-verification ${event}`, ...details });
  console.error(line);
  try {
    await mkdir(".debug", { recursive: true });
    await appendFile(".debug/luma-api.log", line + "\n", { encoding: "utf8", mode: 0o600 });
  } catch {
    // Logging must not alter submission/retry behavior.
  }
}
