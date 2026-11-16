import {
  refreshIndexedEventOverviewStats,
  runAutomaticTagClassifier,
} from "../app/api/luma/db";
import { PrismaClient, Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { projectHumans } from "../app/api/luma/human-store";
const url = process.env.DB_URL;
if (!url) throw Error("Set DB_URL explicitly for the selected database.");
let parsed: URL;
try {
  parsed = new URL(url);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw Error();
} catch {
  throw Error(
    "DB_URL must be a valid PostgreSQL URL; its value was not logged.",
  );
}
const fingerprint = createHash("sha256")
  .update(
    parsed.host + parsed.pathname + (parsed.searchParams.get("host") || ""),
  )
  .digest("hex")
  .slice(0, 16);
const db = new PrismaClient({ datasources: { db: { url } } });
// All helpers in this standalone job must use the explicitly fingerprinted target,
// never a separately configured DB_RUNTIME_URL.
globalThis["__guestbookPrismaClientV9"] = db;
const publicError = (message: string) =>
  Object.assign(new Error(message), { publicMessage: message });
async function main() {
  const apply = process.argv.includes("--apply");
  const expected = process.argv
    .find((a) => a.startsWith("--target-fingerprint="))
    ?.split("=")[1];
  if (apply && expected !== fingerprint)
    throw publicError(
      "Apply requires the matching --target-fingerprint printed by the read-only preview.",
    );
  if (
    apply &&
    process.argv.includes("--finalize") &&
    process.env.GUESTBOOK_IDENTITY_MODE !== "human"
  )
    throw publicError(
      "Finalization requires explicit GUESTBOOK_IDENTITY_MODE=human.",
    );
  const [counts]: any[] =
    await db.$queryRaw`SELECT (SELECT count(*)::integer FROM luma_people) accounts,(SELECT count(*)::integer FROM luma_event_guests) registrations,(SELECT count(*)::integer FROM guest_comments) notes,to_regclass('guestbook_account_identities') IS NOT NULL AS ready,to_regprocedure('guestbook_project_humans(text[],text[])') IS NOT NULL AS "projectionReady"`;
  console.log(
    JSON.stringify({
      targetFingerprint: fingerprint,
      mode: apply ? "bounded-backfill" : "read-only-preview",
      ...counts,
    }),
  );
  if (!counts.ready || (apply && !counts.projectionReady)) {
    if (apply)
      throw publicError(
        "Apply the separately reviewed schema/function migrations first.",
      );
    return;
  }
  if (apply) {
    let cursor = "";
    let processed = 0;
    while (true) {
      const batch = await db.guestbookPerson.findMany({
        where: {
          mergedIntoId: null,
          ...(cursor ? { personId: { gt: cursor } } : {}),
        },
        orderBy: { personId: "asc" },
        take: 250,
        select: { personId: true },
      });
      if (!batch.length) break;
      await db.$transaction(
        (tx) =>
          projectHumans(
            tx,
            batch.map((p) => p.personId),
          ),
        { timeout: 120000 },
      );
      cursor = batch.at(-1)!.personId;
      processed += batch.length;
      console.log(JSON.stringify({ processedPeople: processed }));
    }
  }
  const [validation]: any[] = await db.$queryRaw(Prisma.sql`
    SELECT
    (SELECT count(*)::integer FROM luma_people p LEFT JOIN guestbook_account_identities i ON i.account_id=p.person_id WHERE i.account_id IS NULL) AS "unmappedAccounts",
    (SELECT count(*)::integer FROM guestbook_people WHERE merged_into_id IS NULL) AS humans,
    (SELECT count(*)::integer FROM guestbook_people WHERE person_id !~ '^human_[0-9a-f-]{36}$') AS "invalidHumanIds",
    (SELECT count(*)::integer FROM (SELECT DISTINCT g.event_id,i.person_id FROM luma_event_guests g JOIN guestbook_account_identities i ON i.account_id=g.person_id) expected LEFT JOIN guestbook_event_guests actual USING(event_id,person_id) WHERE actual.person_id IS NULL) AS "missingHumanEvents",
    (SELECT count(*)::integer FROM guestbook_event_guests) AS "humanEvents",
    (SELECT count(*)::integer FROM guestbook_event_guests actual WHERE NOT EXISTS(SELECT 1 FROM luma_event_guests source JOIN guestbook_account_identities identity ON identity.account_id=source.person_id WHERE source.event_id=actual.event_id AND identity.person_id=actual.person_id)) AS "orphanHumanEvents",
    (SELECT count(*)::integer FROM (SELECT legacy.canonical_id FROM person_merge_members legacy JOIN guestbook_account_identities identity ON identity.account_id=legacy.person_id GROUP BY legacy.canonical_id HAVING count(DISTINCT identity.person_id)>1) split) AS "splitConfirmedGroups",
    (SELECT count(*)::integer FROM guestbook_comments) AS "humanNotes"
  `);
  console.log(JSON.stringify({ validation }));
  if (
    apply &&
    (validation.unmappedAccounts ||
      validation.invalidHumanIds ||
      validation.missingHumanEvents ||
      validation.orphanHumanEvents ||
      validation.splitConfirmedGroups ||
      validation.humanNotes < counts.notes)
  )
    throw publicError(
      "Validation failed. Keep human mode disabled and inspect the manifest.",
    );
  if (apply && process.argv.includes("--finalize")) {
    if (process.env.GUESTBOOK_IDENTITY_MODE !== "human")
      throw publicError(
        "Finalization requires explicit GUESTBOOK_IDENTITY_MODE=human.",
      );
    await runAutomaticTagClassifier({ forceFull: true });
    const events = await db.lumaEvent.findMany({ select: { eventId: true } });
    for (let i = 0; i < events.length; i += 100)
      await refreshIndexedEventOverviewStats(
        events.slice(i, i + 100).map((e) => e.eventId),
      );
    console.log(JSON.stringify({ finalizedEvents: events.length }));
  }
}
main()
  .catch((e) => {
    console.error(
      e.publicMessage ||
        "Human migration operation failed; database error details were withheld to protect credentials.",
    );
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
