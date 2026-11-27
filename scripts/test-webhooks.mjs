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
// Never inherit live database routing, handoff flags or provider credentials.
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(DB_|LUMA_|GUESTBOOK_|WEBHOOK_TEST_|PG|DATABASE_URL$|DIRECT_URL$)/.test(key),
  ),
);
const env = {
  ...inherited,
  DB_URL: url,
  DB_RUNTIME_URL: url,
  DB_NOTIFY_URL: url,
  WEBHOOK_TEST_DATABASE_URL: url,
  GUESTBOOK_DEBUG_LOG_PATH: resolve(root, "api.log"),
  WEBHOOK_TEST_DATA_DIRECTORY: data,
  GUESTBOOK_IDENTITY_MODE: "legacy",
  NODE_ENV: "test",
};
let started = false;
try {
  execFileSync(
    "initdb",
    ["-D", data, "-U", "webhook_test", "-A", "trust", "--no-locale", "-E", "UTF8"],
    { stdio: "pipe" },
  );
  execFileSync(
    "pg_ctl",
    [
      "-D",
      data,
      "-l",
      resolve(root, "postgres.log"),
      "-o",
      `-k ${socket} -c listen_addresses='' -p 5432`,
      "-w",
      "start",
    ],
    { stdio: "pipe" },
  );
  started = true;
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const result = await db.query("SHOW data_directory");
    if (result.rows[0].data_directory !== data)
      throw new Error("Refusing an unverified test database.");
  } finally {
    await db.end();
  }
  execFileSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate"],
    { env, stdio: "pipe" },
  );
  const migration = readFileSync("prisma/manual-migrations/20261122_webhook_inbox.sql", "utf8");
  const schema = new Client({ connectionString: url });
  await schema.connect();
  try {
    await schema.query(migration);
    await schema.query(migration);
  } finally {
    await schema.end();
  }
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "app/api/luma/webhooks-inbox.integration.ts"],
    { env, stdio: "inherit" },
  );
  process.exitCode = result.status ?? 1;
  if (process.exitCode === 0) {
    const scenarios = spawnSync(
      process.execPath,
      ["--import", "tsx", "--test", "app/api/luma/webhook-scenarios.integration.ts"],
      { env, stdio: "inherit" },
    );
    process.exitCode = scenarios.status ?? 1;
  }
  if (process.exitCode === 0) {
    const handoff = spawnSync(
      process.execPath,
      ["--import", "tsx", "--test", "app/api/luma/database-handoff.integration.ts"],
      { env, stdio: "inherit" },
    );
    process.exitCode = handoff.status ?? 1;
  }
  if (process.exitCode === 0 && process.argv.includes("--campus-schema")) {
    const schemaPath = process.argv[process.argv.indexOf("--campus-schema") + 1];
    const roleIndex = process.argv.indexOf("--runtime-role");
    const rolePath = roleIndex < 0 ? undefined : process.argv[roleIndex + 1];
    if (!schemaPath || schemaPath.startsWith("--") || !rolePath || rolePath.startsWith("--"))
      throw new Error(
        "Private-schema tests require explicit Campus schema and runtime-role migration files.",
      );
    const admin = new Client({ connectionString: url });
    await admin.connect();
    try {
      if ((await admin.query("SHOW data_directory")).rows[0].data_directory !== data)
        throw new Error("Refusing an unverified test database.");
      await admin.query("CREATE DATABASE webhook_private_scenarios");
    } finally {
      await admin.end();
    }
    const privateAdmin = new URL(url);
    privateAdmin.pathname = "/webhook_private_scenarios";
    const setup = new Client({ connectionString: privateAdmin.href });
    await setup.connect();
    try {
      await setup.query(
        "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA extensions; CREATE EXTENSION pg_trgm WITH SCHEMA extensions",
      );
      await setup.query("BEGIN");
      await setup.query(readFileSync(schemaPath, "utf8"));
      await setup.query(readFileSync(rolePath, "utf8"));
      // Production provisions LOGIN separately; this verified socket-only
      // fixture uses local trust and must not depend on the handoff test's role.
      await setup.query("ALTER ROLE guestbook_runtime LOGIN");
      await setup.query("COMMIT");
      await setup.query(
        "CREATE TABLE public.luma_webhook_deliveries(webhook_id text); CREATE TABLE public.luma_people(person_id text)",
      );
    } finally {
      await setup.end();
    }
    const runtime = new URL(privateAdmin);
    runtime.username = "guestbook_runtime";
    runtime.searchParams.set("schema", "guestbook");
    runtime.searchParams.set("options", "-c search_path=guestbook,pg_catalog");
    privateAdmin.searchParams.set("options", "-c search_path=guestbook,pg_catalog");
    for (const identityMode of ["legacy", "human"]) {
      const scenarios = spawnSync(
        process.execPath,
        ["--import", "tsx", "--test", "app/api/luma/webhook-scenarios.integration.ts"],
        {
          env: {
            ...env,
            DB_URL: runtime.href,
            DB_RUNTIME_URL: runtime.href,
            DB_NOTIFY_URL: runtime.href,
            WEBHOOK_TEST_DATABASE_URL: runtime.href,
            WEBHOOK_TEST_ADMIN_URL: privateAdmin.href,
            WEBHOOK_TEST_SCHEMA: "guestbook",
            GUESTBOOK_IDENTITY_MODE: identityMode,
          },
          stdio: "inherit",
        },
      );
      process.exitCode = scenarios.status ?? 1;
      if (process.exitCode) break;
    }
  }
} finally {
  if (started) execFileSync("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"], { stdio: "pipe" });
  rmSync(root, { recursive: true, force: true });
}
