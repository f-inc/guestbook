// Always provisions a disposable PostgreSQL cluster. Never uses app credentials.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";

const root = mkdtempSync("/private/tmp/guestbook-webhook-test-");
const data = resolve(root, "data");
const socket = resolve(root, "socket");
mkdirSync(socket, { mode: 0o700 });
const url = `postgresql://webhook_test@localhost/postgres?host=${encodeURIComponent(socket)}&port=5432`;
const env = { ...process.env, DB_URL: url, DB_NOTIFY_URL: url, WEBHOOK_TEST_DATABASE_URL: url,
  GUESTBOOK_DEBUG_LOG_PATH: resolve(root, "api.log"),
  WEBHOOK_TEST_DATA_DIRECTORY: data, GUESTBOOK_IDENTITY_MODE: "legacy", NODE_ENV: "test" };
let started = false;
try {
  execFileSync("initdb", ["-D", data, "-U", "webhook_test", "-A", "trust", "--no-locale", "-E", "UTF8"], { stdio: "pipe" });
  execFileSync("pg_ctl", ["-D", data, "-l", resolve(root, "postgres.log"), "-o", `-k ${socket} -c listen_addresses='' -p 5432`, "-w", "start"], { stdio: "pipe" });
  started = true;
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const result = await db.query("SHOW data_directory");
    if (result.rows[0].data_directory !== data) throw new Error("Refusing an unverified test database.");
  } finally { await db.end(); }
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate"], { env, stdio: "pipe" });
  const migration = readFileSync("prisma/manual-migrations/20261122_webhook_inbox.sql", "utf8");
  const schema = new Client({ connectionString: url });
  await schema.connect();
  try { await schema.query(migration); await schema.query(migration); } finally { await schema.end(); }
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "app/api/luma/webhooks-inbox.integration.ts"], { env, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
  if (process.exitCode === 0) {
    const handoff = spawnSync(process.execPath, ["--import", "tsx", "--test", "app/api/luma/database-handoff.integration.ts"], { env, stdio: "inherit" });
    process.exitCode = handoff.status ?? 1;
  }
} finally {
  if (started) execFileSync("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"], { stdio: "pipe" });
  rmSync(root, { recursive: true, force: true });
}
