import { humanIdentityEnabled, humanClient } from "./human-mode";
import { resolveHumanIds } from "./human-store";
import { removedEmails } from "./email-inactivity";
import { emailDecision, recordLumaIssue } from "./email-policy";
import { calendarIdFromEvent } from "./tracking-policy";
import {
  invitationMessages,
  emailStatus,
  mergeInvitationMessages,
} from "../../invite-tracking";
import { randomUUID } from "node:crypto";
import { prisma } from "./db";
import { createLumaClient } from "./luma-client";

export async function eligibleInvitationRecipients<T extends { email: string }>(
  guests: T[],
  database = prisma(),
  eventId?: string,
) {
  const addresses = [
    ...new Set(guests.map((g) => g.email.trim().toLowerCase())),
  ];
  const chunks: string[][] = [];
  for (let i = 0; i < addresses.length; i += 5000) chunks.push(addresses.slice(i, i + 5000));
  const records = (await Promise.all(chunks.map(chunk => database.emailAddress.findMany({
    where: { emailLower: { in: chunk } },
  })))).flat();
  const excluded = new Set(records.filter((r) => emailDecision(r).status === "blocked").map((x) => x.emailLower));
  for (const chunk of chunks) for (const email of await removedEmails(chunk, database)) excluded.add(email);
  if (eventId) {
    const optOuts = (await Promise.all(chunks.map(chunk => database.lumaCalendarOptOut.findMany({
      where: { emailLower: { in: chunk } },
    })))).flat();
    if (optOuts.length) {
      const event = await database.lumaEvent.findUnique({
        where: { eventId },
        select: { raw: true },
      });
      const calendarId = calendarIdFromEvent(event?.raw);
      if (!calendarId)
        throw new Error(
          "Refresh this event’s calendar information before sending to addresses with calendar opt-outs.",
        );
      for (const row of optOuts)
        if (row.calendarId === calendarId) excluded.add(row.emailLower);
    }
  }
  return {
    eligible: guests.filter((g) => !excluded.has(g.email.trim().toLowerCase())),
    excluded: guests.filter((g) => excluded.has(g.email.trim().toLowerCase())),
  };
}

// Each request is recorded before dispatch. A transport error is ambiguous and is never retried here.
export async function trackedSend(
  eventId: string,
  guests: any[],
  message: string,
  requestId: string,
  client: ReturnType<typeof createLumaClient>,
  database = prisma(),
) {
  if(humanIdentityEnabled()) guests=await chooseHumanRecipients(guests,database,eventId);
  const { eligible, excluded } = await eligibleInvitationRecipients(
    guests,
    database,
    eventId,
  );
  const batchId = randomUUID();
  if (!eligible.length)
    return {
      accepted: 0,
      skipped: excluded.length,
      skippedEmails: excluded.map((g) => g.email.trim().toLowerCase()),
      batchId,
    };
  const db = database;
  const emails = eligible.map((g) => g.email.trim().toLowerCase());
  const [people, event] = await Promise.all([
    db.lumaPerson.findMany({
      where: { emailLower: { in: emails } },
      select: {
        personId: true,
        emailLower: true,
        lumaUserId: true,
        name: true,
      },
    }),
    db.lumaEvent.findUnique({ where: { eventId }, select: { title: true } }),
  ]);
  const requestedAt = new Date();
  for (const g of eligible) {
    const emailLower = g.email.trim().toLowerCase();
    const person = people.find((p) => p.emailLower === emailLower);
    const data = {
      personId: g.personId || person?.personId,
      lumaUserId: person?.lumaUserId,
      name: person?.name || g.name,
      eventTitle: event?.title,
      requestedAt,
      status: "processing",
      nextCheckAt: new Date(Date.now() + 30_000),
      retryCount: 0,
      lastError: null,
      priority: 20,
    };
    await db.lumaInviteTracking.upsert({
      where: { eventId_emailLower: { eventId, emailLower } },
      create: { eventId, emailLower, ...data },
      update: data,
    });
  }
  await db.lumaInviteAttempt.createMany({
    data: emails.map((emailLower) => ({ batchId, eventId, emailLower })),
  });
  try {
    const response = await client.publicRequestForEvent(
      "/v1/events/guests/send-invites",
      eventId,
      {
        requestId,
        method: "POST",
        body: {
          event_id: eventId,
          guests: eligible.map((g) => ({
            email: g.email,
            name: g.name || null,
          })),
          message,
        },
      },
    );
    // Unknown response shapes must not be interpreted as proof of delivery.
    const skippedEntries = response?.skipped || [];
    const skipped = new Set<string>(
      Array.isArray(skippedEntries)
        ? skippedEntries
            .map((g) =>
              String(typeof g === "string" ? g : g.email || "").toLowerCase(),
            )
            .filter((email) => emails.includes(email))
        : [],
    );
    for (const emailLower of skipped) {
      if (!emails.includes(emailLower)) continue;
      await db.lumaInviteTracking.update({
        where: { eventId_emailLower: { eventId, emailLower } },
        data: { status: "skipped", nextCheckAt: null },
      });
      await db.lumaInviteAttempt.updateMany({
        where: { batchId, emailLower },
        data: { status: "skipped" },
      });
    }
    await db.lumaInviteAttempt.updateMany({
      where: { batchId, status: "processing" },
      data: { status: "accepted" },
    });
    return {
      accepted: eligible.length - skipped.size,
      skipped: excluded.length + skipped.size,
      skippedEmails: [
        ...skipped,
        ...excluded.map((g) => g.email.trim().toLowerCase()),
      ],
      batchId,
    };
  } catch (error) {
    await db.lumaInviteTracking.updateMany({
      where: { eventId, emailLower: { in: emails }, requestedAt },
      data: { status: "unconfirmed" },
    });
    await db.lumaInviteAttempt.updateMany({
      where: { batchId },
      data: { status: "unconfirmed" },
    });
    throw error;
  }
}

export async function cacheReinviteEmail(
  eventId: string,
  email: string,
  entry: any,
) {
  const emailLower = email.trim().toLowerCase();
  const db = prisma();
  const [person, event, old] = await Promise.all([
    db.lumaPerson.findFirst({
      where: { emailLower },
      select: { personId: true, lumaUserId: true, name: true },
    }),
    db.lumaEvent.findUnique({ where: { eventId }, select: { title: true } }),
    db.lumaInviteTracking.findUnique({
      where: { eventId_emailLower: { eventId, emailLower } },
    }),
  ]);
  const incoming = invitationMessages([entry]);
  const messages = mergeInvitationMessages(
    Array.isArray(old?.messages) ? old.messages : [],
    incoming,
  );
  const status = emailStatus(entry.email || {});
  const issue = ["bounced", "reported"].includes(status) ? status : null;
  const data = {
    personId: person?.personId,
    lumaUserId: person?.lumaUserId,
    name: person?.name,
    eventTitle: event?.title,
    status,
    messages,
    nextCheckAt: issue ? null : new Date(Date.now() + 30_000),
    priority: issue ? 0 : 20,
    retryCount: 0,
    checkedAt: new Date(),
    requestedAt: new Date(
      entry.email?.sent_at || entry.timestamp || Date.now(),
    ),
    ...(issue ? { issueReason: issue } : {}),
  };
  await db.lumaInviteTracking.upsert({
    where: { eventId_emailLower: { eventId, emailLower } },
    create: { eventId, emailLower, ...data },
    update: data,
  });
  if (issue) await recordLumaIssue(emailLower, issue, entry.email?.bounced_at || entry.email?.marked_as_spam_at ? new Date(entry.email.bounced_at || entry.email.marked_as_spam_at) : null, db);
}

// Destination selection happens after human deduplication, with the existing
// per-address verification/removal/calendar policies applied before fallback.
export async function chooseHumanRecipients(guests:any[],db:any,eventId:string){
  const source=db.$source||db;
  if(typeof source.$transaction==='function')return source.$transaction(async(tx:any)=>{await tx.$executeRaw`SELECT pg_advisory_xact_lock(821157031)`;return chooseHumanRecipients(guests,humanClient(tx),eventId);},{timeout:30000});
  const requested=[...new Set<string>(guests.map(g=>String(g.email).trim().toLowerCase()))];
  const links=await source.guestbookPersonEmail.findMany({where:{emailLower:{in:requested},person:{mergedIntoId:null}}});
  const groups=new Map<string,any>();
  for(const guest of guests){
    const email=String(guest.email).trim().toLowerCase();
    let personId=guest.personId||guest.id;
    if(personId)[personId]=await resolveHumanIds(source,[personId]);
    else {
      const owners=[...new Set(links.filter((l:any)=>l.emailLower===email).map((l:any)=>l.personId))];
      if(owners.length>1)throw Object.assign(new Error('Select a person when an email address belongs to multiple people.'),{status:409});
      personId=owners[0];
    }
    if(personId&&!links.some((l:any)=>l.personId===personId&&l.emailLower===email))throw Object.assign(new Error('The selected email is not linked to this person.'),{status:409});
    const key=personId||`email:${email}`;
    if(!groups.has(key))groups.set(key,{...guest,email,personId});
  }
  const ids=[...groups.values()].map(g=>g.personId).filter(Boolean);
  const contacts=await source.guestbookPersonEmail.findMany({where:{personId:{in:ids},person:{mergedIntoId:null}}});
  const candidates=[...groups.values()].flatMap(g=>[g,...contacts.filter((c:any)=>c.personId===g.personId&&c.emailLower!==g.email).map((c:any)=>({...g,email:c.emailLower}))]);
  const allowed=await eligibleInvitationRecipients(candidates,db,eventId);
  return [...groups.values()].map(g=>allowed.eligible.find(c=>g.personId?c.personId===g.personId:c.email===g.email)||g);
}
