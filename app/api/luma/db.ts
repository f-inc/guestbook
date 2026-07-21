import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

type AnyRecord = Record<string, any>;
type HttpError = Error & { status?: number };
import { orderAvatarCandidates } from "../../avatar-order";
import { databaseUrlWithPoolLimits } from "./database-url";
import { lumaEventDate } from "./event-date";
import { GUEST_ACCEPTED_STATUSES, GUEST_REGISTERED_STATUSES, GUEST_REGISTRATION_STATUSES, guestStatusWhere, type GuestListQuery } from "./guest-query";
import { normalizePersonTags } from "./person-tags";
import { DEFAULT_TAG_COLOR, normalizeTagColor, normalizeTagName } from "./tag-catalog";
import { buildRegistrationQuestionAnalytics, REFERRED_PERSON_TAG } from "../../event-analytics";
import type { EventSwitchDiagnosticReporter } from "../../event-switch-diagnostics";
import { AUTOMATIC_TAG_DEFINITIONS, automaticTagRunMode, normalizeAutomaticTagPersonIds } from "./auto-tags";

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
  manualTags: true,
  automaticTags: true,
  crmNotes: true,
  crmNotesUpdatedAt: true,
};

const INDEXED_GUEST_SELECT = {
  eventId: true,
  personId: true,
  lumaGuestId: true,
  email: true,
  status: true,
  lumaApprovalStatus: true,
  operatorDecision: true,
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

type IndexedGuestPageRow = {
  totalCount: number;
  eventId: string;
  personId: string;
  lumaGuestId: string | null;
  email: string | null;
  status: string | null;
  lumaApprovalStatus: string | null;
  operatorDecision: string | null;
  registeredAt: Date | null;
  invitedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  approvedAt: Date | null;
  checkedInAt: Date | null;
  profileDescription: string | null;
  registrationAnswers: Prisma.JsonValue;
  socialLinks: Prisma.JsonValue;
  referrer: Prisma.JsonValue | null;
  searchText: string | null;
  lastSeenAt: Date;
  personLumaUserId: string | null;
  personEmail: string | null;
  personName: string;
  personTitle: string | null;
  personBio: string | null;
  personAvatarUrl: string | null;
  personProfileUrl: string | null;
  personSocialLinks: Prisma.JsonValue;
  personReferrer: Prisma.JsonValue | null;
  personGroups: Prisma.JsonValue;
  personTags: Prisma.JsonValue;
  personManualTags: Prisma.JsonValue;
  personAutomaticTags: Prisma.JsonValue;
  personCrmNotes: string;
  personCrmNotesUpdatedAt: Date | null;
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
  query: GuestListQuery = { filter: "all", search: "", tags: [], cursor: 0, pageSize: 50, includeSummary: true },
  diagnosticReporter?: EventSwitchDiagnosticReporter,
  knownEventBoundary?: { startsAt: Date | null; date: Date | null } | null,
) {
  const db = prisma();
  const includeSummary = query.includeSummary !== false;
  const includeEventCounts = query.includeEventCounts !== false;
  const needsChronology = includeSummary || includeEventCounts || ["first_registers", "new_faces"].includes(query.filter);
  // EVENT_SWITCH_DIAGNOSTICS: each report isolates one database phase without adding log I/O to the query path.
  let diagnosticStartedAt = Date.now();
  const eventBoundary = needsChronology
    ? knownEventBoundary || await db.lumaEvent.findUnique({
        where: { eventId },
        select: { startsAt: true, date: true },
      })
    : null;
  const eventBoundaryStage = !needsChronology
    ? "event_boundary_skipped"
    : knownEventBoundary
      ? "event_boundary_provided"
      : "event_boundary";
  diagnosticReporter?.(eventBoundaryStage, Date.now() - diagnosticStartedAt, {
    found: Boolean(eventBoundary),
  });
  const firstRegisterWhere = guestStatusWhere(eventId, "first_registers", eventBoundary);
  diagnosticStartedAt = Date.now();
  const pageRows = await db.$queryRaw<IndexedGuestPageRow[]>(Prisma.sql`
    WITH guest_page AS (
      SELECT
        guest.*,
        COUNT(*) OVER ()::integer AS total_count
      FROM luma_event_guests AS guest
      ${indexedGuestPageWhereSql(eventId, query, eventBoundary)}
      ORDER BY
        guest.checked_in_at DESC,
        guest.registered_at DESC,
        guest.created_at DESC,
        guest.last_seen_at DESC
      LIMIT ${query.pageSize}
      OFFSET ${query.cursor}
    )
    SELECT
      guest.total_count AS "totalCount",
      guest.event_id AS "eventId",
      guest.person_id AS "personId",
      guest.luma_guest_id AS "lumaGuestId",
      guest.email,
      guest.status,
      guest.luma_approval_status AS "lumaApprovalStatus",
      guest.operator_decision AS "operatorDecision",
      guest.registered_at AS "registeredAt",
      guest.invited_at AS "invitedAt",
      guest.created_at AS "createdAt",
      guest.updated_at AS "updatedAt",
      guest.approved_at AS "approvedAt",
      guest.checked_in_at AS "checkedInAt",
      guest.profile_description AS "profileDescription",
      guest.registration_answers AS "registrationAnswers",
      guest.social_links AS "socialLinks",
      guest.referrer,
      guest.search_text AS "searchText",
      guest.last_seen_at AS "lastSeenAt",
      person.luma_user_id AS "personLumaUserId",
      person.email AS "personEmail",
      person.name AS "personName",
      person.title AS "personTitle",
      person.bio AS "personBio",
      person.avatar_url AS "personAvatarUrl",
      person.profile_url AS "personProfileUrl",
      person.social_links AS "personSocialLinks",
      person.referrer AS "personReferrer",
      person.groups AS "personGroups",
      person.tags AS "personTags",
      person.manual_tags AS "personManualTags",
      person.automatic_tags AS "personAutomaticTags",
      person.crm_notes AS "personCrmNotes",
      person.crm_notes_updated_at AS "personCrmNotesUpdatedAt"
    FROM guest_page AS guest
    JOIN luma_people AS person
      ON person.person_id = guest.person_id
    ORDER BY
      guest.checked_in_at DESC,
      guest.registered_at DESC,
      guest.created_at DESC,
      guest.last_seen_at DESC
  `);
  const rows = pageRows.map(indexedGuestPageRowToRecord);
  const filteredCount = pageRows[0]?.totalCount ?? query.cursor;
  diagnosticReporter?.("guest_page_joined_count", Date.now() - diagnosticStartedAt, { rowCount: rows.length, filteredCount });

  let stats = null;
  let analyticsQuestions = null;
  if (includeSummary) {
    ({ stats, analyticsQuestions } = await indexedEventAnalytics(db, eventId, eventBoundary, firstRegisterWhere, diagnosticReporter));
  }

  const personIds = [...new Set<string>((rows as any[]).map((row) => String(row.personId)))];
  diagnosticStartedAt = Date.now();
  const eventCountRows = includeEventCounts && personIds.length
    ? await indexedEventCountsForPeople(db, eventId, personIds, eventBoundary)
    : [];
  diagnosticReporter?.(includeEventCounts ? "person_event_counts" : "person_event_counts_deferred", Date.now() - diagnosticStartedAt, {
    personCount: personIds.length,
    resultCount: eventCountRows.length,
  });

  diagnosticStartedAt = Date.now();
  const eventCountsByPerson = new Map(personIds.map((personId) => [personId, { attended: 0, registered: 0, history: 0 }]));
  eventCountRows.forEach((row) => {
    eventCountsByPerson.set(row.personId, {
      attended: Number(row.attended) || 0,
      registered: Number(row.registered) || 0,
      history: Number(row.history) || 0,
    });
  });

  const peopleById = new Map();
  const guests = rows.map((row) => {
    const person = indexedPersonToApiPerson(row.person, row);
    if (!peopleById.has(person.id)) peopleById.set(person.id, person);
    const eventCounts = includeEventCounts ? eventCountsByPerson.get(row.personId) : null;
    const isFirstRegistration = Boolean(eventCounts) && eventCounts.history === 0 && GUEST_REGISTRATION_STATUSES.includes(row.status || "");
    return {
      ...indexedGuestToApiGuest(row, eventCounts),
      ...(eventCounts ? {
        isFirstRegistration,
        isNewFace: isFirstRegistration && row.status === "checked_in",
      } : {}),
    };
  });

  const nextCursor = query.cursor + rows.length;
  diagnosticReporter?.("map_response", Date.now() - diagnosticStartedAt, { guestCount: guests.length, peopleCount: peopleById.size });

  return {
    source: "luma-index",
    eventId,
    guests,
    people: [...peopleById.values()],
    loadedAt: new Date().toISOString(),
    indexed: true,
    indexHasGuests: includeSummary ? Boolean(stats?.total) : true,
    ...(stats ? { stats, analyticsQuestions } : {}),
    pageInfo: {
      total: filteredCount,
      pageSize: query.pageSize,
      hasMore: nextCursor < filteredCount,
      nextCursor: nextCursor < filteredCount ? String(nextCursor) : null,
    },
    query: { filter: query.filter, search: query.search, tags: query.tags },
  };
}

function indexedGuestPageWhereSql(
  eventId: string,
  query: GuestListQuery,
  eventBoundary: { startsAt?: Date | null; date?: Date | null } | null,
) {
  const predicates: Prisma.Sql[] = [Prisma.sql`guest.event_id = ${eventId}`];

  if (query.filter === "accepted") {
    predicates.push(Prisma.sql`guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)})`);
  } else if (query.filter === "to_decide") {
    predicates.push(Prisma.sql`(
      guest.status = 'registered'
      OR (guest.status = 'waitlisted' AND guest.operator_decision IS DISTINCT FROM 'waitlisted')
    )`);
  } else if (query.filter === "registered") {
    predicates.push(Prisma.sql`guest.status IN (${Prisma.join(GUEST_REGISTERED_STATUSES)})`);
  } else if (query.filter === "first_registers" || query.filter === "new_faces") {
    predicates.push(query.filter === "new_faces"
      ? Prisma.sql`guest.status = 'checked_in'`
      : Prisma.sql`guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)})`);
    predicates.push(Prisma.sql`
      NOT EXISTS (
        SELECT 1
        FROM luma_event_guests AS previous_guest
        LEFT JOIN luma_events AS previous_event
          ON previous_event.event_id = previous_guest.event_id
        WHERE previous_guest.person_id = guest.person_id
          AND previous_guest.event_id <> ${eventId}
          ${previousEventBoundarySql(eventBoundary)}
      )
    `);
  } else if (query.filter !== "all") {
    predicates.push(Prisma.sql`guest.status = ${query.filter}`);
  }

  if (query.search) {
    const searchPattern = `%${query.search}%`;
    predicates.push(Prisma.sql`
      (
        guest.search_text ILIKE ${searchPattern}
        OR guest.profile_description ILIKE ${searchPattern}
        OR guest.email ILIKE ${searchPattern}
        OR EXISTS (
          SELECT 1
          FROM luma_people AS search_person
          WHERE search_person.person_id = guest.person_id
            AND (
              search_person.name ILIKE ${searchPattern}
              OR search_person.email ILIKE ${searchPattern}
              OR search_person.title ILIKE ${searchPattern}
              OR search_person.bio ILIKE ${searchPattern}
              OR search_person.crm_notes ILIKE ${searchPattern}
            )
        )
      )
    `);
  }

  if (query.tags.length) {
    const tagPredicates = query.tags.map((tag) => Prisma.sql`
      tag_person.tags @> CAST(${JSON.stringify([tag])} AS jsonb)
    `);
    predicates.push(Prisma.sql`
      EXISTS (
        SELECT 1
        FROM luma_people AS tag_person
        WHERE tag_person.person_id = guest.person_id
          AND (${Prisma.join(tagPredicates, " OR ")})
      )
    `);
  }

  return Prisma.sql`WHERE ${Prisma.join(predicates, " AND ")}`;
}

function indexedGuestPageRowToRecord(row: IndexedGuestPageRow) {
  return {
    eventId: row.eventId,
    personId: row.personId,
    lumaGuestId: row.lumaGuestId,
    email: row.email,
    status: row.status,
    lumaApprovalStatus: row.lumaApprovalStatus,
    operatorDecision: row.operatorDecision,
    registeredAt: row.registeredAt,
    invitedAt: row.invitedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    approvedAt: row.approvedAt,
    checkedInAt: row.checkedInAt,
    profileDescription: row.profileDescription,
    registrationAnswers: row.registrationAnswers,
    socialLinks: row.socialLinks,
    referrer: row.referrer,
    searchText: row.searchText,
    lastSeenAt: row.lastSeenAt,
    person: {
      personId: row.personId,
      lumaUserId: row.personLumaUserId,
      email: row.personEmail,
      name: row.personName,
      title: row.personTitle,
      bio: row.personBio,
      avatarUrl: row.personAvatarUrl,
      profileUrl: row.personProfileUrl,
      socialLinks: row.personSocialLinks,
      referrer: row.personReferrer,
      groups: row.personGroups,
      tags: row.personTags,
      manualTags: row.personManualTags,
      automaticTags: row.personAutomaticTags,
      crmNotes: row.personCrmNotes,
      crmNotesUpdatedAt: row.personCrmNotesUpdatedAt,
    },
  };
}

export async function getIndexedLifetimeEventCounts(
  eventId: string,
  personIds: string[],
  diagnosticReporter?: EventSwitchDiagnosticReporter,
) {
  const boundedPersonIds = [...new Set(personIds.filter(Boolean))].slice(0, 100);
  if (!boundedPersonIds.length) return { source: "luma-index", eventId, counts: [] };
  const diagnosticStartedAt = Date.now();
  const rows = await prisma().$queryRaw<Array<{ personId: string; attended: number; registered: number }>>(Prisma.sql`
    SELECT
      guest.person_id AS "personId",
      COUNT(*) FILTER (
        WHERE guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in'
      )::integer AS attended,
      COUNT(*) FILTER (
        WHERE guest.status IN ('registered', 'going', 'waitlisted', 'checked_in', 'no_show')
      )::integer AS registered
    FROM luma_event_guests AS guest
    WHERE guest.person_id IN (${Prisma.join(boundedPersonIds)})
    GROUP BY guest.person_id
  `);
  diagnosticReporter?.("lifetime_event_counts", Date.now() - diagnosticStartedAt, {
    personCount: boundedPersonIds.length,
    resultCount: rows.length,
  });
  const countsByPerson = new Map<string, { personId: string; attended: number; registered: number }>(
    rows.map((row) => [row.personId, row]),
  );
  return {
    source: "luma-index",
    eventId,
    counts: boundedPersonIds.map((personId) => {
      const row = countsByPerson.get(personId);
      return {
        personId,
        attended: Number(row?.attended) || 0,
        registered: Number(row?.registered) || 0,
      };
    }),
  };
}

export async function getIndexedEventAnalytics(
  eventId: string,
  diagnosticReporter?: EventSwitchDiagnosticReporter,
  knownEventBoundary?: { startsAt: Date | null; date: Date | null } | null,
) {
  const db = prisma();
  // EVENT_SWITCH_DIAGNOSTICS: analytics is timed independently from guest-page loading.
  let diagnosticStartedAt = Date.now();
  const eventBoundary = knownEventBoundary || await db.lumaEvent.findUnique({
    where: { eventId },
    select: { startsAt: true, date: true },
  });
  diagnosticReporter?.(knownEventBoundary ? "event_boundary_provided" : "event_boundary", Date.now() - diagnosticStartedAt, {
    found: Boolean(eventBoundary),
  });
  if (!eventBoundary) return null;
  const firstRegisterWhere = guestStatusWhere(eventId, "first_registers", eventBoundary);
  const analytics = await indexedEventAnalytics(db, eventId, eventBoundary, firstRegisterWhere, diagnosticReporter);
  return {
    source: "luma-index",
    eventId,
    indexed: true,
    loadedAt: new Date().toISOString(),
    ...analytics,
  };
}

async function indexedEventAnalytics(
  db: PrismaClient,
  eventId: string,
  eventBoundary: { startsAt: Date | null; date: Date | null },
  firstRegisterWhere: Record<string, any> | null,
  diagnosticReporter?: EventSwitchDiagnosticReporter,
) {
  const priorRegistrationBoundary = previousEventBoundarySql(eventBoundary);
  const referredTagJson = JSON.stringify([REFERRED_PERSON_TAG]);
  const diagnosticStartedAt = Date.now();
  const [summaryRows, analyticsQuestionRows] = await db.$transaction([
    db.$queryRaw<Array<{ total: number; checkedIn: number; accepted: number; registered: number; invited: number; waitlisted: number; toDecide: number; firstRegisters: number; newFaces: number; referredRegistrations: number; referredAccepted: number; referredCheckedIn: number; referredFirstRegisters: number; referredReturning: number }>>(Prisma.sql`
      WITH guest_cohort AS MATERIALIZED (
        SELECT
          guest.*,
          COALESCE(person.tags @> ${referredTagJson}::jsonb, FALSE) AS is_referred,
          EXISTS (
            SELECT 1
            FROM luma_event_guests AS previous_guest
            LEFT JOIN luma_events AS previous_event ON previous_event.event_id = previous_guest.event_id
            WHERE previous_guest.person_id = guest.person_id
              AND previous_guest.event_id <> ${eventId}
              ${priorRegistrationBoundary}
          ) AS has_prior_event
        FROM luma_event_guests AS guest
        JOIN luma_people AS person ON person.person_id = guest.person_id
        WHERE guest.event_id = ${eventId}
      )
      SELECT
        COUNT(*)::integer AS total,
        COUNT(*) FILTER (WHERE guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')::integer AS "checkedIn",
        COUNT(*) FILTER (WHERE guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)}))::integer AS accepted,
        COUNT(*) FILTER (WHERE guest.status IN (${Prisma.join(GUEST_REGISTERED_STATUSES)}))::integer AS registered,
        COUNT(*) FILTER (WHERE guest.status = 'invited')::integer AS invited,
        COUNT(*) FILTER (WHERE guest.status = 'waitlisted')::integer AS waitlisted,
        COUNT(*) FILTER (
          WHERE guest.status = 'registered'
            OR (guest.status = 'waitlisted' AND guest.operator_decision IS DISTINCT FROM 'waitlisted')
        )::integer AS "toDecide",
        COUNT(*) FILTER (
          WHERE guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)})
            AND NOT guest.has_prior_event
        )::integer AS "firstRegisters",
        COUNT(*) FILTER (
          WHERE guest.status = 'checked_in'
            AND NOT guest.has_prior_event
        )::integer AS "newFaces",
        COUNT(*) FILTER (
          WHERE guest.is_referred
            AND guest.status IN (${Prisma.join(GUEST_REGISTERED_STATUSES)})
        )::integer AS "referredRegistrations",
        COUNT(*) FILTER (
          WHERE guest.is_referred
            AND guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)})
        )::integer AS "referredAccepted",
        COUNT(*) FILTER (
          WHERE guest.is_referred
            AND (guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')
        )::integer AS "referredCheckedIn",
        COUNT(*) FILTER (
          WHERE guest.is_referred
            AND guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)})
            AND NOT guest.has_prior_event
        )::integer AS "referredFirstRegisters",
        COUNT(*) FILTER (
          WHERE guest.is_referred
            AND guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)})
            AND guest.has_prior_event
        )::integer AS "referredReturning"
      FROM guest_cohort AS guest
    `),
    db.lumaEventGuest.findMany({
      where: {
        eventId,
        ...(firstRegisterWhere ? { AND: [firstRegisterWhere] } : {}),
      },
      select: { personId: true, registrationAnswers: true },
      take: safeInt("LUMA_ANALYTICS_MAX_NEW_FACES", 1000, 1, 5000),
      orderBy: [{ registeredAt: "desc" }, { createdAt: "desc" }, { lastSeenAt: "desc" }],
    }),
  ]);
  diagnosticReporter?.("analytics_queries", Date.now() - diagnosticStartedAt, {
    answerRowCount: analyticsQuestionRows.length,
  });
  return {
    stats: summaryRows[0] || { total: 0, checkedIn: 0, accepted: 0, registered: 0, invited: 0, waitlisted: 0, toDecide: 0, firstRegisters: 0, newFaces: 0, referredRegistrations: 0, referredAccepted: 0, referredCheckedIn: 0, referredFirstRegisters: 0, referredReturning: 0 },
    analyticsQuestions: buildRegistrationQuestionAnalytics(analyticsQuestionRows),
  };
}

async function indexedEventCountsForPeople(
  db: PrismaClient,
  eventId: string,
  personIds: string[],
  boundary: { startsAt?: Date | null; date?: Date | null } | null,
) {
  const historyBoundary = boundary?.startsAt
    ? Prisma.sql`AND (
        history_event.starts_at < ${boundary.startsAt}
        ${boundary.date ? Prisma.sql`OR (history_event.starts_at IS NULL AND history_event.date < ${boundary.date})` : Prisma.empty}
      )`
    : boundary?.date
      ? Prisma.sql`AND history_event.date < ${boundary.date}`
      : Prisma.empty;

  return db.$queryRaw<Array<{ personId: string; attended: number; registered: number; history: number }>>(Prisma.sql`
    SELECT
      guest.person_id AS "personId",
      COUNT(*) FILTER (
        WHERE guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in'
      )::integer AS attended,
      COUNT(*) FILTER (
        WHERE guest.status IN ('registered', 'going', 'waitlisted', 'checked_in', 'no_show')
      )::integer AS registered,
      COUNT(*) FILTER (
        WHERE guest.event_id <> ${eventId}
        ${historyBoundary}
      )::integer AS history
    FROM luma_event_guests AS guest
    LEFT JOIN luma_events AS history_event ON history_event.event_id = guest.event_id
    WHERE guest.person_id IN (${Prisma.join(personIds)})
    GROUP BY guest.person_id
  `);
}

function previousEventBoundarySql(boundary: { startsAt?: Date | null; date?: Date | null } | null) {
  if (boundary?.startsAt) {
    return Prisma.sql`AND (
      previous_event.starts_at < ${boundary.startsAt}
      ${boundary.date ? Prisma.sql`OR (previous_event.starts_at IS NULL AND previous_event.date < ${boundary.date})` : Prisma.empty}
    )`;
  }
  return boundary?.date
    ? Prisma.sql`AND previous_event.date < ${boundary.date}`
    : Prisma.empty;
}

export async function listIndexedPersonTags() {
  return (await listIndexedTagDefinitions()).map((tag) => tag.name);
}

export async function listIndexedTagDefinitions() {
  return prisma().$queryRaw<Array<{ id: string; name: string; color: string; managed: boolean; ruleKey: string | null }>>(Prisma.sql`
    WITH person_tags AS (
      SELECT MIN(tag_value) AS name
      FROM luma_people
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(tags) = 'array' THEN tags ELSE '[]'::jsonb END
      ) AS tag_values(tag_value)
      WHERE LENGTH(TRIM(tag_value)) > 0
      GROUP BY LOWER(tag_value)
    )
    SELECT tag.id, tag.name, tag.color, tag.managed, tag.rule_key AS "ruleKey"
    FROM guest_tags AS tag
    UNION ALL
    SELECT MD5(LOWER(person_tag.name)) AS id, person_tag.name, ${DEFAULT_TAG_COLOR} AS color, FALSE AS managed, NULL::text AS "ruleKey"
    FROM person_tags AS person_tag
    WHERE NOT EXISTS (
      SELECT 1 FROM guest_tags AS tag WHERE LOWER(tag.name) = LOWER(person_tag.name)
    )
    ORDER BY name
    LIMIT 500
  `);
}

export async function createIndexedTagDefinition(value: { name?: unknown; color?: unknown }) {
  const id = randomUUID();
  const name = normalizeTagName(value.name);
  const color = normalizeTagColor(value.color);
  const rows = await prisma().$queryRaw<Array<{ id: string; name: string; color: string; managed: boolean; ruleKey: string | null }>>(Prisma.sql`
    INSERT INTO guest_tags (id, name, color, updated_at)
    VALUES (${id}, ${name}, ${color}, NOW())
    ON CONFLICT DO NOTHING
    RETURNING id, name, color, managed, rule_key AS "ruleKey"
  `);
  if (rows[0]) return rows[0];
  const existing = await prisma().$queryRaw<Array<{ id: string; name: string; color: string; managed: boolean; ruleKey: string | null }>>(Prisma.sql`
    SELECT id, name, color, managed, rule_key AS "ruleKey" FROM guest_tags WHERE LOWER(name) = LOWER(${name}) LIMIT 1
  `);
  if (existing[0]) return existing[0];
  throw new Error("Unable to create tag.");
}

export async function updateIndexedTagDefinition(idValue: unknown, value: { name?: unknown; color?: unknown }) {
  const id = typeof idValue === "string" ? idValue.trim() : "";
  if (!id) {
    const error = new Error("A tag id is required.") as HttpError;
    error.status = 400;
    throw error;
  }
  const name = normalizeTagName(value.name);
  const color = normalizeTagColor(value.color);
  return prisma().$transaction(async (db: Prisma.TransactionClient) => {
    const current = await db.$queryRaw<Array<{ id: string; name: string; color: string; managed: boolean; ruleKey: string | null }>>(Prisma.sql`
      SELECT id, name, color, managed, rule_key AS "ruleKey" FROM guest_tags WHERE id = ${id} LIMIT 1
    `);
    if (!current[0]) {
      const error = new Error("Tag not found.") as HttpError;
      error.status = 404;
      throw error;
    }
    if (current[0].managed) {
      const error = new Error("Automatic tag definitions are managed by their classifier rule.") as HttpError;
      error.status = 409;
      throw error;
    }
    const collision = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM guest_tags WHERE id <> ${id} AND LOWER(name) = LOWER(${name}) LIMIT 1
    `);
    if (collision[0]) {
      const error = new Error("A tag with that name already exists.") as HttpError;
      error.status = 409;
      throw error;
    }
    const oldName = current[0].name;
    if (oldName.toLocaleLowerCase() !== name.toLocaleLowerCase() || oldName !== name) {
      await db.$executeRaw(Prisma.sql`
        UPDATE luma_people AS person
        SET
          tags = guestbook_replace_tag_name(person.tags, ${oldName}, ${name}),
          manual_tags = guestbook_replace_tag_name(person.manual_tags, ${oldName}, ${name}),
          automatic_tags = guestbook_replace_tag_name(person.automatic_tags, ${oldName}, ${name})
        WHERE EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(person.tags) AS item(value)
          WHERE LOWER(item.value) = LOWER(${oldName})
        )
      `);
    }
    const updated = await db.$queryRaw<Array<{ id: string; name: string; color: string; managed: boolean; ruleKey: string | null }>>(Prisma.sql`
      UPDATE guest_tags
      SET name = ${name}, color = ${color}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING id, name, color, managed, rule_key AS "ruleKey"
    `);
    return { ...updated[0], previousName: oldName };
  });
}

export async function setIndexedPersonTags(personId: string, value: unknown) {
  const tags = normalizePersonTags(value);
  return prisma().$transaction(async (db: Prisma.TransactionClient) => {
    for (const tag of tags) {
      await db.$executeRaw(Prisma.sql`
        INSERT INTO guest_tags (id, name, color, updated_at)
        VALUES (${randomUUID()}, ${tag}, ${DEFAULT_TAG_COLOR}, NOW())
        ON CONFLICT DO NOTHING
      `);
    }
    const automaticRows = await db.$queryRaw<Array<{ name: string }>>(Prisma.sql`
      SELECT definition.name
      FROM automatic_tag_assignments AS assignment
      JOIN guest_tags AS definition ON definition.id = assignment.tag_id
      WHERE assignment.person_id = ${personId}
    `);
    const automaticNames = automaticRows.map((row) => row.name);
    const automaticSet = new Set(automaticNames.map((tag) => tag.toLocaleLowerCase()));
    const manualTags = tags.filter((tag) => !automaticSet.has(tag.toLocaleLowerCase()));
    const materializedTags = normalizePersonTags([...manualTags, ...automaticNames]);
    return db.lumaPerson.update({
      where: { personId },
      data: {
        manualTags: sanitizeJson(manualTags),
        automaticTags: sanitizeJson(automaticNames),
        tags: sanitizeJson(materializedTags),
      },
      select: { personId: true, tags: true, manualTags: true, automaticTags: true },
    });
  });
}

export async function updateIndexedPersonCrmNotes(personId: string, notes: string) {
  return prisma().lumaPerson.update({
    where: { personId },
    data: {
      crmNotes: notes,
      crmNotesUpdatedAt: new Date(),
    },
    select: {
      personId: true,
      crmNotes: true,
      crmNotesUpdatedAt: true,
    },
  });
}

type AutomaticTagClassifierOptions = {
  personIds?: unknown;
  forceFull?: boolean;
  dryRun?: boolean;
};

type AutomaticTagContext = {
  fingerprint: string;
  publicEventCount: number;
};

type AutomaticTagSummaryRow = {
  evaluatedCount: number;
  matchedCount: number;
  addedCount: number;
  removedCount: number;
  writtenCount?: number;
  matchesByRule?: Prisma.JsonValue;
  affectedPersonIds?: Prisma.JsonValue;
};

export async function runAutomaticTagClassifier({ personIds, forceFull = false, dryRun = false }: AutomaticTagClassifierOptions = {}) {
  if (!hasLumaDb()) {
    const error = new Error("Automatic tags require DB_URL to be configured.") as HttpError;
    error.status = 503;
    throw error;
  }

  const requestedPersonIds = normalizeAutomaticTagPersonIds(personIds);
  const startedAt = Date.now();
  const settleMinutes = safeInt("AUTOMATIC_TAG_EVENT_SETTLE_MINUTES", 360, 0, 60 * 24 * 7);
  const timeout = safeInt("AUTOMATIC_TAG_TRANSACTION_TIMEOUT_MS", 120000, 5000, 300000);

  return prisma().$transaction(async (db: Prisma.TransactionClient) => {
    const lockRows = await db.$queryRaw<Array<{ acquired: boolean }>>(Prisma.sql`
      SELECT pg_try_advisory_xact_lock(hashtext('guestbook:auto-tags')) AS acquired
    `);
    if (!lockRows[0]?.acquired) {
      return {
        ok: true,
        status: "already_running",
        mode: "noop",
        dryRun,
        evaluatedCount: 0,
        matchedCount: 0,
        addedCount: 0,
        removedCount: 0,
        changedCount: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    await ensureAutomaticTagDefinitions(db);
    const context = await automaticTagContext(db, settleMinutes);
    const stateRows = await db.$queryRaw<Array<{ publicEventFingerprint: string }>>(Prisma.sql`
      SELECT public_event_fingerprint AS "publicEventFingerprint"
      FROM automatic_tag_state
      WHERE id = 'default'
      LIMIT 1
    `);
    const mode = automaticTagRunMode({
      forceFull,
      hasPreviousRun: Boolean(stateRows[0]),
      previousFingerprint: stateRows[0]?.publicEventFingerprint || "",
      currentFingerprint: context.fingerprint,
      personIds: requestedPersonIds,
    });

    if (mode === "noop") {
      return {
        ok: true,
        status: "success",
        mode,
        dryRun,
        publicEventFingerprint: context.fingerprint,
        publicEventCount: context.publicEventCount,
        evaluatedCount: 0,
        matchedCount: 0,
        addedCount: 0,
        removedCount: 0,
        changedCount: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    const full = mode === "full";
    const scopeSql = automaticTagTargetPeopleSql(full, requestedPersonIds);
    const desiredCtes = automaticTagDesiredCtes(scopeSql, settleMinutes);
    const summaryRows = dryRun
      ? await automaticTagDryRun(db, desiredCtes)
      : await applyAutomaticTagAssignments(db, desiredCtes);
    const summary = summaryRows[0] || {
      evaluatedCount: 0,
      matchedCount: 0,
      addedCount: 0,
      removedCount: 0,
    };

    if (!dryRun) {
      const affectedPersonIds = normalizeAutomaticTagPersonIds(summary.affectedPersonIds);
      if (affectedPersonIds.length) {
        await rebuildMaterializedPersonTags(db, automaticTagTargetPeopleSql(false, affectedPersonIds));
      }
      const durationMs = Date.now() - startedAt;
      await db.$executeRaw(Prisma.sql`
        INSERT INTO automatic_tag_state (
          id, public_event_fingerprint, last_mode, last_evaluated_count,
          last_changed_count, last_duration_ms, last_run_at
        )
        VALUES (
          'default', ${context.fingerprint}, ${mode}, ${Number(summary.evaluatedCount) || 0},
          ${(Number(summary.addedCount) || 0) + (Number(summary.removedCount) || 0)}, ${durationMs}, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          public_event_fingerprint = EXCLUDED.public_event_fingerprint,
          last_mode = EXCLUDED.last_mode,
          last_evaluated_count = EXCLUDED.last_evaluated_count,
          last_changed_count = EXCLUDED.last_changed_count,
          last_duration_ms = EXCLUDED.last_duration_ms,
          last_run_at = EXCLUDED.last_run_at
      `);
    }

    return {
      ok: true,
      status: "success",
      mode,
      dryRun,
      publicEventFingerprint: context.fingerprint,
      publicEventCount: context.publicEventCount,
      evaluatedCount: Number(summary.evaluatedCount) || 0,
      matchedCount: Number(summary.matchedCount) || 0,
      matchesByRule: summary.matchesByRule || {},
      addedCount: Number(summary.addedCount) || 0,
      removedCount: Number(summary.removedCount) || 0,
      changedCount: (Number(summary.addedCount) || 0) + (Number(summary.removedCount) || 0),
      durationMs: Date.now() - startedAt,
    };
  }, { timeout });
}

export async function getAutomaticTagStatus() {
  const rows = await prisma().$queryRaw<Array<{
    publicEventFingerprint: string;
    lastMode: string | null;
    lastEvaluatedCount: number;
    lastChangedCount: number;
    lastDurationMs: number;
    lastRunAt: Date;
    assignmentCount: number;
  }>>(Prisma.sql`
    SELECT
      state.public_event_fingerprint AS "publicEventFingerprint",
      state.last_mode AS "lastMode",
      state.last_evaluated_count AS "lastEvaluatedCount",
      state.last_changed_count AS "lastChangedCount",
      state.last_duration_ms AS "lastDurationMs",
      state.last_run_at AS "lastRunAt",
      (SELECT COUNT(*)::integer FROM automatic_tag_assignments) AS "assignmentCount"
    FROM automatic_tag_state AS state
    WHERE state.id = 'default'
    LIMIT 1
  `);
  return rows[0] || null;
}

async function ensureAutomaticTagDefinitions(db: Prisma.TransactionClient) {
  for (const definition of AUTOMATIC_TAG_DEFINITIONS) {
    const currentRows = await db.$queryRaw<Array<{ name: string }>>(Prisma.sql`
      SELECT name FROM guest_tags WHERE rule_key = ${definition.ruleKey} LIMIT 1
    `);
    const currentName = currentRows[0]?.name;
    if (!currentName || currentName === definition.name) continue;
    await db.$executeRaw(Prisma.sql`
      UPDATE luma_people AS person
      SET
        tags = guestbook_replace_tag_name(person.tags, ${currentName}, ${definition.name}),
        manual_tags = guestbook_replace_tag_name(person.manual_tags, ${currentName}, ${definition.name}),
        automatic_tags = guestbook_replace_tag_name(person.automatic_tags, ${currentName}, ${definition.name})
      WHERE EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(person.tags) AS item(value)
        WHERE LOWER(item.value) = LOWER(${currentName})
      )
    `);
    await db.$executeRaw(Prisma.sql`
      UPDATE guest_tags
      SET name = ${definition.name}, color = ${definition.color}, updated_at = NOW()
      WHERE rule_key = ${definition.ruleKey}
    `);
  }
  const values = automaticTagDefinitionValuesSql();
  await db.$executeRaw(Prisma.sql`
    WITH definitions(rule_key, name, color) AS (VALUES ${values})
    UPDATE guest_tags AS tag
    SET
      managed = TRUE,
      rule_key = definition.rule_key,
      color = definition.color,
      updated_at = NOW()
    FROM definitions AS definition
    WHERE LOWER(tag.name) = LOWER(definition.name)
      AND tag.rule_key IS NULL
  `);
  await db.$executeRaw(Prisma.sql`
    WITH definitions(rule_key, name, color) AS (VALUES ${values})
    INSERT INTO guest_tags (id, name, color, managed, rule_key, updated_at)
    SELECT
      'auto-' || definition.rule_key,
      definition.name,
      definition.color,
      TRUE,
      definition.rule_key,
      NOW()
    FROM definitions AS definition
    WHERE NOT EXISTS (
      SELECT 1
      FROM guest_tags AS tag
      WHERE tag.rule_key = definition.rule_key
         OR LOWER(tag.name) = LOWER(definition.name)
    )
    ON CONFLICT DO NOTHING
  `);
}

function automaticTagDefinitionValuesSql() {
  return Prisma.join(AUTOMATIC_TAG_DEFINITIONS.map((definition) => Prisma.sql`(
    ${definition.ruleKey}, ${definition.name}, ${definition.color}
  )`));
}

async function automaticTagContext(db: Prisma.TransactionClient, settleMinutes: number) {
  const rows = await db.$queryRaw<AutomaticTagContext[]>(Prisma.sql`
    WITH latest_public_events AS (
      SELECT event.event_id, event.starts_at
      FROM luma_events AS event
      JOIN luma_event_sync_state AS sync_state ON sync_state.event_id = event.event_id
      WHERE event.visibility = 'public'
        AND event.starts_at IS NOT NULL
        AND COALESCE(event.ends_at, event.starts_at + (${settleMinutes} * INTERVAL '1 minute')) < NOW()
        AND sync_state.last_status = 'success'
        AND sync_state.truncated = FALSE
        AND LOWER(COALESCE(event.raw->>'status', '')) NOT IN ('cancelled', 'canceled')
      ORDER BY event.starts_at DESC, event.event_id DESC
      LIMIT 5
    )
    SELECT
      COALESCE(STRING_AGG(event_id, ',' ORDER BY starts_at DESC, event_id DESC), '') AS fingerprint,
      COUNT(*)::integer AS "publicEventCount"
    FROM latest_public_events
  `);
  return rows[0] || { fingerprint: "", publicEventCount: 0 };
}

function automaticTagTargetPeopleSql(full: boolean, personIds: string[]) {
  if (full) return Prisma.sql`SELECT person_id FROM luma_people`;
  const serialized = JSON.stringify(personIds);
  return Prisma.sql`
    SELECT value AS person_id
    FROM jsonb_array_elements_text(${serialized}::jsonb) AS ids(value)
  `;
}

function automaticTagDesiredCtes(targetPeopleSql: Prisma.Sql, settleMinutes: number) {
  return Prisma.sql`
    target_people AS MATERIALIZED (
      ${targetPeopleSql}
    ),
    eligible_events AS MATERIALIZED (
      SELECT event.event_id, event.title, event.starts_at, event.visibility
      FROM luma_events AS event
      JOIN luma_event_sync_state AS sync_state ON sync_state.event_id = event.event_id
      WHERE event.starts_at IS NOT NULL
        AND COALESCE(event.ends_at, event.starts_at + (${settleMinutes} * INTERVAL '1 minute')) < NOW()
        AND sync_state.last_status = 'success'
        AND sync_state.truncated = FALSE
        AND LOWER(COALESCE(event.raw->>'status', '')) NOT IN ('cancelled', 'canceled')
    ),
    ranked_public_events AS MATERIALIZED (
      SELECT
        event.event_id,
        event.title,
        event.starts_at,
        ROW_NUMBER() OVER (ORDER BY event.starts_at DESC, event.event_id DESC)::integer AS event_rank
      FROM eligible_events AS event
      WHERE event.visibility = 'public'
    ),
    latest_public_events AS MATERIALIZED (
      SELECT * FROM ranked_public_events WHERE event_rank <= 5
    ),
    public_window AS (
      SELECT
        COUNT(*) FILTER (WHERE event_rank <= 3)::integer AS event_count_3,
        COUNT(*) FILTER (WHERE event_rank <= 5)::integer AS event_count_5,
        COALESCE(JSONB_AGG(event_id ORDER BY starts_at DESC, event_id DESC) FILTER (WHERE event_rank <= 3), '[]'::jsonb) AS event_ids_3,
        COALESCE(JSONB_AGG(event_id ORDER BY starts_at DESC, event_id DESC) FILTER (WHERE event_rank <= 5), '[]'::jsonb) AS event_ids_5
      FROM latest_public_events
    ),
    public_checkins AS (
      SELECT
        guest.person_id,
        COUNT(DISTINCT guest.event_id) FILTER (WHERE event.event_rank <= 3)::integer AS checked_in_3,
        COUNT(DISTINCT guest.event_id) FILTER (WHERE event.event_rank <= 5)::integer AS checked_in_5
      FROM latest_public_events AS event
      JOIN luma_event_guests AS guest ON guest.event_id = event.event_id
      JOIN target_people AS target ON target.person_id = guest.person_id
      WHERE guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in'
      GROUP BY guest.person_id
    ),
    power_matches AS (
      SELECT
        checkin.person_id,
        'superpower_user'::text AS rule_key,
        JSONB_BUILD_OBJECT('eventIds', window_stats.event_ids_5, 'requiredCheckIns', 5) AS evidence
      FROM public_checkins AS checkin
      CROSS JOIN public_window AS window_stats
      WHERE window_stats.event_count_5 = 5 AND checkin.checked_in_5 = 5
      UNION ALL
      SELECT
        checkin.person_id,
        'power_user'::text AS rule_key,
        JSONB_BUILD_OBJECT('eventIds', window_stats.event_ids_3, 'requiredCheckIns', 3) AS evidence
      FROM public_checkins AS checkin
      CROSS JOIN public_window AS window_stats
      WHERE window_stats.event_count_3 = 3
        AND checkin.checked_in_3 = 3
        AND NOT (window_stats.event_count_5 = 5 AND checkin.checked_in_5 = 5)
    ),
    ranked_registrations AS MATERIALIZED (
      SELECT
        guest.person_id,
        event.event_id,
        event.title,
        event.starts_at,
        (guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in') AS checked_in,
        (
          guest.checked_in_at IS NULL
          AND guest.status <> 'checked_in'
          AND (guest.status = 'no_show' OR guest.luma_approval_status = 'approved')
        ) AS no_show,
        ROW_NUMBER() OVER (
          PARTITION BY guest.person_id
          ORDER BY event.starts_at DESC, event.event_id DESC
        )::integer AS registration_rank
      FROM luma_event_guests AS guest
      JOIN eligible_events AS event ON event.event_id = guest.event_id
      JOIN target_people AS target ON target.person_id = guest.person_id
      WHERE guest.registered_at IS NOT NULL
        AND (
          guest.luma_approval_status = 'approved'
          OR guest.status IN ('going', 'checked_in', 'no_show')
        )
    ),
    registration_streaks AS (
      SELECT
        person_id,
        COUNT(*) FILTER (WHERE registration_rank <= 3)::integer AS registration_count_3,
        COUNT(*) FILTER (WHERE registration_rank <= 6)::integer AS registration_count_6,
        BOOL_AND(no_show) FILTER (WHERE registration_rank <= 3) AS all_no_show_3,
        BOOL_AND(no_show) FILTER (WHERE registration_rank <= 6) AS all_no_show_6,
        COALESCE(JSONB_AGG(event_id ORDER BY starts_at DESC, event_id DESC) FILTER (WHERE registration_rank <= 3), '[]'::jsonb) AS event_ids_3,
        COALESCE(JSONB_AGG(event_id ORDER BY starts_at DESC, event_id DESC) FILTER (WHERE registration_rank <= 6), '[]'::jsonb) AS event_ids_6
      FROM ranked_registrations
      WHERE registration_rank <= 6
      GROUP BY person_id
    ),
    flaker_matches AS (
      SELECT
        streak.person_id,
        'superflaker'::text AS rule_key,
        JSONB_BUILD_OBJECT('eventIds', streak.event_ids_6, 'consecutiveNoShows', 6) AS evidence
      FROM registration_streaks AS streak
      WHERE streak.registration_count_6 = 6 AND streak.all_no_show_6 = TRUE
      UNION ALL
      SELECT
        streak.person_id,
        'flaker'::text AS rule_key,
        JSONB_BUILD_OBJECT('eventIds', streak.event_ids_3, 'consecutiveNoShows', 3) AS evidence
      FROM registration_streaks AS streak
      WHERE streak.registration_count_3 = 3
        AND streak.all_no_show_3 = TRUE
        AND NOT (streak.registration_count_6 = 6 AND streak.all_no_show_6 = TRUE)
    ),
    latest_checkins AS (
      SELECT DISTINCT ON (guest.person_id)
        guest.person_id,
        event.event_id,
        event.title,
        COALESCE(event.starts_at, event.date, guest.checked_in_at, guest.last_seen_at) AS occurred_at
      FROM luma_event_guests AS guest
      JOIN luma_events AS event ON event.event_id = guest.event_id
      JOIN target_people AS target ON target.person_id = guest.person_id
      WHERE guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in'
      ORDER BY
        guest.person_id,
        COALESCE(event.starts_at, event.date, guest.checked_in_at, guest.last_seen_at) DESC,
        event.event_id DESC
    ),
    festival_matches AS (
      SELECT
        person_id,
        'festival_dweller'::text AS rule_key,
        JSONB_BUILD_OBJECT('eventId', event_id, 'eventTitle', title) AS evidence
      FROM latest_checkins
      WHERE title ILIKE '%festival%'
    ),
    rule_matches AS MATERIALIZED (
      SELECT * FROM power_matches
      UNION ALL
      SELECT * FROM flaker_matches
      UNION ALL
      SELECT * FROM festival_matches
    ),
    desired AS MATERIALIZED (
      SELECT
        match.person_id,
        definition.id AS tag_id,
        match.rule_key,
        match.evidence
      FROM rule_matches AS match
      JOIN guest_tags AS definition ON definition.rule_key = match.rule_key
    )
  `;
}

async function automaticTagDryRun(db: Prisma.TransactionClient, desiredCtes: Prisma.Sql) {
  return db.$queryRaw<AutomaticTagSummaryRow[]>(Prisma.sql`
    WITH ${desiredCtes},
    existing AS MATERIALIZED (
      SELECT assignment.person_id, assignment.rule_key
      FROM automatic_tag_assignments AS assignment
      JOIN target_people AS target ON target.person_id = assignment.person_id
    )
    SELECT
      (SELECT COUNT(*)::integer FROM target_people) AS "evaluatedCount",
      (SELECT COUNT(*)::integer FROM desired) AS "matchedCount",
      (SELECT COALESCE(JSONB_OBJECT_AGG(rule_counts.rule_key, rule_counts.match_count), '{}'::jsonb)
        FROM (
          SELECT rule_key, COUNT(*)::integer AS match_count
          FROM desired
          GROUP BY rule_key
        ) AS rule_counts) AS "matchesByRule",
      (SELECT COUNT(*)::integer FROM desired
        LEFT JOIN existing USING (person_id, rule_key)
        WHERE existing.person_id IS NULL) AS "addedCount",
      (SELECT COUNT(*)::integer FROM existing
        LEFT JOIN desired USING (person_id, rule_key)
        WHERE desired.person_id IS NULL) AS "removedCount"
  `);
}

async function applyAutomaticTagAssignments(db: Prisma.TransactionClient, desiredCtes: Prisma.Sql) {
  return db.$queryRaw<AutomaticTagSummaryRow[]>(Prisma.sql`
    WITH ${desiredCtes},
    existing AS MATERIALIZED (
      SELECT assignment.person_id, assignment.rule_key
      FROM automatic_tag_assignments AS assignment
      JOIN target_people AS target ON target.person_id = assignment.person_id
    ),
    deleted AS (
      DELETE FROM automatic_tag_assignments AS assignment
      USING target_people AS target
      WHERE assignment.person_id = target.person_id
        AND NOT EXISTS (
          SELECT 1
          FROM desired
          WHERE desired.person_id = assignment.person_id
            AND desired.rule_key = assignment.rule_key
        )
      RETURNING assignment.person_id, assignment.rule_key
    ),
    upserted AS (
      INSERT INTO automatic_tag_assignments AS current_assignment (
        person_id, tag_id, rule_key, evidence, assigned_at, evaluated_at
      )
      SELECT person_id, tag_id, rule_key, evidence, NOW(), NOW()
      FROM desired
      ON CONFLICT (person_id, rule_key) DO UPDATE SET
        tag_id = EXCLUDED.tag_id,
        evidence = EXCLUDED.evidence,
        evaluated_at = NOW()
      WHERE current_assignment.tag_id IS DISTINCT FROM EXCLUDED.tag_id
         OR current_assignment.evidence IS DISTINCT FROM EXCLUDED.evidence
      RETURNING person_id, rule_key
    ),
    affected_people AS (
      SELECT person_id FROM deleted
      UNION
      SELECT person_id FROM upserted
    )
    SELECT
      (SELECT COUNT(*)::integer FROM target_people) AS "evaluatedCount",
      (SELECT COUNT(*)::integer FROM desired) AS "matchedCount",
      (SELECT COALESCE(JSONB_OBJECT_AGG(rule_counts.rule_key, rule_counts.match_count), '{}'::jsonb)
        FROM (
          SELECT rule_key, COUNT(*)::integer AS match_count
          FROM desired
          GROUP BY rule_key
        ) AS rule_counts) AS "matchesByRule",
      (SELECT COUNT(*)::integer FROM desired
        LEFT JOIN existing USING (person_id, rule_key)
        WHERE existing.person_id IS NULL) AS "addedCount",
      (SELECT COUNT(*)::integer FROM deleted) AS "removedCount",
      (SELECT COUNT(*)::integer FROM upserted) AS "writtenCount",
      (SELECT COALESCE(JSONB_AGG(person_id ORDER BY person_id), '[]'::jsonb) FROM affected_people) AS "affectedPersonIds"
  `);
}

async function rebuildMaterializedPersonTags(db: Prisma.TransactionClient, targetPeopleSql: Prisma.Sql) {
  await db.$executeRaw(Prisma.sql`
    WITH target_people AS MATERIALIZED (
      ${targetPeopleSql}
    ),
    automatic_by_person AS (
      SELECT
        assignment.person_id,
        JSONB_AGG(definition.name ORDER BY LOWER(definition.name), definition.name) AS tags
      FROM automatic_tag_assignments AS assignment
      JOIN guest_tags AS definition ON definition.id = assignment.tag_id
      JOIN target_people AS target ON target.person_id = assignment.person_id
      GROUP BY assignment.person_id
    )
    UPDATE luma_people AS person
    SET
      automatic_tags = COALESCE(automatic.tags, '[]'::jsonb),
      tags = (
        SELECT COALESCE(JSONB_AGG(unique_tags.value ORDER BY LOWER(unique_tags.value), unique_tags.value), '[]'::jsonb)
        FROM (
          SELECT DISTINCT ON (LOWER(tag_value.value)) tag_value.value
          FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(person.manual_tags) = 'array' THEN person.manual_tags ELSE '[]'::jsonb END
            || COALESCE(automatic.tags, '[]'::jsonb)
          ) AS tag_value(value)
          ORDER BY LOWER(tag_value.value), tag_value.value
        ) AS unique_tags
      )
    FROM target_people AS target
    LEFT JOIN automatic_by_person AS automatic ON automatic.person_id = target.person_id
    WHERE person.person_id = target.person_id
  `);
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
  if (!eventId) return { deletedCount: 0, personIds: [] };
  const currentPersonIds = [...new Set(personIds.filter(Boolean))];
  const serialized = JSON.stringify(currentPersonIds);
  const rows = await prisma().$queryRaw<Array<{ personId: string }>>(Prisma.sql`
    DELETE FROM luma_event_guests AS guest
    WHERE guest.event_id = ${eventId}
      ${currentPersonIds.length ? Prisma.sql`
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(${serialized}::jsonb) AS current_person(person_id)
          WHERE current_person.person_id = guest.person_id
        )
      ` : Prisma.empty}
    RETURNING guest.person_id AS "personId"
  `);
  return { deletedCount: rows.length, personIds: rows.map((row) => row.personId) };
}

export async function updateIndexedGuestStatus({ eventId, lumaGuestId, status, lumaApprovalStatus }) {
  if (!eventId || !lumaGuestId) return { updatedCount: 0 };
  const now = new Date();
  const result = await prisma().lumaEventGuest.updateMany({
    where: { eventId, lumaGuestId },
    data: {
      status,
      lumaApprovalStatus,
      operatorDecision: status,
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
        "event_id", "title", "date", "starts_at", "ends_at", "visibility", "location", "category",
        "capacity", "luma_url", "raw", "last_seen_at", "synced_at"
      )
      VALUES ${Prisma.join(
        rows.map(
          (row) => Prisma.sql`(
            ${row.eventId}, ${row.title}, ${row.date}, ${row.startsAt}, ${row.endsAt}, ${row.visibility}, ${row.location}, ${row.category},
            ${row.capacity}, ${row.lumaUrl}, ${row.rawJson}::jsonb, ${row.lastSeenAt}, ${row.syncedAt}
          )`,
        ),
      )}
      ON CONFLICT ("event_id") DO UPDATE SET
        "title" = EXCLUDED."title",
        "date" = EXCLUDED."date",
        "starts_at" = EXCLUDED."starts_at",
        "ends_at" = EXCLUDED."ends_at",
        "visibility" = EXCLUDED."visibility",
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

function normalizedEventData(event: AnyRecord, rawEvent: AnyRecord = {}, now = new Date()) {
  return {
    eventId: event.id,
    title: event.title || "Untitled event",
    date: parseDateOnly(event.date || event.startsAt),
    startsAt: parseDateTime(event.startsAt),
    endsAt: parseDateTime(event.endsAt || rawEvent?.end_at),
    visibility: firstNonemptyString(event.visibility, rawEvent?.visibility) || null,
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
      operator_decision = CASE
        WHEN luma_event_guests.operator_decision IS NOT NULL
          AND EXCLUDED.status IS DISTINCT FROM luma_event_guests.status
          THEN NULL
        ELSE luma_event_guests.operator_decision
      END,
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
    endsAt: isoOrNull(row.endsAt),
    visibility: row.visibility || null,
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
    manualTags: row.manualTags || [],
    automaticTags: row.automaticTags || [],
    crmNotes: row.crmNotes || "",
    crmNotesUpdatedAt: isoOrNull(row.crmNotesUpdatedAt),
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
    operatorDecision: row.operatorDecision,
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

function firstNonemptyString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
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
