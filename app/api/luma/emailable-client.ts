export const VERIFICATION_STATES = ["deliverable", "undeliverable", "risky", "unknown"];
export function normalizeVerification(value: any) {
  if (!value || typeof value.email !== "string" || !VERIFICATION_STATES.includes(value.state))
    throw new Error("Emailable returned an unrecognized verification result.");
  return {
    emailLower: value.email.trim().toLowerCase(),
    state: value.state,
    reason: typeof value.reason === "string" ? value.reason.slice(0, 120) : null,
    score: Number.isInteger(value.score) && value.score >= 0 && value.score <= 100 ? value.score : null,
    flags: {
      acceptAll: value.accept_all === true,
      disposable: value.disposable === true,
      mailboxFull: value.mailbox_full === true,
      role: value.role === true,
    },
  };
}
export function parseVerificationBatch(payload: any, expected: string[]) {
  const complete = payload?.message === "Batch verification completed.";
  const expectedSet = new Set(expected);
  const results = (Array.isArray(payload?.emails) ? payload.emails : []).map(normalizeVerification);
  const seen = new Set<string>();
  for (const result of results) {
    if (!expectedSet.has(result.emailLower) || seen.has(result.emailLower))
      throw new Error("Emailable returned mismatched batch results.");
    seen.add(result.emailLower);
  }
  if (complete && seen.size !== expectedSet.size)
    throw new Error("Emailable returned an incomplete result set.");
  return { complete, results };
}
export async function emailableRequest(method: "GET" | "POST", batch?: { emails: string[] } | { id: string }, fetchImpl = fetch) {
  const key = process.env.EMAILABLE_API_KEY?.trim();
  if (!key) throw new Error("Set EMAILABLE_API_KEY on the server to enable verification.");
  const url = new URL("https://api.emailable.com/v1/batch");
  if (method === "GET" && batch && "id" in batch) {
    url.searchParams.set("id", batch.id);
    url.searchParams.set("partial", "true");
  }
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({ ...batch, response_fields: "email,state,reason,score,accept_all,disposable,mailbox_full,role" }) } : {}),
      signal: AbortSignal.timeout(30000), cache: "no-store",
    });
  } catch {
    throw new Error("Emailable could not be reached. Saved results are still available.");
  }
  if (!response.ok) {
    const error: any = new Error(response.status === 402 ? "Emailable needs more credits. Check your account and resume the scan." : response.status === 401 || response.status === 403 ? "Emailable rejected the API key. Update EMAILABLE_API_KEY and resume." : response.status === 429 ? "Emailable rate limit reached. Resume the scan shortly." : "Emailable request failed. Saved results are still available.");
    error.definitive = [400, 401, 402, 403, 422, 429].includes(response.status);
    throw error;
  }
  // Never propagate raw provider bodies or request headers into logs/errors.
  try { return await response.json(); } catch { throw new Error("Emailable returned an unreadable response."); }
}

export async function emailableCredits(fetchImpl = fetch): Promise<number> {
  const key = process.env.EMAILABLE_API_KEY?.trim();
  if (!key) throw new Error("Set EMAILABLE_API_KEY on the server to check credits.");
  let response: Response;
  try {
    response = await fetchImpl("https://api.emailable.com/v1/account", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000), cache: "no-store",
    });
  } catch { throw new Error("Unable to check Emailable credits. Try again."); }
  if (!response.ok) throw new Error("Unable to check Emailable credits. Check the API key and try again.");
  const data: any = await response.json();
  if (!Number.isSafeInteger(data.available_credits) || data.available_credits < 0)
    throw new Error("Emailable returned an invalid credit balance.");
  return data.available_credits;
}

export function verificationBudget(credits: number, requested: number) {
  if (!Number.isSafeInteger(credits) || credits < 0 || !Number.isSafeInteger(requested) || requested < 1)
    throw new Error("Invalid verification budget.");
  return Math.min(credits, requested);
}
