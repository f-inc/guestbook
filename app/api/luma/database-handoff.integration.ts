import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "pg";
import {
  withDatabaseHandoff,
  databaseEndpoint,
  disconnectDatabaseHandoff,
  DATABASE_HANDOFF_LOCK,
} from "./database-handoff";
import { sourcePrisma, disconnectDatabaseClients } from "./db";

// The outer runner creates and verifies the socket-only disposable cluster.
test("handoff drains active operations, queues new work, preserves provider failures and fences expired scopes", async () => {
  const url = process.env.WEBHOOK_TEST_DATABASE_URL!;
  assert(url && process.env.WEBHOOK_TEST_DATA_DIRECTORY);
  const admin = new Client({ connectionString: url });
  const controller = new Client({ connectionString: url });
  await admin.connect();
  await controller.connect();
  const id = "00000000-0000-4000-8000-000000000001";
  try {
    assert.equal(
      (await admin.query("SHOW data_directory")).rows[0].data_directory,
      process.env.WEBHOOK_TEST_DATA_DIRECTORY,
    );
    await admin.query(`CREATE ROLE guestbook_runtime LOGIN;
      CREATE SCHEMA guestbook_migration;
      CREATE SCHEMA guestbook;
      CREATE TABLE guestbook_migration.control(singleton boolean PRIMARY KEY,migration_id uuid,destination boolean);
      CREATE TABLE guestbook_migration.destination(migration_id uuid PRIMARY KEY,snapshot_verified boolean,activated boolean);
      GRANT USAGE ON SCHEMA guestbook,guestbook_migration TO guestbook_runtime;
      GRANT SELECT ON guestbook_migration.destination TO guestbook_runtime`);
    await admin.query("INSERT INTO guestbook_migration.control VALUES(true,$1,false)", [id]);
    await admin.query("INSERT INTO guestbook_migration.destination VALUES($1,true,false)", [id]);
    process.env.DB_HANDOFF_ENABLED = "true";
    process.env.DB_HANDOFF_MIGRATION_ID = id;
    const target = new URL(url);
    target.username = "guestbook_runtime";
    target.searchParams.set("schema", "guestbook");
    process.env.DB_DESTINATION_URL = target.href;
    process.env.DB_DESTINATION_RUNTIME_URL = target.href;
    assert.throws(() => databaseEndpoint(), /active handoff scope/);
    let release!: () => void, entered!: () => void;
    const enteredPromise = new Promise<void>((r) => {
      entered = r;
    });
    const releasePromise = new Promise<void>((r) => {
      release = r;
    });
    const active = withDatabaseHandoff(async () => {
      assert.equal(
        (
          await sourcePrisma().$queryRaw<Array<{ name: string }>>`SELECT current_schema() AS name`
        )[0].name,
        "public",
      );
      entered();
      await releasePromise;
    });
    await enteredPromise;
    await controller.query("BEGIN");
    let controllerAcquired = false;
    const exclusive = controller
      .query("SELECT pg_advisory_xact_lock($1::bigint)", [DATABASE_HANDOFF_LOCK])
      .then(() => {
        controllerAcquired = true;
      });
    let waiterObserved = false;
    for (let n = 0; n < 200; n++) {
      const waiting = await admin.query(
        "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND NOT granted) AS value",
        [DATABASE_HANDOFF_LOCK],
      );
      if (waiting.rows[0].value) {
        waiterObserved = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(waiterObserved);
    let queuedRan = false;
    const queued = withDatabaseHandoff(async () => {
      queuedRan = true;
      assert.equal(
        (
          await sourcePrisma().$queryRaw<Array<{ name: string }>>`SELECT current_schema() AS name`
        )[0].name,
        "guestbook",
      );
    });
    assert.equal(controllerAcquired, false);
    assert.equal(queuedRan, false);
    release();
    await active;
    await exclusive;
    assert.equal(queuedRan, false);
    await controller.query("UPDATE guestbook_migration.destination SET activated=true");
    await controller.query("UPDATE guestbook_migration.control SET destination=true");
    await controller.query("COMMIT");
    await queued;
    let calls = 0;
    await assert.rejects(
      withDatabaseHandoff(async () => {
        calls++;
        throw Error("Example provider uncertainty");
      }),
      /provider uncertainty/,
    );
    assert.equal(calls, 1, "Never replay a provider callback after failure");
    let detached!: Promise<void>;
    await withDatabaseHandoff(async () => {
      detached = new Promise<void>((resolve, reject) =>
        setImmediate(() => {
          try {
            assert.throws(() => databaseEndpoint(), /active handoff scope/);
            resolve();
          } catch (e) {
            reject(e);
          }
        }),
      );
    });
    await detached;
    await disconnectDatabaseHandoff();
    await admin.query("UPDATE guestbook_migration.destination SET activated=false");
    await assert.rejects(
      withDatabaseHandoff(async () => {
        calls++;
      }),
      /provenance/,
    );
    assert.equal(calls, 1);
    process.env.DB_HANDOFF_MIGRATION_ID = "00000000-0000-4000-8000-000000000002";
    await assert.rejects(
      withDatabaseHandoff(async () => {
        calls++;
      }),
      /Wrong database/,
    );
    assert.equal(calls, 1);
  } finally {
    await controller.query("ROLLBACK").catch(() => {});
    await disconnectDatabaseHandoff();
    await disconnectDatabaseClients();
    await controller.end();
    await admin.end();
    delete process.env.DB_HANDOFF_ENABLED;
  }
});
