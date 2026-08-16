import {
  appendIndexedPersonComment,
  deleteIndexedPersonComment,
  hasLumaDb,
  listIndexedPersonComments,
  updateIndexedPersonComment,
} from "../luma/db";
import { requireGuestbookKey } from "../session-auth";
import { normalizeGuestComment, normalizeGuestCommentId } from "./guest-notes";

type HttpError = Error & { code?: string; status?: number };

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    requireGuestbookKey(request);
    requireDatabase();
    const personId = new URL(request.url).searchParams.get("person_id")?.trim() || "";
    if (!personId) return Response.json({ error: "A person id is required." }, { status: 400 });
    const comments = await listIndexedPersonComments(personId);
    return Response.json({ personId, comments: comments.map(apiComment) });
  } catch (error) {
    return errorResponse(error as HttpError, "load");
  }
}

export async function POST(request: Request) {
  try {
    requireGuestbookKey(request);
    requireDatabase();
    const body = await request.json() as { personId?: unknown; comment?: unknown };
    const personId = typeof body.personId === "string" ? body.personId.trim() : "";
    if (!personId) return Response.json({ error: "A person id is required." }, { status: 400 });

    const comment = await appendIndexedPersonComment({
      personId,
      body: normalizeGuestComment(body.comment),
      author: commentAuthor(),
    });
    clearEventGuestCaches();
    return Response.json({
      personId,
      comment: apiComment(comment),
      latestComment: comment.body,
      updatedAt: comment.createdAt.toISOString(),
    });
  } catch (error) {
    return errorResponse(error as HttpError, "save");
  }
}

export async function PATCH(request: Request) {
  try {
    requireGuestbookKey(request);
    requireDatabase();
    const body = await request.json() as { personId?: unknown; commentId?: unknown; comment?: unknown };
    const personId = requiredPersonId(body.personId);
    const result = await updateIndexedPersonComment({
      personId,
      commentId: normalizeGuestCommentId(body.commentId),
      body: normalizeGuestComment(body.comment),
    });
    clearEventGuestCaches();
    return Response.json({
      personId,
      comment: apiComment(result.comment),
      ...apiCommentSummary(result),
    });
  } catch (error) {
    return errorResponse(error as HttpError, "edit");
  }
}

export async function DELETE(request: Request) {
  try {
    requireGuestbookKey(request);
    requireDatabase();
    const body = await request.json() as { personId?: unknown; commentId?: unknown };
    const personId = requiredPersonId(body.personId);
    const result = await deleteIndexedPersonComment({
      personId,
      commentId: normalizeGuestCommentId(body.commentId),
    });
    clearEventGuestCaches();
    return Response.json({ personId, ...apiCommentSummary(result) });
  } catch (error) {
    return errorResponse(error as HttpError, "delete");
  }
}

function apiComment(comment: { id: bigint; body: string; author: string; createdAt: Date }) {
  return {
    id: comment.id.toString(),
    body: comment.body,
    author: comment.author,
    createdAt: comment.createdAt.toISOString(),
  };
}

function commentAuthor() {
  return String(process.env.GUESTBOOK_COMMENT_AUTHOR || "Guestbook").trim().slice(0, 80) || "Guestbook";
}

function requiredPersonId(value: unknown) {
  const personId = typeof value === "string" ? value.trim() : "";
  if (personId) return personId;
  const error = new Error("A person id is required.") as HttpError;
  error.status = 400;
  throw error;
}

function apiCommentSummary(result: { latestComment: { body: string; createdAt: Date } | null; commentCount: number }) {
  return {
    latestComment: result.latestComment?.body || "",
    updatedAt: result.latestComment?.createdAt.toISOString() || null,
    commentCount: result.commentCount,
  };
}

function requireDatabase() {
  if (hasLumaDb()) return;
  const error = new Error("Guest comments require DB_URL to be configured.") as HttpError;
  error.status = 503;
  throw error;
}

function clearEventGuestCaches() {
  const cache = (globalThis as typeof globalThis & { __guestbookLumaCache?: Map<string, unknown> }).__guestbookLumaCache;
  if (!cache) return;
  for (const key of cache.keys()) {
    if (key.startsWith("event-guests:")) cache.delete(key);
  }
}

function errorResponse(error: HttpError, action: "load" | "save" | "edit" | "delete") {
  const status = ["P2003", "P2025"].includes(error.code || "") ? 404 : error.status || 500;
  const message = status === 500
    ? action === "load"
      ? "Unable to load guest comments."
      : action === "edit"
        ? "Unable to edit guest comment."
        : action === "delete"
          ? "Unable to delete guest comment."
          : "Unable to add guest comment."
    : error.message;
  return Response.json({ error: message }, { status });
}
