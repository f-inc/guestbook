import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { projectHumans, resolveHumanIds } from "../../luma/human-store";
const fail = (message: string, status = 409) =>
  Object.assign(new Error(message), { status });
const json = (value: any) =>
  JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
const union = (...values: any[]) => [
  ...new Set(values.flatMap((v) => (Array.isArray(v) ? v : []))),
];
const distinctJson = (...values: any[]) => [
  ...new Map(
    values
      .flatMap((v) => (Array.isArray(v) ? v : []))
      .map((v) => [
        typeof v === "object" ? v.url || JSON.stringify(v) : String(v),
        v,
      ]),
  ).values(),
];
const normalized = (v: any): any =>
  Array.isArray(v)
    ? v.map(normalized)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, normalized(x)]),
        )
      : v;
const equal = (a: any, b: any) =>
  JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));

export async function mergeHumans(
  db: any,
  left: string,
  right: string,
  primary: string,
  reviewed: string[],
) {
  db = db.$source || db;
  return db.$transaction(
    async (tx: any) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(821157031)`;
      const ids = await resolveHumanIds(tx, [left, right]);
      if (
        ids.length !== 2 ||
        !ids.includes(primary) ||
        JSON.stringify([...ids].sort()) !==
          JSON.stringify([...new Set(reviewed)].sort())
      )
        throw fail("These people changed. Refresh the preview before merging.");
      const people = await tx.guestbookPerson.findMany({
        where: { personId: { in: ids }, mergedIntoId: null },
      });
      if (people.length !== 2)
        throw fail("A selected person no longer exists.", 404);
      const secondary = ids.find((id) => id !== primary)!;
      const historical = await tx.guestbookPerson.findMany({
        where: {
          OR: [{ personId: { in: ids } }, { mergedIntoId: { in: ids } }],
        },
        select: { personId: true, mergedIntoId: true, identityVersion: true },
      });
      const accounts = await tx.guestbookAccountIdentity.findMany({
        where: { personId: { in: ids } },
        select: { accountId: true, personId: true },
      });
      if (accounts.length > 100)
        throw fail(
          "This merge exceeds the 100 linked-account review limit.",
          400,
        );
      const notes = await tx.guestbookComment.findMany({
        where: { personId: secondary },
        select: { id: true, personId: true },
      });
      const mutations = await tx.guestbookManualTagMutation.findMany({
        where: { personId: secondary },
        select: { id: true, personId: true },
      });
      const lastMutation = await tx.guestbookManualTagMutation.findFirst({
        orderBy: { id: "desc" },
        select: { id: true },
      });
      const automatic = await tx.guestbookAutomaticTagAssignment.findMany({
        where: { personId: { in: ids } },
      });
      const primaryPerson = people.find((p: any) => p.personId === primary);
      const previousEmails = await tx.guestbookPersonEmail.findMany({
        where: { personId: { in: ids } },
      });
      const alternate = people.find((p: any) => p.personId !== primary);
      const profilePatch: any = {
        socialLinks: distinctJson(...people.map((p: any) => p.socialLinks)),
        groups: distinctJson(...people.map((p: any) => p.groups)),
      };
      for (const field of [
        "email",
        "emailLower",
        "phoneNumber",
        "title",
        "bio",
        "avatarUrl",
        "profileUrl",
      ])
        profilePatch[field] = primaryPerson[field] || alternate[field];
      const tagDefinitions = await tx.guestTag.findMany({
        where: {
          OR: [
            { name: { in: union(...people.map((p: any) => p.tags)) } },
            { id: { in: automatic.map((a: any) => a.tagId) } },
          ],
        },
        select: { id: true, name: true },
      });
      const before = json({
        historical,
        accounts,
        notes,
        mutations,
        automatic,
        tagDefinitions,
        emails: previousEmails,
        primary: primaryPerson,
        secondary,
        lastMutationId: lastMutation?.id || 0,
      });
      await tx.guestbookAccountIdentity.updateMany({
        where: { personId: secondary },
        data: { personId: primary },
      });
      await tx.guestbookComment.updateMany({
        where: { personId: secondary },
        data: { personId: primary },
      });
      await tx.guestbookManualTagMutation.updateMany({
        where: { personId: secondary },
        data: { personId: primary },
      });
      await tx.guestbookAutomaticTagAssignment.deleteMany({
        where: { personId: secondary },
      });
      const existingRules = new Set(
        automatic
          .filter((a: any) => a.personId === primary)
          .map((a: any) => a.ruleKey),
      );
      const additional = automatic
        .filter(
          (a: any) => a.personId === secondary && !existingRules.has(a.ruleKey),
        )
        .map((a: any) => ({ ...a, personId: primary }));
      if (additional.length)
        await tx.guestbookAutomaticTagAssignment.createMany({
          data: additional,
        });
      await tx.guestbookPerson.update({
        where: { personId: primary },
        data: {
          ...profilePatch,
          manualTags: union(...people.map((p: any) => p.manualTags)),
          automaticTags: union(...people.map((p: any) => p.automaticTags)),
          tags: union(...people.map((p: any) => p.tags)),
          identityVersion: { increment: 1 },
        },
      });
      await tx.guestbookPerson.updateMany({
        where: { OR: [{ personId: secondary }, { mergedIntoId: secondary }] },
        data: { mergedIntoId: primary, identityVersion: { increment: 1 } },
      });
      const emails = await tx.guestbookPersonEmail.findMany({
        where: { personId: secondary },
      });
      if (emails.length)
        await tx.guestbookPersonEmail.createMany({
          data: emails.map((e: any) => ({ ...e, personId: primary })),
          skipDuplicates: true,
        });
      await tx.guestbookEventGuest.deleteMany({
        where: { personId: secondary },
      });
      await projectHumans(tx, [primary]);
      await tx.lumaEvent.updateMany({
        where: { humanGuests: { some: { personId: primary } } },
        data: { overviewStats: {}, overviewStatsUpdatedAt: null },
      });
      const versions = await tx.guestbookPerson.findMany({
        where: { personId: { in: historical.map((p: any) => p.personId) } },
        select: { personId: true, identityVersion: true },
      });
      const id = randomUUID();
      const after = json({
        profilePatch,
        members: historical.map((p: any) => ({
          personId: p.personId,
          canonicalId: primary,
        })),
        versions,
        accounts: accounts.map((a: any) => ({ ...a, personId: primary })),
      });
      await tx.guestbookHumanMerge.create({ data: { id, before, after } });
      return { id, personIds: ids, primary };
    },
    { timeout: 30000 },
  );
}
export async function undoHumanMerge(db: any, id: string) {
  db = db.$source || db;
  return db.$transaction(
    async (tx: any) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(821157031)`;
      const operation = await tx.guestbookHumanMerge.findUnique({
        where: { id },
      });
      if (!operation || operation.undoneAt)
        throw fail("This merge is unavailable or already undone.");
      const { before, after } = operation;
      const ids = after.versions.map((p: any) => p.personId);
      const versions = await tx.guestbookPerson.findMany({
        where: { personId: { in: ids } },
        select: { personId: true, identityVersion: true },
      });
      const accounts = await tx.guestbookAccountIdentity.findMany({
        where: { personId: before.primary.personId },
        select: { accountId: true, personId: true },
      });
      const stable = (rows: any[], key: string) =>
        JSON.stringify(
          [...rows]
            .sort((a, b) => a[key].localeCompare(b[key]))
            .map((row) =>
              Object.fromEntries(
                Object.entries(row).sort(([a], [b]) => a.localeCompare(b)),
              ),
            ),
        );
      if (
        stable(versions, "personId") !== stable(after.versions, "personId") ||
        stable(accounts, "accountId") !== stable(after.accounts, "accountId")
      )
        throw fail("This identity changed. Undo newer merges first.");
      for (const account of before.accounts)
        await tx.guestbookAccountIdentity.update({
          where: { accountId: account.accountId },
          data: { personId: account.personId },
        });
      for (const person of before.historical)
        await tx.guestbookPerson.update({
          where: { personId: person.personId },
          data: {
            mergedIntoId: person.mergedIntoId,
            identityVersion: person.identityVersion,
          },
        });
      for (const note of before.notes)
        await tx.guestbookComment.updateMany({
          where: { id: BigInt(note.id), personId: before.primary.personId },
          data: { personId: note.personId },
        });
      for (const mutation of before.mutations)
        await tx.guestbookManualTagMutation.updateMany({
          where: { id: BigInt(mutation.id), personId: before.primary.personId },
          data: { personId: mutation.personId },
        });
      const postMergeMutations = await tx.guestbookManualTagMutation.findMany({
        where: {
          personId: before.primary.personId,
          id: { gt: BigInt(before.lastMutationId) },
        },
        orderBy: { id: "asc" },
        include: { tag: true },
      });
      const currentDefinitions = await tx.guestTag.findMany({
        where: {
          id: { in: (before.tagDefinitions || []).map((t: any) => t.id) },
        },
        select: { id: true, name: true },
      });
      const renameTag = (name: string) => {
        const previous = (before.tagDefinitions || []).find(
          (t: any) => t.name === name,
        );
        return previous
          ? currentDefinitions.find((t: any) => t.id === previous.id)?.name
          : name;
      };
      const manual = new Set<string>(
        before.primary.manualTags.map(renameTag).filter(Boolean),
      );
      for (const mutation of postMergeMutations)
        mutation.removed
          ? manual.delete(mutation.tag.name)
          : manual.add(mutation.tag.name);
      const activeIds = [before.primary.personId, before.secondary];
      await tx.guestbookAutomaticTagAssignment.deleteMany({
        where: { personId: { in: activeIds } },
      });
      const restoredAutomatic = before.automatic.filter((a: any) =>
        currentDefinitions.some((t: any) => t.id === a.tagId),
      );
      if (restoredAutomatic.length)
        await tx.guestbookAutomaticTagAssignment.createMany({
          data: restoredAutomatic,
        });
      const currentPrimary = await tx.guestbookPerson.findUnique({
        where: { personId: before.primary.personId },
      });
      const profileRestore: any = {};
      for (const field of Object.keys(after.profilePatch || {}))
        if (equal(currentPrimary[field], after.profilePatch[field]))
          profileRestore[field] = before.primary[field];
      await tx.guestbookPerson.update({
        where: { personId: before.primary.personId },
        data: {
          ...profileRestore,
          manualTags: [...manual],
          automaticTags: before.primary.automaticTags
            .map(renameTag)
            .filter(Boolean),
          tags: union(
            [...manual],
            before.primary.automaticTags.map(renameTag).filter(Boolean),
          ),
        },
      });
      // Keep post-merge notes and profile edits on the survivor. Rebuild contact
      // ownership and event projections from the original account mapping.
      await tx.guestbookPersonEmail.deleteMany({
        where: { personId: { in: activeIds } },
      });
      if (before.emails?.length)
        await tx.guestbookPersonEmail.createMany({
          data: before.emails,
          skipDuplicates: true,
        });
      await projectHumans(tx, activeIds);
      await tx.lumaEvent.updateMany({
        where: { humanGuests: { some: { personId: { in: activeIds } } } },
        data: { overviewStats: {}, overviewStatsUpdatedAt: null },
      });
      await tx.guestbookHumanMerge.update({
        where: { id },
        data: { undoneAt: new Date() },
      });
      return { id, undone: true, personIds: activeIds };
    },
    { timeout: 30000 },
  );
}
