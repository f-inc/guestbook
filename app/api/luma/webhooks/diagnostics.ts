import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function logWebhook(event: string, details: { requestId: string; status?: number; type?: string; duplicate?: boolean }) {
  const record = JSON.stringify({ timestamp: new Date().toISOString(), event: `webhook ${event}`, ...details });
  console.log(record);
  if (process.env.VERCEL === "1") return;
  try {
    const file = process.env.GUESTBOOK_DEBUG_LOG_PATH || join(process.cwd(), ".debug", "luma-api.log");
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, record + "\n", "utf8");
  } catch { /* Diagnostics cannot affect durable acceptance. */ }
}
