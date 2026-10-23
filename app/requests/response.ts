import type { SubmissionsResponse } from "./answers";

export async function readRequestsResponse(response: Response): Promise<SubmissionsResponse> {
  const contentType = response.headers.get("content-type") || "";
  const unavailable = "Requests are temporarily unavailable. Please try again in a few minutes.";
  if (response.headers.get("cf-mitigated") === "challenge" || response.headers.get("x-vercel-mitigated") === "challenge" || (response.status === 403 && contentType.includes("text/html"))) {
    throw new Error("Access to requests was blocked. Reload the page and try again.");
  }
  if (!contentType.toLowerCase().includes("application/json")) throw new Error(unavailable);

  let body: SubmissionsResponse & { error?: unknown };
  try {
    body = await response.json();
  } catch {
    throw new Error(unavailable);
  }
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : unavailable);
  if (!body || typeof body !== "object") throw new Error(unavailable);
  return body;
}
