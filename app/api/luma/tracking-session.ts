import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { prisma } from "./db";
import { lumaSessionTokens } from "./api-keys";
const SESSION_KEY = "tracking-session";
function encryptionKey(environment: Record<string, string | undefined>) {
  const secret =
    environment.LUMA_TRACKING_ENCRYPTION_KEY || environment.GUESTBOOK_KEY;
  if (!secret)
    throw new Error("Tracking session encryption requires a server secret.");
  return createHash("sha256")
    .update("guestbook:tracking-session:v1:")
    .update(secret)
    .digest();
}
export function encryptTrackingSession(
  token: string,
  environment: Record<string, string | undefined> = process.env,
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(environment), iv);
  cipher.setAAD(Buffer.from(SESSION_KEY));
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}
export function decryptTrackingSession(
  value: string,
  environment: Record<string, string | undefined> = process.env,
) {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext)
    throw new Error("Invalid saved tracking session.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(environment),
    Buffer.from(iv, "base64"),
  );
  decipher.setAAD(Buffer.from(SESSION_KEY));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
// Called only after at least one successful tracking request. Never log the value.
export async function saveTrackingSession(token: string) {
  const cursor = encryptTrackingSession(token);
  await prisma().lumaTrackingState.upsert({
    where: { key: SESSION_KEY },
    create: { key: SESSION_KEY, cursor },
    update: { cursor },
  });
}
export async function serverTrackingSession() {
  const saved = await prisma().lumaTrackingState.findUnique({
    where: { key: SESSION_KEY },
  });
  if (saved?.cursor) {
    try {
      return decryptTrackingSession(saved.cursor);
    } catch {
      /* A rotated server encryption key requires a fresh browser submission. */
    }
  }
  return lumaSessionTokens()[0]?.value;
}
