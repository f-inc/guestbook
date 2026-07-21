import assert from "node:assert/strict";
import test from "node:test";
import { databaseUrlWithPoolLimits } from "./database-url";

test("adds conservative Prisma pool limits while preserving provider options", () => {
  const result = new URL(databaseUrlWithPoolLimits(
    "postgresql://guest:secret@example.com:5432/guestbook?sslmode=require&pgbouncer=true&connection_limit=15",
    { connectionLimit: 2, poolTimeoutSeconds: 20 },
  ));

  assert.equal(result.searchParams.get("connection_limit"), "2");
  assert.equal(result.searchParams.get("pool_timeout"), "20");
  assert.equal(result.searchParams.get("sslmode"), "require");
  assert.equal(result.searchParams.get("pgbouncer"), "true");
});

test("uses Supabase transaction mode for runtime traffic", () => {
  const result = new URL(databaseUrlWithPoolLimits(
    "postgresql://prisma.project:secret@aws-1-us-west-2.pooler.supabase.com:5432/postgres?sslmode=require",
  ));

  assert.equal(result.port, "6543");
  assert.equal(result.searchParams.get("pgbouncer"), "true");
  assert.equal(result.searchParams.get("sslmode"), "require");
});

test("can retain Supabase session mode for a persistent runtime", () => {
  const result = new URL(databaseUrlWithPoolLimits(
    "postgresql://prisma.project:secret@aws-1-us-west-2.pooler.supabase.com:5432/postgres",
    { preferSupabaseTransactionPooler: false },
  ));

  assert.equal(result.port, "5432");
  assert.equal(result.searchParams.get("pgbouncer"), null);
});

test("leaves malformed and non-Postgres URLs unchanged", () => {
  assert.equal(databaseUrlWithPoolLimits("not-a-url"), "not-a-url");
  assert.equal(databaseUrlWithPoolLimits("mysql://localhost/guestbook"), "mysql://localhost/guestbook");
});
