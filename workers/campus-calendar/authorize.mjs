// One-time, local-only OAuth setup. Never prints or serves credentials.
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFile, mkdir, writeFile, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const clientFile = process.argv[2];
const output = resolve(process.argv[3] || "workers/campus-calendar/.local/google-oauth.json");
const deployment = JSON.parse(await readFile(new URL("./wrangler.local.jsonc", import.meta.url), "utf8"));
const setup = JSON.parse(await readFile(new URL("./.local/authorization.json", import.meta.url), "utf8"));
const calendar = deployment.vars?.GOOGLE_CALENDAR_ID;
if (!calendar || calendar.startsWith("REPLACE_WITH_") || !setup.login_hint) throw new Error("Configure the local destination calendar and OAuth login hint first.");
if (!clientFile) throw new Error("Usage: node workers/campus-calendar/authorize.mjs /path/to/downloaded-client.json [output]");
const parsed = JSON.parse(await readFile(clientFile, "utf8"));
const client = parsed.installed;
if (!client?.client_id || !client.client_secret) throw new Error("A Desktop OAuth client JSON is required.");
const state = randomBytes(32).toString("base64url");
const verifier = randomBytes(48).toString("base64url");
const redirect = "http://127.0.0.1:8977/callback";
const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authorize.search = new URLSearchParams({
  client_id: client.client_id, redirect_uri: redirect, response_type: "code",
  scope: "https://www.googleapis.com/auth/calendar.events", access_type: "offline",
  prompt: "consent", login_hint: setup.login_hint, state,
  code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
}).toString();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, redirect);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (url.pathname !== "/callback") { res.writeHead(404); res.end("Not found"); return; }
  if (url.searchParams.get("state") !== state) { res.writeHead(403); res.end("Invalid OAuth state"); return; }
  if (!url.searchParams.get("code")) { res.writeHead(400); res.end("Authorization was not granted."); return; }
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret,
        grant_type: "authorization_code", code: url.searchParams.get("code"), redirect_uri: redirect, code_verifier: verifier }),
    });
    if (!response.ok) throw new Error("Google token exchange failed.");
    const tokens = await response.json();
    if (!tokens.refresh_token || !tokens.scope?.split(" ").includes("https://www.googleapis.com/auth/calendar.events")) throw new Error("Offline calendar authorization was not granted.");
    // Verify this account can edit the exact destination before retaining its credential.
    const check = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar)}/events?maxResults=1`, { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(15_000) });
    if (!check.ok) throw new Error("Unable to read the destination calendar; check API enablement and account access.");
    const calendarResult = await check.json();
    if (!["writer", "owner"].includes(calendarResult.accessRole)) throw new Error("This Google account cannot edit the destination calendar.");
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await chmod(dirname(output), 0o700);
    await writeFile(output, JSON.stringify({ client_id: client.client_id, client_secret: client.client_secret, refresh_token: tokens.refresh_token }), { mode: 0o600 });
    await chmod(output, 0o600);
    res.end("Google authorization saved securely. You can close this tab.");
    console.log("Google authorization saved; destination calendar edit permission verified. No events changed.");
    clearTimeout(expiry); server.close();
  } catch (error) {
    res.writeHead(500); res.end(error.message); console.error(error.message);
  }
});
const expiry = setTimeout(() => { console.error("Authorization timed out. Run the setup again."); server.close(); }, 15 * 60_000);
server.listen(8977, "127.0.0.1", () => console.log(`Open this URL to authorize:\n${authorize}`));
