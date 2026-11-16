import { humanIdentityEnabled } from "../../luma/human-mode";
import { mergeHumans, undoHumanMerge } from "./humans";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma, invalidateIndexedAudienceCaches, runAutomaticTagClassifier } from "../../luma/db";
import { linkedPersonIds, mergesReady, type Membership } from "../../luma/merge-identity";
import { findMergeCandidates, type MergeProfile, type MergeSignal } from "../../luma/merge-matching";

export const PROFILE_LIMIT = 10000;
const REGISTRATION_LIMIT = 50;
export function mergeError(message: string, status = 400) { return Object.assign(new Error(message), { status }); }
export async function requireMergeTables(db = prisma()) {
  if (!await mergesReady(db)) throw mergeError("Merge station needs the reviewed person-merge database migration. No migration has been applied automatically.", 503);
}
export async function station(db = prisma(), signals: MergeSignal[] = ["name", "social", "phone"]) {
  const mergeEnabled = await mergesReady(db);
  const [rows, operations] = await Promise.all([
    db.lumaPerson.findMany({
      orderBy: { personId: "asc" }, take: PROFILE_LIMIT + 1,
      select: { personId: true, name: true, email: true, phoneNumber: true, socialLinks: true, tags: true,
        _count: { select: { eventGuests: true } },
        eventGuests: { orderBy: [{ lastSeenAt: "desc" }, { eventId: "asc" }], take: REGISTRATION_LIMIT + 1,
          select: { email: true, phoneNumber: true, socialLinks: true, registrationAnswers: true } } },
    }),
    humanIdentityEnabled() ? (db as any).guestbookHumanMerge.findMany({orderBy:{createdAt:"desc"},take:20,select:{id:true,after:true,createdAt:true,undoneAt:true}}).then((rows:any[])=>rows.map(o=>({...o,after:o.after.members}))) : mergeEnabled ? db.$queryRaw<Array<{ id: string; after: Membership[]; createdAt: Date; undoneAt: Date | null }>>`SELECT id, after, created_at AS "createdAt", undone_at AS "undoneAt" FROM person_merge_operations ORDER BY created_at DESC LIMIT 20` : Promise.resolve([]),
  ]);
  const scannedIds = rows.slice(0, PROFILE_LIMIT).map(r => r.personId);
  const memberships: Membership[] = !humanIdentityEnabled() && mergeEnabled && scannedIds.length ? await db.$queryRaw(Prisma.sql`SELECT person_id AS "personId", canonical_id AS "canonicalId" FROM person_merge_members WHERE person_id IN (${Prisma.join(scannedIds)})`) : [];
  const canonical = new Map(memberships.map(m => [m.personId, m.canonicalId]));
  const profiles: MergeProfile[] = rows.slice(0, PROFILE_LIMIT).map(row => ({ personId: row.personId, name: row.name, email: row.email,
    phoneNumber: row.phoneNumber, socialLinks: row.socialLinks, tags: row.tags,
    canonicalId: canonical.get(row.personId) || row.personId,
    registrations: row.eventGuests.slice(0, REGISTRATION_LIMIT),
  }));
  let accountsTruncated=false;
  if (humanIdentityEnabled() && scannedIds.length) {
    const emails = await (db as any).guestbookPersonEmail.findMany({where:{personId:{in:scannedIds}}});
    const byId = new Map(profiles.map(p=>[p.personId,p]));
    emails.forEach((e:any)=>byId.get(e.personId)?.registrations.push({email:e.emailLower}));
    const identities=await (db as any).guestbookAccountIdentity.findMany({where:{personId:{in:scannedIds}},orderBy:{accountId:"asc"},take:50001,include:{account:{select:{name:true,email:true,phoneNumber:true,socialLinks:true}}}});
    accountsTruncated=identities.length>50000;
    identities.slice(0,50000).forEach((identity:any)=>byId.get(identity.personId)?.registrations.push({...identity.account,registrationAnswers:[{label:"Full name",value:identity.account.name}]}));
  }
  const matches = findMergeCandidates(profiles, 1000, signals);
  const involved = new Set([...matches.candidates.flatMap(c => [c.left, c.right]), ...operations.flatMap(o => o.after.map(m => m.personId))]);
  return { ...matches, mergeEnabled,
    profiles: profiles.filter(p => involved.has(p.personId)).map(({ registrations, ...profile }) => profile),
    operations,
    coverage: { scannedPeople: profiles.length, peopleTruncated: rows.length > PROFILE_LIMIT,
      registrationsPerPerson: REGISTRATION_LIMIT, registrationsTruncated: rows.some(r => r._count.eventGuests > REGISTRATION_LIMIT),
      candidateLimit: 1000, accountsTruncated },
  };
}
export async function preview(ids: string[], db = prisma()) {
  const memberIds = await linkedPersonIds(db, ids);
  if (memberIds.length > 100) throw mergeError("This merge exceeds the 100-profile review limit.");
  const people = await db.lumaPerson.findMany({ where: { personId: { in: memberIds } },
    select: { personId: true, name: true, email: true, phoneNumber: true, socialLinks: true, tags: true,
      comments: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 101, select: { id: true, body: true, author: true, createdAt: true } } } });
  if (ids.some(id => !people.some(p => p.personId === id))) throw mergeError("A selected profile no longer exists. Refresh the station.", 404);
  const registrations = await db.lumaEventGuest.findMany({ where: { personId: { in: memberIds } },
    orderBy: [{ checkedInAt: "desc" }, { registeredAt: "desc" }, { eventId: "asc" }, { personId: "asc" }], take: 1001,
    select: { personId: true, eventId: true, email: true, status: true, checkedInAt: true, registeredAt: true,
      event: { select: { title: true, startsAt: true } } } });
  const events = new Map<string, { eventId: string; title: string; startsAt: Date | null; attended: boolean; emails: string[]; registrations: number }>();
  for (const r of registrations.slice(0, 1000)) {
    const event = events.get(r.eventId) || { eventId: r.eventId, ...r.event, attended: false, emails: [], registrations: 0 };
    event.attended ||= Boolean(r.checkedInAt || r.status === "checked_in");
    if (r.email && !event.emails.includes(r.email)) event.emails.push(r.email);
    event.registrations++; events.set(r.eventId, event);
  }
  const accounts = humanIdentityEnabled() ? await (db as any).guestbookAccountIdentity.findMany({where:{personId:{in:memberIds}},select:{personId:true,account:{select:{name:true,email:true,lumaUserId:true,phoneNumber:true}}}}) : [];
  const sourceIds=humanIdentityEnabled() ? await (db as any).guestbookAccountIdentity.findMany({where:{personId:{in:memberIds}},select:{accountId:true}}) : [];
  const originals=sourceIds.length ? await ((db as any).$source||db).lumaEventGuest.findMany({where:{personId:{in:sourceIds.map((s:any)=>s.accountId)}},take:1001,orderBy:[{eventId:"asc"},{personId:"asc"}],select:{eventId:true,email:true,personId:true,status:true}}) : [];
  if(humanIdentityEnabled()) for(const event of events.values()){
    const original=originals.filter((r:any)=>r.eventId===event.eventId);
    event.registrations=original.length;
    event.emails=[...new Set<string>(original.map((r:any)=>r.email).filter(Boolean))];
  }
  return { accounts, people: people.map(p => ({ ...p, comments: p.comments.slice(0, 100).map(c => ({ ...c, id: String(c.id) })) })),
    events: [...events.values()], registrationsTruncated: registrations.length > 1000 || originals.length>1000,
    commentsTruncated: people.some(p => p.comments.length > 100) };
}
function snapshot(rows: Membership[]) { return JSON.stringify([...rows].sort((a, b) => a.personId.localeCompare(b.personId))); }
export async function mergePeople(left: string, right: string, primary: string, db = prisma(), reviewedIds: string[] = [left, right]) {
  if (humanIdentityEnabled()) {
    const result=await mergeHumans(db,left,right,primary,reviewedIds);
    return finalizeHumanChange(result);
  }
  await requireMergeTables(db);
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    // Serialize all group edits so overlapping requests cannot split identities.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(821157031)`;
    const ids = await linkedPersonIds(tx, [left, right]);
    if (!ids.includes(primary) || ids.length > 100 || left === right) throw mergeError("Choose two distinct profiles and a primary profile from this group (maximum 100).");
    if (JSON.stringify([...ids].sort()) !== JSON.stringify([...new Set(reviewedIds)].sort())) throw mergeError("These identity groups changed. Refresh the preview before merging.", 409);
    const people = await tx.lumaPerson.findMany({ where: { personId: { in: ids } }, select: { personId: true } });
    if (people.length !== ids.length) throw mergeError("A selected profile no longer exists.", 404);
    const before = await tx.$queryRaw<Membership[]>(Prisma.sql`SELECT person_id AS "personId", canonical_id AS "canonicalId" FROM person_merge_members WHERE person_id IN (${Prisma.join(ids)})`);
    if (before.some(m => m.personId === left) && before.some(m => m.personId === right && m.canonicalId === before.find(n => n.personId === left)?.canonicalId)) throw mergeError("These profiles are already merged.", 409);
    const after = ids.map(personId => ({ personId, canonicalId: primary }));
    await tx.$executeRaw(Prisma.sql`INSERT INTO person_merge_members (person_id, canonical_id) VALUES ${Prisma.join(after.map(m => Prisma.sql`(${m.personId}, ${m.canonicalId})`))} ON CONFLICT (person_id) DO UPDATE SET canonical_id = EXCLUDED.canonical_id`);
    const id = randomUUID();
    await tx.$executeRaw`INSERT INTO person_merge_operations (id, before, after) VALUES (${id}, ${JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb)`;
    return { id, personIds: ids, primary };
  });
}
export async function undoMerge(id: string, db = prisma()) {
  if (humanIdentityEnabled()) {
    const result=await undoHumanMerge(db,id);
    return finalizeHumanChange(result);
  }
  await requireMergeTables(db);
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(821157031)`;
    const operations = await tx.$queryRaw<Array<{ before: Membership[]; after: Membership[]; undoneAt: Date | null }>>`SELECT before, after, undone_at AS "undoneAt" FROM person_merge_operations WHERE id = ${id}`;
    const operation = operations[0];
    if (!operation || operation.undoneAt) throw mergeError("This merge is unavailable or already undone.", 409);
    const ids = operation.after.map(m => m.personId);
    const current = await tx.$queryRaw<Membership[]>(Prisma.sql`SELECT person_id AS "personId", canonical_id AS "canonicalId" FROM person_merge_members WHERE canonical_id IN (${Prisma.join(ids)}) OR person_id IN (${Prisma.join(ids)})`);
    if (snapshot(current) !== snapshot(operation.after)) throw mergeError("This group changed after that merge. Undo its newer merges first.", 409);
    await tx.$executeRaw(Prisma.sql`DELETE FROM person_merge_members WHERE person_id IN (${Prisma.join(ids)})`);
    if (operation.before.length) await tx.$executeRaw(Prisma.sql`INSERT INTO person_merge_members (person_id, canonical_id) VALUES ${Prisma.join(operation.before.map(m => Prisma.sql`(${m.personId}, ${m.canonicalId})`))}`);
    await tx.$executeRaw`UPDATE person_merge_operations SET undone_at = NOW() WHERE id = ${id}`;
    return { id, undone: true };
  });
}

async function finalizeHumanChange<T extends {personIds:string[]}>(result:T){
  invalidateIndexedAudienceCaches();
  try { await runAutomaticTagClassifier({personIds:result.personIds}); return {...result,classificationPending:false}; }
  catch { return {...result,classificationPending:true}; }
}
