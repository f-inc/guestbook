import { timingSafeEqual } from "node:crypto";
export function requireCioWorker(request: Request) {
  const actual = (request.headers.get("authorization") || "").replace(/^Bearer /, "");
  const secrets = [process.env.CIO_SYNC_SECRET, process.env.CRON_SECRET].filter((s): s is string => Boolean(s && s.length >= 32));
  if (!secrets.some(secret => Buffer.byteLength(secret) === Buffer.byteLength(actual) && timingSafeEqual(Buffer.from(secret), Buffer.from(actual)))) {
    throw Object.assign(new Error("Unauthorized sync worker"), { status: 401 });
  }
}
