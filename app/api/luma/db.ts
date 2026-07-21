import { Prisma, PrismaClient } from "@prisma/client";

type AnyRecord = Record<string, any>;
type HttpError = Error & { status?: number };
import { orderAvatarCandidates } from "../../avatar-order";
import { databaseUrlWithPoolLimits } from "./database-url";
import { lumaEventDate } from "./event-date";
import { eventGuestWhere, guestStatusWhere, type GuestFilter, type GuestListQuery } from "./guest-query";
import { normalizePersonTags } from "./person-tags";
import { buildRegistrationQuestionAnalytics } from "../../event-analytics";

const PRISMA_KEY = "__guestbookPrismaClientV3";
const LEGACY_PRISMA_KEYS = ["__guestbookPrismaClientV2", "__guestbookPrismaClient"];

const INDEXED_PERSON_SELECT = {
  personId: true,
  lumaUserId: true,
  email: true,
  name: true,
  title: true,
  bio: true,
  avatarUrl: true,
  profileUrl: true,
  socialLinks: true,
  referrer: true,
  groups: true,
  tags: true,
};

const INDEXED_GUEST_SELECT = {
  eventId: true,
  personId: true,
  lumaGuestId: true,
  email: true,
  status: true,
  lumaApprovalStatus: true,
  registeredAt: true,
  invitedAt: true,
  createdAt: true,
  updatedAt: true,
  approvedAt: true,
  checkedInAt: true,
  profileDescription: true,
  registrationAnswers: true,
  socialLinks: true,
  referrer: true,
  searchText: true,
  lastSeenAt: true,
  person: { select: INDEXED_PERSON_SELECT },
};

export function hasLumaDb() {
  return Boolean(process.env.DB_URL);
}

export async function listIndexedEvents({ limit = 100 } = {}) {
  const rows = await prisma().lumaEvent.findMany({
    take: limit,
    orderBy: [{ startsAt: "desc" }, { lastSeenAt: "desc" }],
  });

  return {
    source: "luma-index",
    events: rows.map(indexedEventToApiEvent),
    people: [],
    loadedAt: new Date().toISOString(),
    indexed: true,
  };
}

export async function listIndexedEventGuests(
  eventId: string,
  query: GuestListQuery = { filter: "all", search: "", tags: [], cursor: 0, pageSize: 50 },
) {
  const db = prisma();
  const where = eventGuestWhere(eventId, query);
  const statWhere = (filter: GuestFilter) => {
    const statusWhere = guestStatusWhere(eventId, filter);
    return { eventId, ...(statusWhere ? { AND: [statusWhere] } : {}) };
  };
  const newFaceWhere = guestStatusWhere(eventId, "new_faces");
  const [rows, filteredCount, total, checkedIn, accepted, registered, invited, waitlisted, newFaces, analyticsQuestionRows] = await db.$transaction([
    db.lumaEventGuest.findMany({
      where,
      select: INDEXED_GUEST_SELECT,
      skip: query.cursor,
      take: query.pageSize,
      orderBy: [{ checkedInAt: "desc" }, { registeredAt: "desc" }, { createdAt: "desc" }, { lastSeenAt: "desc" }],
    }),
    db.lumaEventGuest.count({ where }),
    db.lumaEventGuest.count({ where: { eventId } }),
    db.lumaEventGuest.count({ where: statWhere("checked_in") }),
    db.lumaEventGuest.count({ where: statWhere("accepted") }),
    db.lumaEventGuest.count({ where: statWhere("registered") }),
    db.lumaEventGuest.count({ where: statWhere("invited") }),
    db.lumaEventGuest.count({ where: statWhere("waitlisted") }),
    db.lumaEventGuest.count({ where: statWhere("new_faces") }),
    db.lumaEventGuest.findMany({
      where: {
        eventId,
        status: { in: ["registered", "going", "waitlisted", "checked_in", "declined", "no_show"] },
        ...(newFaceWhere ? { AND: [newFaceWhere] } : {}),
      },
      select: { personId: true, registrationAnswers: true },
      take: safeInt("LUMA_ANALYTICS_MAX_NEW_FACES", 1000, 1, 5000),
      orderBy: [{ registeredAt: "desc" }, { createdAt: "desc" }, { lastSeenAt: "desc" }],
    }),
  ]);

  const personIds = [...new Set(rows.map((row) => row.personId))];
  const [attendedCounts, registeredCounts, historyCounts] = personIds.length
    ? await db.$transaction([
        db.lumaEventGuest.groupBy({
          by: ["personId"],
          where: {
            personId: { in: personIds },
            OR: [{ checkedInAt: { not: null } }, { status: "checked_in" }],
          },
          _count: { _all: true },
        }),
        db.lumaEventGuest.groupBy({
          by: ["personId"],
          where: {
            personId: { in: personIds },
            status: { in: ["registered", "going", "waitlisted", "checked_in", "declined", "no_show"] },
          },
          _count: { _all: true },
        }),
        db.lumaEventGuest.groupBy({
          by: ["personId"],
          where: {
            personId: { in: personIds },
            eventId: { not: eventId },
          },
          _count: { _all: true },
        }),
      ])
    : [[], [], []];

  const eventCountsByPerson = new Map(personIds.map((personId) => [personId, { attended: 0, registered: 0, history: 0 }]));
  attendedCounts.forEach((row) => {
    eventCountsByPerson.get(row.personId).attended = row._count._all;
  });
  registeredCounts.forEach((row) => {
    eventCountsByPerson.get(row.personId).registered = row._count._all;
  });
  historyCounts.forEach((row) => {
    eventCountsByPerson.get(row.personId).history = row._count._all;
  });

  const peopleById = new Map();
  const guests = rows.map((row) => {
    const person = indexedPersonToApiPerson(row.person, row);
    if (!peopleById.has(person.id)) peopleById.set(person.id, person);
    const eventCounts = eventCountsByPerson.get(row.personId);
    return { ...indexedGuestToApiGuest(row, eventCounts), isNewFace: eventCounts.history === 0 };
  });

  const nextCursor = query.cursor + rows.length;

  return {
    source: "luma-index",
    eventId,
    guests,
    people: [...peopleById.values()],
    loadedAt: new Date().toISOString(),
    indexed: true,
    stats: { total, checkedIn, accepted, registered, invited, waitlisted, newFaces },
    analyticsQuestions: buildRegistrationQuestionAnalytics(analyticsQuestionRows),
    pageInfo: {
      total: filteredCount,
      pageSize: query.pageSize,
      hasMore: nextCursor < filteredCount,
      nextCursor: nextCursor < filteredCount ? String(nextCursor) : null,
    },
    query: { filter: query.filter, search: query.search, tags: query.tags },
  };
}

export async function listIndexedPersonTags() {
  const rows = await prisma().$queryRaw<Array<{ tag: string }>>(Prisma.sql`
    SELECT DISTINCT tag_value AS tag
    FROM luma_people
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(tags) = 'array' THEN tags ELSE '[]'::jsonb END
    ) AS tag_values(tag_value)
    WHERE length(tag_value) > 0
    ORDER BY tag_value
    LIMIT 500
  `);
  return rows.map((row) => row.tag);
}

export async function setIndexedPersonTags(personId: string, value: unknown) {
  const tags = normalizePersonTags(value);
  return prisma().lumaPerson.update({
    where: { personId },
    data: { tags: sanitizeJson(tags) },
    select: { personId: true, tags: true },
  });
}

export async function getIndexedTrace({ tracePersonId, traceEmail, limit = 500 }: AnyRecord = {}) {
  const rawPersonId = typeof tracePersonId === "string" ? tracePersonId.trim() : "";
  const targetId = normalizeTraceValue(tracePersonId);
  const targetEmail = normalizeEmail(traceEmail);

  if (!targetId && !targetEmail) {
    const error = new Error("Indexed trace requires a Luma person id or email.") as HttpError;
    error.status = 400;
    throw error;
  }

  const guestMatches = [];
  if (rawPersonId) guestMatches.push({ personId: rawPersonId });
  if (targetId) guestMatches.push({ lumaUserIdLower: targetId });
  if (targetEmail) guestMatches.push({ emailLower: targetEmail });

  const rows = await prisma().lumaEventGuest.findMany({
    where: { OR: guestMatches },
    select: {
      ...INDEXED_GUEST_SELECT,
      event: {
        select: {
          title: true,
          date: true,
          startsAt: true,
          category: true,
          location: true,
          lumaUrl: true,
        },
      },
    },
    take: limit,
    orderBy: [{ checkedInAt: "desc" }, { registeredAt: "desc" }, { createdAt: "desc" }, { lastSeenAt: "desc" }],
  });

  const records = rows.map(indexedGuestToTraceRecord).sort((a, b) => new Date(b.eventStartsAt || b.eventDate || b.sortAt).getTime() - new Date(a.eventStartsAt || a.eventDate || a.sortAt).getTime());

  return {
    source: "luma-index",
    records,
    loadedAt: new Date().toISOString(),
    cached: false,
    indexed: true,
    scanned: {
      eventCount: records.length,
      guestCount: records.length,
      truncatedEvents: false,
      truncatedGuestEventCount: 0,
    },
    limits: {
      maxRecords: limit,
    },
  };
}

export async function removeIndexedTraceRecordsMissingFromEvents({ tracePersonId, traceEmail, scannedEventIds = [], matchedEventIds = [] }: AnyRecord = {}) {
  const rawPersonId = typeof tracePersonId === "string" ? tracePersonId.trim() : "";
  const targetId = normalizeTraceValue(tracePersonId);
  const targetEmail = normalizeEmail(traceEmail);
  const scannedIds = [...new Set(scannedEventIds.filter(Boolean))];
  const matchedIds = new Set(matchedEventIds.filter(Boolean));
  const missingEventIds = scannedIds.filter((eventId) => !matchedIds.has(eventId));

  if (!missingEventIds.length || (!rawPersonId && !targetId && !targetEmail)) return { deletedCount: 0 };

  const guestMatches = [];
  if (rawPersonId) guestMatches.push({ personId: rawPersonId });
  if (targetId) guestMatches.push({ lumaUserIdLower: targetId });
  if (targetEmail) guestMatches.push({ emailLower: targetEmail });

  const result = await prisma().lumaEventGuest.deleteMany({
    where: {
      eventId: { in: missingEventIds },
      OR: guestMatches,
    },
  });
  return { deletedCount: result.count };
}

export async function removeIndexedEventGuestsMissingFromSnapshot({ eventId, personIds = [] }: AnyRecord = {}) {
  if (!eventId) return { deletedCount: 0 };
  const currentPersonIds = [...new Set(personIds.filter(Boolean))];
  const result = await prisma().lumaEventGuest.deleteMany({
    where: {
      eventId,
      ...(currentPersonIds.length ? { personId: { notIn: currentPersonIds } } : {}),
    },
  });
  return { deletedCount: result.count };
}

export async function updateIndexedGuestStatus({ eventId, lumaGuestId, status, lumaApprovalStatus }) {
  if (!eventId || !lumaGuestId) return { updatedCount: 0 };
  const now = new Date();
  const result = await prisma().lumaEventGuest.updateMany({
    where: { eventId, lumaGuestId },
    data: {
      status,
      lumaApprovalStatus,
      updatedAt: now,
      ...(status === "going" ? { approvedAt: now } : {}),
      lastSeenAt: now,
      syncedAt: now,
    },
  });
  return { updatedCount: result.count };
}

export async function getIndexStats() {
  const db = prisma();
  const [eventCount, personCount, guestRecordCount, lastGuest, lastEvent, lastRun, truncatedEventCount, errorEventCount, runningSyncRunCount, truncatedEvents] = await db.$transaction([
    db.lumaEvent.count(),
    db.lumaPerson.count(),
    db.lumaEventGuest.count(),
    db.lumaEventGuest.findFirst({ orderBy: { syncedAt: "desc" }, select: { syncedAt: true } }),
    db.lumaEvent.findFirst({ orderBy: { syncedAt: "desc" }, select: { syncedAt: true } }),
    db.lumaSyncRun.findFirst({ orderBy: { startedAt: "desc" } }),
    db.lumaEventSyncState.count({ where: { truncated: true } }),
    db.lumaEventSyncState.count({ where: { lastStatus: "error" } }),
    db.lumaSyncRun.count({ where: { status: "running" } }),
    db.lumaEventSyncState.findMany({
      where: { truncated: true },
      include: { event: { select: { title: true, startsAt: true } } },
      orderBy: [{ lastGuestCount: "desc" }, { updatedAt: "desc" }],
      take: 10,
    }),
  ]);

  return {
    eventCount,
    personCount,
    guestRecordCount,
    truncatedEventCount,
    errorEventCount,
    runningSyncRunCount,
    truncatedEvents: truncatedEvents.map((state) => ({
      eventId: state.eventId,
      title: state.event?.title || "Untitled event",
      startsAt: isoOrNull(state.event?.startsAt),
      lastGuestCount: state.lastGuestCount,
      lastGuestSyncAt: isoOrNull(state.lastGuestSyncAt),
    })),
    lastGuestSyncedAt: isoOrNull(lastGuest?.syncedAt),
    lastEventSyncedAt: isoOrNull(lastEvent?.syncedAt),
    lastRun: lastRun
      ? {
          id: lastRun.id,
          requestId: lastRun.requestId,
          status: lastRun.status,
          startedAt: isoOrNull(lastRun.startedAt),
          finishedAt: isoOrNull(lastRun.finishedAt),
          eventCount: lastRun.eventCount,
          guestCount: lastRun.guestCount,
          personCount: lastRun.personCount,
          error: lastRun.error,
        }
      : null,
  };
}

export async function getIndexedPersonAvatarSource(personId) {
  if (!personId) return null;
  return prisma().lumaPerson.findUnique({
    where: { personId },
    select: {
      personId: true,
      lumaUserId: true,
      avatarUrl: true,
      socialLinks: true,
      raw: true,
    },
  });
}

export async function updateIndexedPersonAvatar(personId, avatarUrl) {
  if (!personId || !isHttpUrl(avatarUrl)) return null;
  return prisma().lumaPerson.update({
    where: { personId },
    data: { avatarUrl, lastSeenAt: new Date() },
    select: { personId: true, avatarUrl: true },
  });
}

export async function getEventSyncStates(eventIds = []) {
  if (!eventIds.length) return new Map();
  const states = await prisma().lumaEventSyncState.findMany({
    where: {
      eventId: {
        in: eventIds,
      },
    },
  });
  return new Map(states.map((state) => [state.eventId, state]));
}

export async function createSyncRun({ requestId, limits }) {
  return prisma().lumaSyncRun.create({
    data: {
      requestId,
      status: "running",
      limits: sanitizeJson(limits || {}),
    },
  });
}

export async function finishSyncRun(id, { status, eventCount = 0, guestCount = 0, personCount = 0, error = null }) {
  return prisma().lumaSyncRun.update({
    where: { id },
    data: {
      status,
      eventCount,
      guestCount,
      personCount,
      error: error ? String(error).slice(0, 2000) : null,
      finishedAt: new Date(),
    },
  });
}

export async function recordEventSyncState({ eventId, guestCount = 0, status, truncated = false, error = null, syncGuests = true }) {
  const now = new Date();
  const guestSyncCreateData = syncGuests
    ? {
        lastGuestSyncAt: now,
        lastGuestCount: guestCount,
        truncated,
      }
    : {};
  const guestSyncUpdateData = syncGuests
    ? {
        lastGuestSyncAt: now,
        lastGuestCount: guestCount,
        truncated,
      }
    : {};

  return prisma().lumaEventSyncState.upsert({
    where: { eventId },
    create: {
      eventId,
      ...guestSyncCreateData,
      lastEventSyncAt: now,
      lastStatus: status,
      error: error ? String(error).slice(0, 2000) : null,
    },
    update: {
      ...guestSyncUpdateData,
      lastEventSyncAt: now,
      lastStatus: status,
      error: error ? String(error).slice(0, 2000) : null,
    },
  });
}

export async function upsertNormalizedLumaSnapshot({ rawEvent, event, guests = [], rawGuests = [] }) {
  if (!hasLumaDb()) return { skipped: true, eventCount: 0, guestCount: 0, personCount: 0 };

  const uniquePeople = new Set();
  const chunkSize = safeInt("DB_SYNC_GUEST_WRITE_CHUNK_SIZE", 250, 1, 1000);
  const timeout = safeInt("DB_TRANSACTION_TIMEOUT_MS", 30000, 5000, 120000);
  await prisma().$transaction(
    async (tx) => {
      await upsertEvent(tx, event, rawEvent);
    },
    { timeout },
  );

  for (let start = 0; start < guests.length; start += chunkSize) {
    const guestChunk = guests.slice(start, start + chunkSize);
    const rawGuestChunk = rawGuests.slice(start, start + chunkSize);
    await prisma().$transaction(
      async (tx) => {
        await upsertGuestChunk(tx, event, guestChunk, rawGuestChunk, uniquePeople);
      },
      { timeout },
    );
  }

  return {
    skipped: false,
    eventCount: 1,
    guestCount: guests.length,
    personCount: uniquePeople.size,
  };
}

export async function upsertNormalizedLumaEvents(snapshots: Array<{ rawEvent: AnyRecord; event: AnyRecord }>) {
  if (!hasLumaDb() || !snapshots.length) return { skipped: !hasLumaDb(), eventCount: 0 };

  const now = new Date();
  const rows = snapshots.map(({ rawEvent, event }) => {
    const data = normalizedEventData(event, rawEvent, now);
    return { ...data, rawJson: JSON.stringify(data.raw) };
  });

  await prisma().$executeRaw(
    Prisma.sql`
      INSERT INTO "luma_events" (
        "event_id", "title", "date", "starts_at", "location", "category",
        "capacity", "luma_url", "raw", "last_seen_at", "synced_at"
      )
      VALUES ${Prisma.join(
        rows.map(
          (row) => Prisma.sql`(
            ${row.eventId}, ${row.title}, ${row.date}, ${row.startsAt}, ${row.location}, ${row.category},
            ${row.capacity}, ${row.lumaUrl}, ${row.rawJson}::jsonb, ${row.lastSeenAt}, ${row.syncedAt}
          )`,
        ),
      )}
      ON CONFLICT ("event_id") DO UPDATE SET
        "title" = EXCLUDED."title",
        "date" = EXCLUDED."date",
        "starts_at" = EXCLUDED."starts_at",
        "location" = EXCLUDED."location",
        "category" = EXCLUDED."category",
        "capacity" = EXCLUDED."capacity",
        "luma_url" = EXCLUDED."luma_url",
        "raw" = EXCLUDED."raw",
        "last_seen_at" = EXCLUDED."last_seen_at",
        "synced_at" = EXCLUDED."synced_at"
    `,
  );

  return { skipped: false, eventCount: rows.length };
}

export async function upsertNormalizedLumaGuestActivity({ event, guest, rawGuest = {} }) {
  if (!hasLumaDb()) return { skipped: true, guestCount: 0, personCount: 0 };
  const uniquePeople = new Set();
  const timeout = safeInt("DB_TRANSACTION_TIMEOUT_MS", 30000, 5000, 120000);
  await prisma().$transaction(
    async (tx) => {
      await upsertGuestChunk(tx, event, [guest], [rawGuest], uniquePeople);
    },
    { timeout },
  );
  return { skipped: false, guestCount: 1, personCount: uniquePeople.size };
}

function prisma() {
  if (!hasLumaDb()) {
    const error = new Error("Missing DB_URL. Add a PostgreSQL connection string before using the Luma index.") as HttpError;
    error.status = 503;
    throw error;
  }

  if (!globalThis[PRISMA_KEY]) {
    for (const legacyKey of LEGACY_PRISMA_KEYS) {
      const legacyClient = globalThis[legacyKey];
      if (legacyClient?.$disconnect) void legacyClient.$disconnect().catch(() => {});
      delete globalThis[legacyKey];
    }

    const connectionLimit = safeInt("DB_CONNECTION_LIMIT", 2, 1, 10);
    const poolTimeoutSeconds = safeInt("DB_POOL_TIMEOUT_SECONDS", 20, 1, 60);
    const preferSupabaseTransactionPooler = process.env.DB_RUNTIME_POOL_MODE !== "session";
    globalThis[PRISMA_KEY] = new PrismaClient({
      datasources: {
        db: {
          url: databaseUrlWithPoolLimits(process.env.DB_RUNTIME_URL || process.env.DB_URL, {
            connectionLimit,
            poolTimeoutSeconds,
            preferSupabaseTransactionPooler,
          }),
        },
      },
    });
  }
  return globalThis[PRISMA_KEY];
}

async function upsertEvent(tx, event, rawEvent = {}) {
  const data = normalizedEventData(event, rawEvent);

  await tx.lumaEvent.upsert({
    where: { eventId: data.eventId },
    create: data,
    update: data,
  });
}

function normalizedEventData(event, rawEvent = {}, now = new Date()) {
  return {
    eventId: event.id,
    title: event.title || "Untitled event",
    date: parseDateOnly(event.date || event.startsAt),
    startsAt: parseDateTime(event.startsAt),
    location: event.location || null,
    category: event.category || null,
    capacity: Number.isFinite(event.capacity) ? event.capacity : null,
    lumaUrl: event.lumaUrl || null,
    raw: sanitizeJson(rawEvent || {}),
    lastSeenAt: now,
    syncedAt: now,
  };
}

async function upsertGuestChunk(tx, event, guests, rawGuests, uniquePeople) {
  const now = new Date();
  const peopleById = new Map();
  const guestRowsByPersonId = new Map();

  for (let index = 0; index < guests.length; index += 1) {
    const guest = guests[index];
    const rawGuest = rawGuests[index] || {};
    const rows = normalizeGuestRows(event, guest, rawGuest, now);
    if (!rows) continue;
    uniquePeople.add(rows.person.personId);
    peopleById.set(rows.person.personId, rows.person);
    guestRowsByPersonId.set(rows.guest.personId, rows.guest);
  }

  const people = [...peopleById.values()];
  const guestRows = [...guestRowsByPersonId.values()];
  if (people.length) await bulkUpsertPeople(tx, people);
  if (guestRows.length) await bulkUpsertEventGuests(tx, guestRows);
}

function normalizeGuestRows(event, guest, rawGuest = {}, now = new Date()) {
  const person = guest?.person || {};
  const personId = guest?.personId || person.id;
  if (!personId) return null;

  const email = person.email || guest.email || null;
  const emailLower = normalizeEmail(email) || null;
  const lumaUserId = person.lumaUserId || guest.lumaUserId || null;
  const lumaUserIdLower = normalizeTraceValue(lumaUserId) || null;
  const socialLinks = person.socialLinks || guest.socialLinks || [];
  const referrer = person.referrer || guest.referrer || null;
  const bio = person.bio || person.profileDescription || guest.profileDescription || null;

  return {
    person: {
      personId,
      lumaUserId,
      lumaUserIdLower,
      email,
      emailLower,
      name: person.name || "Unnamed guest",
      title: person.title || null,
      bio,
      avatarUrl: person.avatarUrl || guest.avatarUrl || null,
      profileUrl: person.profileUrl || guest.profileUrl || null,
      socialLinks: sanitizeJson(socialLinks || []),
      referrer: jsonOrNull(referrer),
      groups: sanitizeJson(person.groups || []),
      tags: [],
      raw: sanitizeJson(rawGuest || {}),
      lastSeenAt: now,
      syncedAt: now,
    },
    guest: {
      eventId: event.id,
      personId,
      lumaGuestId: guest.lumaGuestId || null,
      lumaUserId,
      lumaUserIdLower,
      email,
      emailLower,
      status: guest.status || null,
      lumaApprovalStatus: guest.lumaApprovalStatus || null,
      registeredAt: parseDateTime(guest.registeredAt),
      invitedAt: parseDateTime(guest.invitedAt),
      createdAt: parseDateTime(guest.createdAt),
      updatedAt: parseDateTime(guest.updatedAt),
      approvedAt: parseDateTime(guest.approvedAt),
      checkedInAt: parseDateTime(guest.checkedInAt),
      profileDescription: guest.profileDescription || person.profileDescription || person.bio || null,
      registrationAnswers: sanitizeJson(guest.registrationAnswers || []),
      socialLinks: sanitizeJson(socialLinks || []),
      referrer: jsonOrNull(referrer),
      searchText: guest.searchText || null,
      raw: sanitizeJson(rawGuest || {}),
      lastSeenAt: now,
      syncedAt: now,
    },
  };
}

async function bulkUpsertPeople(tx, rows) {
  await tx.$executeRaw`
    INSERT INTO luma_people (
      person_id,
      luma_user_id,
      luma_user_id_lower,
      email,
      email_lower,
      name,
      title,
      bio,
      avatar_url,
      profile_url,
      social_links,
      referrer,
      groups,
      tags,
      raw,
      last_seen_at,
      synced_at
    )
    VALUES ${Prisma.join(
      rows.map(
        (row) => Prisma.sql`(
          ${row.personId},
          ${row.lumaUserId},
          ${row.lumaUserIdLower},
          ${row.email},
          ${row.emailLower},
          ${row.name},
          ${row.title},
          ${row.bio},
          ${row.avatarUrl},
          ${row.profileUrl},
          ${toJsonString(row.socialLinks)}::jsonb,
          ${toNullableJsonString(row.referrer)}::jsonb,
          ${toJsonString(row.groups)}::jsonb,
          ${toJsonString(row.tags)}::jsonb,
          ${toJsonString(row.raw)}::jsonb,
          ${row.lastSeenAt},
          ${row.syncedAt}
        )`,
      ),
    )}
    ON CONFLICT (person_id) DO UPDATE SET
      luma_user_id = COALESCE(EXCLUDED.luma_user_id, luma_people.luma_user_id),
      luma_user_id_lower = COALESCE(EXCLUDED.luma_user_id_lower, luma_people.luma_user_id_lower),
      email = COALESCE(EXCLUDED.email, luma_people.email),
      email_lower = COALESCE(EXCLUDED.email_lower, luma_people.email_lower),
      name = EXCLUDED.name,
      title = COALESCE(EXCLUDED.title, luma_people.title),
      bio = COALESCE(EXCLUDED.bio, luma_people.bio),
      avatar_url = COALESCE(EXCLUDED.avatar_url, luma_people.avatar_url),
      profile_url = COALESCE(EXCLUDED.profile_url, luma_people.profile_url),
      social_links = CASE
        WHEN jsonb_typeof(EXCLUDED.social_links) = 'array' AND jsonb_array_length(EXCLUDED.social_links) > 0
          THEN EXCLUDED.social_links
        ELSE luma_people.social_links
      END,
      referrer = COALESCE(EXCLUDED.referrer, luma_people.referrer),
      raw = EXCLUDED.raw,
      last_seen_at = EXCLUDED.last_seen_at,
      synced_at = EXCLUDED.synced_at
  `;
}

async function bulkUpsertEventGuests(tx, rows) {
  await tx.$executeRaw`
    INSERT INTO luma_event_guests (
      event_id,
      person_id,
      luma_guest_id,
      luma_user_id,
      luma_user_id_lower,
      email,
      email_lower,
      status,
      luma_approval_status,
      registered_at,
      invited_at,
      created_at,
      updated_at,
      approved_at,
      checked_in_at,
      profile_description,
      registration_answers,
      social_links,
      referrer,
      search_text,
      raw,
      last_seen_at,
      synced_at
    )
    VALUES ${Prisma.join(
      rows.map(
        (row) => Prisma.sql`(
          ${row.eventId},
          ${row.personId},
          ${row.lumaGuestId},
          ${row.lumaUserId},
          ${row.lumaUserIdLower},
          ${row.email},
          ${row.emailLower},
          ${row.status},
          ${row.lumaApprovalStatus},
          ${row.registeredAt},
          ${row.invitedAt},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.approvedAt},
          ${row.checkedInAt},
          ${row.profileDescription},
          ${toJsonString(row.registrationAnswers)}::jsonb,
          ${toJsonString(row.socialLinks)}::jsonb,
          ${toNullableJsonString(row.referrer)}::jsonb,
          ${row.searchText},
          ${toJsonString(row.raw)}::jsonb,
          ${row.lastSeenAt},
          ${row.syncedAt}
        )`,
      ),
    )}
    ON CONFLICT (event_id, person_id) DO UPDATE SET
      luma_guest_id = COALESCE(EXCLUDED.luma_guest_id, luma_event_guests.luma_guest_id),
      luma_user_id = COALESCE(EXCLUDED.luma_user_id, luma_event_guests.luma_user_id),
      luma_user_id_lower = COALESCE(EXCLUDED.luma_user_id_lower, luma_event_guests.luma_user_id_lower),
      email = COALESCE(EXCLUDED.email, luma_event_guests.email),
      email_lower = COALESCE(EXCLUDED.email_lower, luma_event_guests.email_lower),
      status = EXCLUDED.status,
      luma_approval_status = EXCLUDED.luma_approval_status,
      registered_at = CASE
        WHEN EXCLUDED.status = 'invited' AND EXCLUDED.registered_at IS NULL THEN NULL
        ELSE COALESCE(EXCLUDED.registered_at, luma_event_guests.registered_at)
      END,
      invited_at = COALESCE(EXCLUDED.invited_at, luma_event_guests.invited_at),
      created_at = COALESCE(EXCLUDED.created_at, luma_event_guests.created_at),
      updated_at = COALESCE(EXCLUDED.updated_at, luma_event_guests.updated_at),
      approved_at = COALESCE(EXCLUDED.approved_at, luma_event_guests.approved_at),
      checked_in_at = COALESCE(EXCLUDED.checked_in_at, luma_event_guests.checked_in_at),
      profile_description = COALESCE(EXCLUDED.profile_description, luma_event_guests.profile_description),
      registration_answers = EXCLUDED.registration_answers,
      social_links = EXCLUDED.social_links,
      referrer = COALESCE(EXCLUDED.referrer, luma_event_guests.referrer),
      search_text = EXCLUDED.search_text,
      raw = EXCLUDED.raw,
      last_seen_at = EXCLUDED.last_seen_at,
      synced_at = EXCLUDED.synced_at
  `;
}

async function upsertGuest(tx, event, guest, rawGuest = {}) {
  const person = guest?.person || {};
  const personId = guest?.personId || person.id;
  if (!personId) return;

  const email = person.email || guest.email || null;
  const emailLower = normalizeEmail(email) || null;
  const lumaUserId = person.lumaUserId || guest.lumaUserId || null;
  const lumaUserIdLower = normalizeTraceValue(lumaUserId) || null;
  const socialLinks = person.socialLinks || guest.socialLinks || [];
  const referrer = person.referrer || guest.referrer || null;
  const now = new Date();

  await tx.lumaPerson.upsert({
    where: { personId },
    create: withoutUndefined({
      personId,
      lumaUserId,
      lumaUserIdLower,
      email,
      emailLower,
      name: person.name || "Unnamed guest",
      title: person.title || null,
      bio: person.bio || person.profileDescription || guest.profileDescription || null,
      avatarUrl: person.avatarUrl || guest.avatarUrl || null,
      profileUrl: person.profileUrl || guest.profileUrl || null,
      socialLinks: sanitizeJson(socialLinks || []),
      referrer: jsonOrUndefined(referrer),
      groups: sanitizeJson(person.groups || []),
      tags: [],
      raw: sanitizeJson(rawGuest || {}),
      lastSeenAt: now,
      syncedAt: now,
    }),
    update: withoutUndefined({
      lumaUserId: lumaUserId || undefined,
      lumaUserIdLower: lumaUserIdLower || undefined,
      email: email || undefined,
      emailLower: emailLower || undefined,
      name: person.name || "Unnamed guest",
      title: person.title || undefined,
      bio: person.bio || person.profileDescription || guest.profileDescription || undefined,
      avatarUrl: person.avatarUrl || guest.avatarUrl || undefined,
      profileUrl: person.profileUrl || guest.profileUrl || undefined,
      socialLinks: socialLinks.length ? sanitizeJson(socialLinks) : undefined,
      referrer: jsonOrUndefined(referrer),
      raw: sanitizeJson(rawGuest || {}),
      lastSeenAt: now,
      syncedAt: now,
    }),
  });

  await tx.lumaEventGuest.upsert({
    where: {
      eventId_personId: {
        eventId: event.id,
        personId,
      },
    },
    create: withoutUndefined({
      eventId: event.id,
      personId,
      lumaGuestId: guest.lumaGuestId || null,
      lumaUserId,
      lumaUserIdLower,
      email,
      emailLower,
      status: guest.status || null,
      lumaApprovalStatus: guest.lumaApprovalStatus || null,
      registeredAt: parseDateTime(guest.registeredAt),
      invitedAt: parseDateTime(guest.invitedAt),
      createdAt: parseDateTime(guest.createdAt),
      updatedAt: parseDateTime(guest.updatedAt),
      approvedAt: parseDateTime(guest.approvedAt),
      checkedInAt: parseDateTime(guest.checkedInAt),
      profileDescription: guest.profileDescription || person.profileDescription || person.bio || null,
      registrationAnswers: sanitizeJson(guest.registrationAnswers || []),
      socialLinks: sanitizeJson(socialLinks || []),
      referrer: jsonOrUndefined(referrer),
      searchText: guest.searchText || null,
      raw: sanitizeJson(rawGuest || {}),
      lastSeenAt: now,
      syncedAt: now,
    }),
    update: withoutUndefined({
      lumaGuestId: guest.lumaGuestId || undefined,
      lumaUserId: lumaUserId || undefined,
      lumaUserIdLower: lumaUserIdLower || undefined,
      email: email || undefined,
      emailLower: emailLower || undefined,
      status: guest.status || null,
      lumaApprovalStatus: guest.lumaApprovalStatus || null,
      registeredAt: parseDateTime(guest.registeredAt) || (guest.status === "invited" ? null : undefined),
      invitedAt: parseDateTime(guest.invitedAt) || undefined,
      createdAt: parseDateTime(guest.createdAt) || undefined,
      updatedAt: parseDateTime(guest.updatedAt) || undefined,
      approvedAt: parseDateTime(guest.approvedAt) || undefined,
      checkedInAt: parseDateTime(guest.checkedInAt) || undefined,
      profileDescription: guest.profileDescription || person.profileDescription || person.bio || undefined,
      registrationAnswers: sanitizeJson(guest.registrationAnswers || []),
      socialLinks: sanitizeJson(socialLinks || []),
      referrer: jsonOrUndefined(referrer),
      searchText: guest.searchText || null,
      raw: sanitizeJson(rawGuest || {}),
      lastSeenAt: now,
      syncedAt: now,
    }),
  });
}

function indexedEventToApiEvent(row) {
  return {
    id: row.eventId,
    title: row.title || "Untitled event",
    date: lumaEventDate(row.raw, row.startsAt || row.date || row.lastSeenAt),
    startsAt: isoOrNull(row.startsAt),
    location: row.location || "Location TBD",
    category: row.category || "Luma",
    capacity: row.capacity || 1,
    lumaUrl: row.lumaUrl || "",
    imageUrl: indexedEventImageUrl(row.raw),
    description: indexedEventDescription(row.raw),
    guests: [],
    guestsLoaded: false,
    source: "luma",
    dataSource: "luma-index",
    indexed: true,
    indexedAt: isoOrNull(row.syncedAt),
  };
}

function indexedPersonToApiPerson(row: any, guestRow: any = {}) {
  const avatarCandidates = indexedAvatarCandidates(row.raw, row.avatarUrl);
  return {
    id: row.personId,
    lumaUserId: row.lumaUserId || null,
    name: row.name || "Unnamed guest",
    email: row.email || guestRow.email || "",
    title: row.title || "Luma guest",
    profileDescription: row.bio || guestRow.profileDescription || "",
    bio: row.bio || guestRow.profileDescription || "",
    avatarUrl: avatarCandidates[0] || "",
    avatarCandidates,
    profileUrl: row.profileUrl || "",
    socialLinks: row.socialLinks || guestRow.socialLinks || [],
    referrer: row.referrer || guestRow.referrer || null,
    groups: row.groups || [],
    tags: row.tags || [],
    notes: row.bio || guestRow.profileDescription || "",
    source: "luma",
    dataSource: "luma-index",
    indexed: true,
  };
}

function indexedGuestToApiGuest(row, eventCounts = null) {
  const avatarCandidates = indexedAvatarCandidates(row.person?.raw, row.person?.avatarUrl);
  const registeredAt = indexedRegisteredAt(row);
  return {
    personId: row.personId,
    lumaGuestId: row.lumaGuestId,
    lumaApprovalStatus: row.lumaApprovalStatus,
    profileDescription: row.profileDescription || "",
    avatarUrl: avatarCandidates[0] || "",
    avatarCandidates,
    profileUrl: row.person?.profileUrl || "",
    socialLinks: row.socialLinks || row.person?.socialLinks || [],
    referrer: row.referrer || row.person?.referrer || null,
    registrationAnswers: row.registrationAnswers || [],
    searchText: row.searchText || "",
    source: "luma",
    dataSource: "luma-index",
    indexed: true,
    status: row.status || "registered",
    registeredAt,
    invitedAt: isoOrNull(row.invitedAt),
    createdAt: isoOrNull(row.createdAt),
    updatedAt: isoOrNull(row.updatedAt),
    approvedAt: isoOrNull(row.approvedAt),
    checkedInAt: isoOrNull(row.checkedInAt),
    eventCounts,
  };
}

function indexedGuestToTraceRecord(row) {
  const registeredAt = indexedRegisteredAt(row);
  return {
    eventId: row.eventId,
    eventTitle: row.event?.title || "Untitled event",
    eventDate: dateString(row.event?.date || row.event?.startsAt || row.lastSeenAt),
    eventStartsAt: isoOrNull(row.event?.startsAt),
    eventCategory: row.event?.category || "Luma",
    eventLocation: row.event?.location || "Location TBD",
    eventUrl: row.event?.lumaUrl || "",
    personId: row.personId,
    lumaGuestId: row.lumaGuestId,
    status: row.status || "registered",
    lumaApprovalStatus: row.lumaApprovalStatus,
    registeredAt,
    invitedAt: isoOrNull(row.invitedAt),
    checkedInAt: isoOrNull(row.checkedInAt),
    approvedAt: isoOrNull(row.approvedAt),
    profileDescription: row.profileDescription || row.person?.bio || "",
    registrationAnswers: row.registrationAnswers || [],
    referrer: row.referrer || row.person?.referrer || null,
    sortAt: isoOrNull(row.event?.startsAt || row.event?.date || row.checkedInAt || row.registeredAt || row.lastSeenAt),
  };
}

function indexedRegisteredAt(row) {
  if (row?.status === "invited" && !row?.registeredAt) return null;
  return isoOrNull(row?.registeredAt);
}

function parseDateOnly(value) {
  if (!value) return null;
  const date = new Date(typeof value === "string" && value.length === 10 ? value + "T00:00:00.000Z" : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDateTime(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateString(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function isoOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function indexedEventImageUrl(raw: AnyRecord = {}) {
  return firstHttpUrl(
    raw?.cover_url,
    raw?.cover_image_url,
    raw?.image_url,
    raw?.thumbnail_url,
    raw?.event_image_url,
    raw?.cover?.url,
    raw?.cover?.image_url,
    raw?.calendar?.avatar_url,
  );
}

function indexedEventDescription(raw: AnyRecord = {}) {
  return [raw?.description, raw?.description_md, raw?.event_description, raw?.summary].find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

function indexedAvatarCandidates(raw: AnyRecord = {}, storedAvatarUrl = "") {
  return orderAvatarCandidates(
    storedAvatarUrl,
    raw?.user_avatar_url,
    raw?.avatar_url,
    raw?.profile_picture_url,
    raw?.photo_url,
    raw?.image_url,
    raw?.user?.avatar_url,
    raw?.user?.profile_picture_url,
    raw?.user?.photo_url,
    raw?.user?.image_url,
    raw?.user?.avatar?.url,
    raw?.profile?.avatar_url,
    raw?.profile?.profile_picture_url,
    raw?.profile?.photo_url,
    raw?.profile?.image_url,
    raw?.profile_picture?.url,
    raw?.linkedin_avatar_url,
    raw?.linkedin_photo_url,
    raw?.linkedin_profile_picture_url,
    raw?.user?.linkedin_avatar_url,
    raw?.user?.linkedin_photo_url,
    raw?.profile?.linkedin_avatar_url,
    raw?.profile?.linkedin_photo_url,
    raw?.twitter_profile_image_url,
    raw?.twitter_avatar_url,
    raw?.x_profile_image_url,
    raw?.x_avatar_url,
    raw?.user?.twitter_profile_image_url,
    raw?.user?.twitter_avatar_url,
    raw?.profile?.twitter_profile_image_url,
    raw?.profile?.twitter_avatar_url,
  );
}

function firstHttpUrl(...values) {
  return values.find(isHttpUrl) || "";
}

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function normalizeTraceValue(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeEmail(value) {
  return normalizeTraceValue(value);
}

function sanitizeJson(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function jsonOrUndefined(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value) && value.length === 0) return undefined;
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return undefined;
  return sanitizeJson(value);
}

function jsonOrNull(value) {
  const sanitized = jsonOrUndefined(value);
  return sanitized === undefined ? null : sanitized;
}

function toJsonString(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function toNullableJsonString(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined));
}

function safeInt(envName: string, fallback: number, min: number, max: number) {
  const value = Number.parseInt(process.env[envName] || "", 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
