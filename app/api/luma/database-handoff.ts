import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma, PrismaClient } from "@prisma/client";
import { after as nextAfter } from "next/server";

// Requests and provider jobs hold a shared lock for their entire operation, not
// just their SQL statements. The cutover takes its exclusive counterpart.
export const DATABASE_HANDOFF_LOCK = 821157033;
type Scope = { destination: boolean; active: boolean };
const scope = new AsyncLocalStorage<Scope>();
let coordinator: PrismaClient | undefined;
let destinationVerifier: PrismaClient | undefined;
let verifiedDestinationId: string | undefined;
export const handoffEnabled = () => process.env.DB_HANDOFF_ENABLED === "true";

function schema(value: string | undefined) {
  if (!value) throw new Error("Incomplete database handoff configuration.");
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("Expected PostgreSQL configuration.");
  return url.searchParams.get("schema") || "public";
}
export function validateDatabaseHandoff() {
  if (!handoffEnabled()) return;
  if (!/^[0-9a-f-]{36}$/.test(process.env.DB_HANDOFF_MIGRATION_ID || ""))
    throw new Error("A database handoff identity is required.");
  if (
    schema(process.env.DB_URL) !== "public" ||
    schema(process.env.DB_RUNTIME_URL || process.env.DB_URL) !== "public" ||
    schema(process.env.DB_DESTINATION_URL) !== "guestbook" ||
    schema(process.env.DB_DESTINATION_RUNTIME_URL || process.env.DB_DESTINATION_URL) !== "guestbook"
  )
    throw new Error(
      "Database handoff requires matching source and private destination namespaces.",
    );
}
export function databaseHandoffDestination() {
  if (!handoffEnabled()) return false;
  const current = scope.getStore();
  if (!current?.active) throw new Error("Database access requires an active handoff scope.");
  return current.destination;
}
export function databaseEndpoint(runtime = false) {
  if (databaseHandoffDestination())
    return (runtime && process.env.DB_DESTINATION_RUNTIME_URL) || process.env.DB_DESTINATION_URL;
  return (runtime && process.env.DB_RUNTIME_URL) || process.env.DB_URL;
}

export async function verifyDatabaseHandoffDestination(allowInactive = true) {
  validateDatabaseHandoff();
  if (!handoffEnabled()) throw new Error("Database handoff is not enabled.");
  if (!destinationVerifier) {
    const url = new URL(process.env.DB_DESTINATION_RUNTIME_URL || process.env.DB_DESTINATION_URL!);
    url.searchParams.set("connection_limit", "1");
    destinationVerifier = new PrismaClient({ datasources: { db: { url: url.href } } });
  }
  const proof = await destinationVerifier.$queryRaw<
    Array<{ activated: boolean; schema: string; principal: string }>
  >`
    SELECT activated,current_schema() AS schema,current_user::text AS principal
    FROM guestbook_migration.destination WHERE migration_id=${process.env.DB_HANDOFF_MIGRATION_ID}::uuid AND snapshot_verified`;
  if (
    proof.length !== 1 ||
    (!allowInactive && proof[0].activated !== true) ||
    proof[0].schema !== "guestbook" ||
    proof[0].principal !== "guestbook_runtime"
  )
    throw new Error("Verified destination provenance and private runtime access are required.");
  return { ready: true, migrationId: process.env.DB_HANDOFF_MIGRATION_ID };
}

export async function withDatabaseHandoff<T>(
  operation: () => Promise<T>,
  notify?: "inbox" | "index",
): Promise<T> {
  if (!handoffEnabled()) return operation();
  if (scope.getStore()?.active) return operation();
  validateDatabaseHandoff();
  if (!coordinator) {
    const url = new URL(process.env.DB_RUNTIME_URL || process.env.DB_URL!);
    url.searchParams.set("connection_limit", "2");
    url.searchParams.set("pool_timeout", "90");
    coordinator = new PrismaClient({ datasources: { db: { url: url.href } } });
  }
  // Do not retry this callback: it may already have contacted a provider.
  return coordinator.$transaction(
    async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SET LOCAL idle_in_transaction_session_timeout = '330s'`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '90s'`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${DATABASE_HANDOFF_LOCK}::bigint)`;
      const rows = await tx.$queryRaw<Array<{ destination: boolean; migration_id: string }>>`
      SELECT destination, migration_id::text FROM guestbook_migration.control WHERE singleton = true`;
      if (rows.length !== 1 || typeof rows[0].destination !== "boolean")
        throw new Error("Database handoff control is unavailable.");
      if (rows[0].migration_id !== process.env.DB_HANDOFF_MIGRATION_ID)
        throw new Error("Wrong database handoff identity.");
      if (rows[0].destination && verifiedDestinationId !== rows[0].migration_id) {
        await verifyDatabaseHandoffDestination(false);
        verifiedDestinationId = rows[0].migration_id;
      }
      const current = { destination: rows[0].destination, active: true };
      try {
        const result = await scope.run(current, operation);
        // During rolling replacement, the existing source listener wakes the same
        // worker/browser, whose next operation reads the destination through this gate.
        if (current.destination && notify)
          await tx.$executeRaw`SELECT pg_notify(${notify === "inbox" ? "guestbook_webhook_inbox" : "guestbook_index_changed"}, '')`;
        return result;
      } finally {
        current.active = false;
      }
    },
    { maxWait: 90_000, timeout: 300_000 },
  );
}

export function handoffAfter(operation: () => Promise<unknown>) {
  // after() starts after the response. Acquire a new scope rather than inheriting
  // a finished request's lock and database selection.
  nextAfter(async () => {
    await scope.exit(() => withDatabaseHandoff(operation));
  });
}

export function handoffHandler<A extends any[]>(
  handler: (...args: A) => Promise<Response>,
  notify?: "inbox",
) {
  return (...args: A) => withDatabaseHandoff(() => handler(...args), notify);
}

export async function disconnectDatabaseHandoff() {
  await Promise.all([coordinator?.$disconnect(), destinationVerifier?.$disconnect()]);
  coordinator = undefined;
  destinationVerifier = undefined;
  verifiedDestinationId = undefined;
}
