import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

type AnyRecord = Record<string, any>;
type HttpError = Error & { status?: number };
import { orderAvatarCandidates } from "../../avatar-order";
import { guestStatusAfterEvent } from "../../guest-display-status";
import { isAnyRegistrationAnswer } from "../../audience-answer-rules";
import { databaseUrlWithPoolLimits } from "./database-url";
import { lumaEventDate } from "./event-date";
import {
  GUEST_ACCEPTED_STATUSES,
  GUEST_REGISTERED_STATUSES,
  GUEST_REGISTRATION_STATUSES,
  guestQueryIncludedStatusFilters,
  guestQueryStatusFilters,
  guestStatusWhere,
  isOnlyInvitedStatusFilter,
  type GuestFilter,
  type GuestListQuery,
} from "./guest-query";
import { MAX_PERSON_TAGS, normalizePersonTags } from "./person-tags";
import { DEFAULT_TAG_COLOR, normalizeTagColor, normalizeTagName } from "./tag-catalog";
import { buildRegistrationQuestionAnalytics, REFERRED_PERSON_TAG } from "../../event-analytics";
import type { EventSwitchDiagnosticReporter } from "../../event-switch-diagnostics";
import { MAX_SELECTED_EVENT_IDS } from "../../event-selection";
import { phoneSearchDigits } from "../../phone-search";
import { AUTOMATIC_TAG_DEFINITIONS, AUTOMATIC_TAG_RULESET_VERSION, NEW_GUEST_MAX_REGISTRATIONS, automaticTagRunMode, normalizeAutomaticTagPersonIds } from "./auto-tags";
import type { AnalyticsRespondentQuery } from "./analytics-respondents";

const PRISMA_KEY = "__guestbookPrismaClientV4";
const LEGACY_PRISMA_KEYS = ["__guestbookPrismaClientV3", "__guestbookPrismaClientV2", "__guestbookPrismaClient"];
const AUDIENCE_TAG_GROUP_CACHE_MS = 120_000;
const AUDIENCE_EVENT_COUNT_CACHE_MS = 30_000;
const AUDIENCE_RESOLUTION_CACHE_MS = 30_000;
type AudienceTagGroup = { id: string; name: string; color: string; automatic: boolean; ruleKey: string | null; count: number };
type AudienceSuperTagGroup = {
  id: string;
  name: string;
  color: string;
  count: number;
  rules: Array<{ source: "tag_exact" | "tag" | "event"; phrase: string }>;
};
type AudienceEventCount = { eventId: string; attended: number; registered: number; invited: number };
export type IndexedAudienceCriteria = {
  includeTagIds?: string[];
  excludeTagIds?: string[];
  includeSuperTagIds?: string[];
  excludeSuperTagIds?: string[];
  includeEventCohorts?: Array<{ eventId: string; cohort: "attended" | "registered" | "invited" }>;
  excludeEventCohorts?: Array<{ eventId: string; cohort: "attended" | "registered" | "invited" }>;
  includeEventAnswers?: Array<{ eventId: string; cohort: "attended" | "registered" | "invited"; question: string; answer: string; answerKey: string }>;
  excludeEventAnswers?: Array<{ eventId: string; question: string; answer: string; answerKey: string }>;
  excludeExistingEventIds?: string[];
  includePersonIds?: string[];
  excludePersonIds?: string[];
};

export function audienceAnswerQuestionMode(operation: "include" | "exclude"): "all" | "any" {
  return operation === "exclude" ? "any" : "all";
}
let audienceTagGroupCache: { expiresAt: number; groups: AudienceTagGroup[] } | null = null;
let audienceTagGroupPromise: Promise<AudienceTagGroup[]> | null = null;
let audienceSuperTagGroupCache: { expiresAt: number; groups: AudienceSuperTagGroup[] } | null = null;
let audienceSuperTagGroupPromise: Promise<AudienceSuperTagGroup[]> | null = null;
let audienceEventCountCache: { expiresAt: number; counts: AudienceEventCount[] } | null = null;
let audienceEventCountPromise: Promise<AudienceEventCount[]> | null = null;
const audienceResolutionCache = new Map<string, { expiresAt: number; personIds: string[] }>();

function invalidateAudienceTagGroupCache() {
  audienceTagGroupCache = null;
  audienceSuperTagGroupCache = null;
  audienceResolutionCache.clear();
}

const INDEXED_PERSON_SELECT = {
  personId: true,
  lumaUserId: true,
  email: true,
  phoneNumber: true,
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
  comments: {
    orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
    take: 1,
    select: {
      body: true,
      createdAt: true,
    },
  },
  _count: {
    select: {
      comments: true,
    },
  },
};

const INDEXED_AUDIENCE_PERSON_SELECT = {
  personId: true,
  lumaUserId: true,
  email: true,
  name: true,
  avatarUrl: true,
  socialLinks: true,
  tags: true,
  manualTags: true,
  automaticTags: true,
};

const INDEXED_TRACE_PERSON_SELECT = {
  personId: true,
  lumaUserId: true,
  email: true,
  phoneNumber: true,
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
};

const INDEXED_GUEST_SELECT = {
  eventId: true,
  personId: true,
  lumaGuestId: true,
  email: true,
  phoneNumber: true,
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
  phoneNumber: string | null;
  status: string | null;
  lumaApprovalStatus: string | null;
  operatorDecision: string | null;
  registeredAt: Date | null;
  invitedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  approvedAt: Date | null;
  checkedInAt: Date | null;
  eventEndsAt?: Date | null;
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
  personCrmNotes: string | null;
  personCrmNotesUpdatedAt: Date | null;
  personCrmNoteCount: number;
};

type IndexedMultiEventGuestPageRow = IndexedGuestPageRow & {
  matchingRegistrationCount: number;
};

function indexedGuestStatusDateSql() {
  return Prisma.sql`
    CASE guest.status
      WHEN 'checked_in' THEN COALESCE(guest.checked_in_at, guest.updated_at, guest.approved_at, guest.registered_at, guest.invited_at, guest.created_at)
      WHEN 'invited' THEN COALESCE(guest.invited_at, guest.created_at, guest.updated_at, guest.registered_at)
      WHEN 'going' THEN COALESCE(guest.approved_at, guest.updated_at, guest.registered_at, guest.invited_at, guest.created_at)
      WHEN 'registered' THEN COALESCE(guest.registered_at, guest.created_at, guest.updated_at, guest.invited_at)
      WHEN 'waitlisted' THEN COALESCE(guest.updated_at, guest.registered_at, guest.created_at, guest.invited_at)
      WHEN 'declined' THEN COALESCE(guest.updated_at, guest.registered_at, guest.created_at, guest.invited_at)
      WHEN 'no_show' THEN COALESCE(guest.updated_at, guest.registered_at, guest.approved_at, guest.created_at, guest.invited_at)
      ELSE COALESCE(guest.updated_at, guest.checked_in_at, guest.approved_at, guest.registered_at, guest.invited_at, guest.created_at)
    END
  `;
}

function indexedRegisteredGuestPredicateSql() {
  return Prisma.sql`(
    guest.status IN (${Prisma.join(GUEST_REGISTERED_STATUSES)})
    OR (guest.status = 'declined' AND guest.registered_at IS NOT NULL)
  )`;
}

function indexedGuestPhoneNumberSql() {
  return Prisma.sql`COALESCE(NULLIF(BTRIM(person.phone_number), ''), guest.phone_number)`;
}

function indexedInvitationEvidencePredicateSql() {
  return Prisma.sql`(guest.invited_at IS NOT NULL OR guest.status = 'invited')`;
}

export function hasLumaDb() {
  return Boolean(process.env.DB_URL);
}

export function invalidateIndexedAudienceCaches() {
  audienceTagGroupCache = null;
  audienceTagGroupPromise = null;
  audienceSuperTagGroupCache = null;
  audienceSuperTagGroupPromise = null;
  audienceEventCountCache = null;
  audienceEventCountPromise = null;
  audienceResolutionCache.clear();
}

export async function listIndexedEvents({ limit = 100 } = {}) {
  const rows = await prisma().lumaEvent.findMany({
    where: { catalogActive: true },
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

export async function listIndexedEventDirectory({ limit = 5000 } = {}) {
  const resultLimit = Math.max(1, Math.min(5000, Math.trunc(limit) || 5000));
  const rows = await prisma().lumaEvent.findMany({
    where: { catalogActive: true },
    take: resultLimit,
    orderBy: [{ startsAt: "desc" }, { date: "desc" }, { title: "asc" }],
    select: {
      eventId: true,
      title: true,
      date: true,
      startsAt: true,
      syncedAt: true,
      raw: true,
      overviewStats: true,
      overviewStatsUpdatedAt: true,
      feedbackAverageRating: true,
      feedbackRatingCount: true,
      feedbackStatsUpdatedAt: true,
      syncState: { select: { updatedAt: true } },
    },
  });

  return {
    source: "luma-index",
    events: rows.map((row) => {
      const stats = normalizedEventOverviewStats(row.overviewStats);
      const modifiedAt = latestDate(
        row.feedbackStatsUpdatedAt,
        row.overviewStatsUpdatedAt,
        row.syncState?.updatedAt,
        row.syncedAt,
      );
      return {
        id: row.eventId,
        title: row.title || "Untitled event",
        date: isoOrNull(row.date || row.startsAt || modifiedAt)?.slice(0, 10),
        startsAt: isoOrNull(row.startsAt),
        imageUrl: indexedEventImageUrl(row.raw as AnyRecord),
        modifiedAt: isoOrNull(modifiedAt),
        newFaces: stats?.newFaces || 0,
        newReferrals: stats?.newReferrals || 0,
        checkedIn: stats?.checkedIn || 0,
        firstRegisters: stats?.firstRegisters || 0,
        accepted: stats?.accepted || 0,
        registered: stats?.registered || 0,
        invited: stats?.invited || 0,
        waitlisted: stats?.waitlisted || 0,
        averageRating: row.feedbackAverageRating,
        ratingCount: row.feedbackRatingCount,
        feedbackStatsUpdatedAt: isoOrNull(row.feedbackStatsUpdatedAt),
        statsReady: Boolean(stats),
      };
    }),
    loadedAt: new Date().toISOString(),
  };
}

export async function recordIndexedEventFeedbackStats(feedbackByEventId: Record<string, AnyRecord>) {
  if (!hasLumaDb()) return { skipped: true, updatedEventCount: 0 };
  const updatedAt = new Date();
  const summaries = Object.entries(feedbackByEventId)
    .filter(([eventId, feedback]) => eventId && feedback && typeof feedback === "object")
    .slice(0, 50)
    .map(([eventId, feedback]) => {
      const ratingCounts = feedback.ratingCounts && typeof feedback.ratingCounts === "object"
        ? feedback.ratingCounts
        : {};
      const ratingCount = [1, 2, 3, 4, 5]
        .reduce((sum, rating) => sum + Math.max(0, Number(ratingCounts[rating]) || 0), 0);
      const averageRating = Number(feedback.averageRating);
      return {
        eventId,
        averageRating: ratingCount && Number.isFinite(averageRating) ? averageRating : null,
        ratingCount,
      };
    });
  if (!summaries.length) return { skipped: false, updatedEventCount: 0 };

  const updates = await prisma().$transaction(summaries.map((summary) => prisma().lumaEvent.updateMany({
    where: { eventId: summary.eventId },
    data: {
      feedbackAverageRating: summary.averageRating,
      feedbackRatingCount: summary.ratingCount,
      feedbackStatsUpdatedAt: updatedAt,
    },
  })));
  return {
    skipped: false,
    updatedEventCount: updates.reduce((sum, update) => sum + update.count, 0),
  };
}

export async function refreshIndexedEventOverviewStats(eventIds: string[]) {
  const boundedEventIds = [...new Set(eventIds.map((eventId) => eventId.trim()).filter(Boolean))].slice(0, 5000);
  if (!boundedEventIds.length) return { updatedEventCount: 0, eventIds: [] };
  const rows = await prisma().$queryRaw<Array<{ eventId: string; overviewStats: Prisma.JsonValue; overviewStatsUpdatedAt: Date }>>(Prisma.sql`
    WITH target_events AS MATERIALIZED (
      SELECT event_id
      FROM luma_events
      WHERE event_id IN (${Prisma.join(boundedEventIds)})
    ),
    latest_manual_tag_mutations AS MATERIALIZED (
      SELECT DISTINCT ON (mutation.person_id, mutation.tag_id)
        mutation.person_id,
        mutation.tag_id,
        mutation.removed
      FROM manual_tag_mutations AS mutation
      JOIN guest_tags AS definition ON definition.id = mutation.tag_id
      WHERE definition.semantic_key = 'referral'
      ORDER BY mutation.person_id, mutation.tag_id, mutation.assigned_at DESC NULLS LAST, mutation.id DESC
    ),
    first_referral_attributions AS MATERIALIZED (
      SELECT DISTINCT ON (mutation.person_id, mutation.tag_id)
        mutation.person_id,
        mutation.tag_id,
        mutation.assigned_event_id
      FROM manual_tag_mutations AS mutation
      JOIN guest_tags AS definition ON definition.id = mutation.tag_id
      WHERE definition.semantic_key = 'referral'
        AND mutation.removed = FALSE
        AND mutation.assigned_event_id IS NOT NULL
      ORDER BY mutation.person_id, mutation.tag_id, mutation.assigned_at ASC NULLS LAST, mutation.id ASC
    ),
    active_referrals AS MATERIALIZED (
      SELECT DISTINCT mutation.person_id
      FROM latest_manual_tag_mutations AS mutation
      WHERE mutation.removed = FALSE
    ),
    guest_history AS MATERIALIZED (
      SELECT
        guest.event_id,
        guest.person_id,
        referral.person_id IS NOT NULL AS is_referred,
        first_referral.person_id IS NOT NULL AS is_new_referral,
        COALESCE(
          current_event.starts_at,
          current_event.date::timestamp AT TIME ZONE 'UTC'
        ) AS event_order,
        MIN(COALESCE(
          current_event.starts_at,
          current_event.date::timestamp AT TIME ZONE 'UTC'
        )) OVER (PARTITION BY guest.person_id) AS first_event_order
      FROM luma_event_guests AS guest
      JOIN luma_events AS current_event ON current_event.event_id = guest.event_id
      LEFT JOIN active_referrals AS referral ON referral.person_id = guest.person_id
      LEFT JOIN first_referral_attributions AS first_referral
        ON first_referral.person_id = guest.person_id
        AND first_referral.assigned_event_id = guest.event_id
    ),
    derived_guests AS MATERIALIZED (
      SELECT
        history.event_id,
        history.person_id,
        history.is_referred,
        history.is_new_referral,
        COALESCE(history.first_event_order < history.event_order, FALSE) AS has_prior_event
      FROM guest_history AS history
      JOIN target_events AS target ON target.event_id = history.event_id
    ),
    updated_guests AS (
      UPDATE luma_event_guests AS guest
      SET
        is_referred = derived.is_referred,
        is_new_referral = derived.is_new_referral,
        has_prior_event = derived.has_prior_event,
        metrics_derived_at = NOW()
      FROM derived_guests AS derived
      WHERE guest.event_id = derived.event_id
        AND guest.person_id = derived.person_id
        AND (
          guest.is_referred IS DISTINCT FROM derived.is_referred
          OR guest.is_new_referral IS DISTINCT FROM derived.is_new_referral
          OR guest.has_prior_event IS DISTINCT FROM derived.has_prior_event
        )
      RETURNING guest.event_id, guest.person_id
    ),
    event_aggregates AS MATERIALIZED (
      SELECT
        target.event_id,
        JSONB_BUILD_OBJECT(
          'version', 1,
          'total', COUNT(guest.person_id)::integer,
          'checkedIn', COUNT(guest.person_id) FILTER (WHERE guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')::integer,
          'accepted', COUNT(guest.person_id) FILTER (WHERE guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)}))::integer,
          'registered', COUNT(guest.person_id) FILTER (WHERE ${indexedRegisteredGuestPredicateSql()})::integer,
          'pending', COUNT(guest.person_id) FILTER (WHERE guest.status = 'registered')::integer,
          'declined', COUNT(guest.person_id) FILTER (WHERE guest.status = 'declined')::integer,
          'invited', COUNT(guest.person_id) FILTER (WHERE guest.invited_at IS NOT NULL OR guest.status = 'invited')::integer,
          'waitlisted', COUNT(guest.person_id) FILTER (WHERE guest.status = 'waitlisted')::integer,
          'toDecide', COUNT(guest.person_id) FILTER (
            WHERE guest.status = 'registered'
              OR (guest.status = 'waitlisted' AND guest.operator_decision IS DISTINCT FROM 'waitlisted')
          )::integer,
          'firstRegisters', COUNT(guest.person_id) FILTER (
            WHERE guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)}) AND NOT derived.has_prior_event
          )::integer,
          'newRegistrations', COUNT(guest.person_id) FILTER (
            WHERE ${indexedRegisteredGuestPredicateSql()} AND NOT derived.has_prior_event
          )::integer,
          'newFaces', COUNT(guest.person_id) FILTER (
            WHERE guest.status = 'checked_in' AND NOT derived.has_prior_event
          )::integer,
          'referredRegistrations', COUNT(guest.person_id) FILTER (
            WHERE derived.is_referred AND ${indexedRegisteredGuestPredicateSql()}
          )::integer,
          'newReferrals', COUNT(guest.person_id) FILTER (
            WHERE derived.is_referred
              AND derived.is_new_referral
              AND (guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')
          )::integer,
          'referredAccepted', COUNT(guest.person_id) FILTER (
            WHERE derived.is_referred AND guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)})
          )::integer,
          'referredCheckedIn', COUNT(guest.person_id) FILTER (
            WHERE derived.is_referred AND (guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')
          )::integer,
          'referredFirstRegisters', COUNT(guest.person_id) FILTER (
            WHERE derived.is_referred
              AND guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)})
              AND NOT derived.has_prior_event
          )::integer,
          'referredReturning', COUNT(guest.person_id) FILTER (
            WHERE derived.is_referred
              AND guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)})
              AND derived.has_prior_event
          )::integer,
          'invitationTotal', COUNT(guest.person_id) FILTER (WHERE ${indexedInvitationEvidencePredicateSql()})::integer,
          'invitedGoing', COUNT(guest.person_id) FILTER (
            WHERE ${indexedInvitationEvidencePredicateSql()} AND guest.status = 'going' AND NOT ${indexedDerivedNoShowPredicateSql()}
          )::integer,
          'invitedCheckedIn', COUNT(guest.person_id) FILTER (
            WHERE ${indexedInvitationEvidencePredicateSql()}
              AND (guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')
          )::integer,
          'invitedNoShow', COUNT(guest.person_id) FILTER (
            WHERE ${indexedInvitationEvidencePredicateSql()} AND ${indexedDerivedNoShowPredicateSql()}
          )::integer,
          'invitedNoResponse', COUNT(guest.person_id) FILTER (WHERE guest.status = 'invited')::integer,
          'invitedDeclined', COUNT(guest.person_id) FILTER (
            WHERE ${indexedInvitationEvidencePredicateSql()} AND guest.status = 'declined'
          )::integer,
          'invitedReferralTotal', COUNT(guest.person_id) FILTER (
            WHERE derived.is_referred AND ${indexedInvitationEvidencePredicateSql()}
          )::integer,
          'invitedReferralGoing', COUNT(guest.person_id) FILTER (
            WHERE derived.is_referred AND ${indexedInvitationEvidencePredicateSql()} AND guest.status = 'going' AND NOT ${indexedDerivedNoShowPredicateSql()}
          )::integer,
          'invitedReferralCheckedIn', COUNT(guest.person_id) FILTER (
            WHERE derived.is_referred
              AND ${indexedInvitationEvidencePredicateSql()}
              AND (guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')
          )::integer,
          'invitedReferralNoShow', COUNT(guest.person_id) FILTER (
            WHERE derived.is_referred AND ${indexedInvitationEvidencePredicateSql()} AND ${indexedDerivedNoShowPredicateSql()}
          )::integer,
          'invitedReferralNoResponse', COUNT(guest.person_id) FILTER (
            WHERE derived.is_referred AND guest.status = 'invited'
          )::integer,
          'invitedReferralDeclined', COUNT(guest.person_id) FILTER (
            WHERE derived.is_referred AND ${indexedInvitationEvidencePredicateSql()} AND guest.status = 'declined'
          )::integer
        ) AS overview_stats
      FROM target_events AS target
      LEFT JOIN luma_event_guests AS guest ON guest.event_id = target.event_id
      LEFT JOIN derived_guests AS derived
        ON derived.event_id = guest.event_id
        AND derived.person_id = guest.person_id
      GROUP BY target.event_id
    )
    UPDATE luma_events AS event
    SET
      overview_stats = aggregate.overview_stats,
      overview_stats_updated_at = NOW()
    FROM event_aggregates AS aggregate
    WHERE event.event_id = aggregate.event_id
    RETURNING
      event.event_id AS "eventId",
      event.overview_stats AS "overviewStats",
      event.overview_stats_updated_at AS "overviewStatsUpdatedAt"
  `);
  return { updatedEventCount: rows.length, eventIds: rows.map((row) => row.eventId) };
}

type IndexedPeopleSearchOptions = {
  limit?: number;
  offset?: number;
  includedTags?: string[];
  excludedTags?: string[];
  tagMode?: "any" | "all";
  comments?: "any" | "with" | "without";
};

export async function searchIndexedPeople(search: string, {
  limit = 8,
  offset = 0,
  includedTags = [],
  excludedTags = [],
  tagMode = "any",
  comments = "any",
}: IndexedPeopleSearchOptions = {}) {
  const query = search.trim().slice(0, 120);
  const phoneDigits = phoneSearchDigits(query);
  const normalizedIncludedTags = [...new Set(includedTags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
  const normalizedExcludedTags = [...new Set(excludedTags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
  const normalizedComments = comments === "with" || comments === "without" ? comments : "any";
  const hasFilters = normalizedIncludedTags.length > 0
    || normalizedExcludedTags.length > 0
    || normalizedComments !== "any";
  if (!query && !hasFilters) return { people: [], hasMore: false, nextOffset: 0 };

  const db = prisma();
  const escapedQuery = query.replace(/[\\%_]/g, "\\$&");
  const containsQuery = `%${escapedQuery}%`;
  const prefixQuery = `${escapedQuery}%`;
  const containsPhoneDigits = `%${phoneDigits}%`;
  const pageSize = Math.max(1, Math.min(20, Math.trunc(limit) || 8));
  const resultOffset = Math.max(0, Math.min(10_000, Math.trunc(offset) || 0));
  const resultLimit = pageSize + 1;
  const personCandidateLimit = (resultOffset + resultLimit) * 10;
  const guestCandidateLimit = (resultOffset + resultLimit) * 20;
  const personFilterConditions: Prisma.Sql[] = [];
  if (normalizedIncludedTags.length) {
    personFilterConditions.push(tagMode === "all"
      ? Prisma.sql`(
          SELECT COUNT(DISTINCT matched_tag.value)
          FROM JSONB_ARRAY_ELEMENTS_TEXT(person.tags) AS matched_tag(value)
          WHERE matched_tag.value IN (${Prisma.join(normalizedIncludedTags)})
        ) = ${normalizedIncludedTags.length}`
      : Prisma.sql`EXISTS (
          SELECT 1
          FROM JSONB_ARRAY_ELEMENTS_TEXT(person.tags) AS matched_tag(value)
          WHERE matched_tag.value IN (${Prisma.join(normalizedIncludedTags)})
        )`);
  }
  if (normalizedExcludedTags.length) {
    personFilterConditions.push(Prisma.sql`NOT EXISTS (
      SELECT 1
      FROM JSONB_ARRAY_ELEMENTS_TEXT(person.tags) AS excluded_tag(value)
      WHERE excluded_tag.value IN (${Prisma.join(normalizedExcludedTags)})
    )`);
  }
  if (normalizedComments === "with") {
    personFilterConditions.push(Prisma.sql`EXISTS (
      SELECT 1
      FROM guest_comments AS filtered_comment
      WHERE filtered_comment.person_id = person.person_id
    )`);
  } else if (normalizedComments === "without") {
    personFilterConditions.push(Prisma.sql`NOT EXISTS (
      SELECT 1
      FROM guest_comments AS filtered_comment
      WHERE filtered_comment.person_id = person.person_id
    )`);
  }
  const personFilterSql = personFilterConditions.length
    ? Prisma.sql`AND ${Prisma.join(personFilterConditions, " AND ")}`
    : Prisma.empty;
  const matches = await db.$queryRaw<Array<{
    personId: string;
    eventId: string | null;
    phoneNumber: string | null;
    eventsAttended: number;
    eventsRegistered: number;
  }>>(Prisma.sql`
    WITH person_candidates AS MATERIALIZED (
        SELECT
          person.person_id,
          CASE
            WHEN LOWER(person.name) = LOWER(${query}) THEN 0
            WHEN LOWER(COALESCE(person.email, '')) = LOWER(${query}) THEN 1
            WHEN LOWER(person.name) LIKE LOWER(${prefixQuery}) ESCAPE '\\' THEN 2
            WHEN LOWER(COALESCE(person.email, '')) LIKE LOWER(${prefixQuery}) ESCAPE '\\' THEN 3
            ELSE 4
          END AS rank
        FROM luma_people AS person
        WHERE (
          ${!query}
          OR (
            LOWER(
              COALESCE(person.name, '') || ' ' ||
              COALESCE(person.email, '') || ' ' ||
              COALESCE(person.title, '') || ' ' ||
              COALESCE(person.bio, '')
            ) LIKE LOWER(${containsQuery}) ESCAPE '\\'
            OR (
              ${Boolean(phoneDigits)}
              AND REGEXP_REPLACE(COALESCE(person.phone_number, ''), '[^0-9]', '', 'g') LIKE ${containsPhoneDigits}
            )
            OR EXISTS (
              SELECT 1
              FROM guest_comments AS comment
              WHERE comment.person_id = person.person_id
                AND LOWER(comment.body) LIKE LOWER(${containsQuery}) ESCAPE '\\'
            )
          )
        )
        ${personFilterSql}
        ORDER BY rank, person.last_seen_at DESC, person.name ASC
        LIMIT ${personCandidateLimit}
    ),
    guest_candidates AS MATERIALIZED (
        SELECT guest.person_id, 5 AS rank
        FROM luma_event_guests AS guest
        WHERE ${Boolean(query)}
          AND (
            LOWER(
              COALESCE(guest.email, '') || ' ' ||
              COALESCE(guest.profile_description, '') || ' ' ||
              COALESCE(guest.search_text, '')
            ) LIKE LOWER(${containsQuery}) ESCAPE '\\'
            OR (
              ${Boolean(phoneDigits)}
              AND REGEXP_REPLACE(COALESCE(guest.phone_number, ''), '[^0-9]', '', 'g') LIKE ${containsPhoneDigits}
            )
          )
        LIMIT ${guestCandidateLimit}
    ),
    tag_candidates AS MATERIALIZED (
        SELECT person.person_id, 4 AS rank
        FROM guest_tags AS definition
        JOIN luma_people AS person
          ON person.tags @> JSONB_BUILD_ARRAY(definition.name)
        WHERE ${Boolean(query)}
          AND LOWER(definition.name) LIKE LOWER(${containsQuery}) ESCAPE '\\'
        LIMIT ${personCandidateLimit}
    ),
    candidate_matches AS MATERIALIZED (
      SELECT candidate.person_id, MIN(candidate.rank)::integer AS rank
      FROM (
        SELECT * FROM person_candidates

        UNION ALL

        SELECT * FROM guest_candidates

        UNION ALL

        SELECT * FROM tag_candidates
      ) AS candidate
      GROUP BY candidate.person_id
    ),
    ranked_people AS MATERIALIZED (
      SELECT candidate.person_id, candidate.rank
      FROM candidate_matches AS candidate
      JOIN luma_people AS person ON person.person_id = candidate.person_id
      WHERE TRUE
      ${personFilterSql}
      ORDER BY candidate.rank, person.last_seen_at DESC, person.name ASC
      LIMIT ${resultLimit}
      OFFSET ${resultOffset}
    )
    SELECT
      person.person_id AS "personId",
      latest_event.event_id AS "eventId",
      COALESCE(NULLIF(BTRIM(person.phone_number), ''), latest_phone.phone_number) AS "phoneNumber",
      COALESCE(activity.events_attended, 0)::integer AS "eventsAttended",
      COALESCE(activity.events_registered, 0)::integer AS "eventsRegistered"
    FROM ranked_people AS ranked
    JOIN luma_people AS person ON person.person_id = ranked.person_id
    LEFT JOIN LATERAL (
      SELECT guest.event_id
      FROM luma_event_guests AS guest
      LEFT JOIN luma_events AS event ON event.event_id = guest.event_id
      WHERE guest.person_id = person.person_id
      ORDER BY event.starts_at DESC NULLS LAST, event.date DESC NULLS LAST, guest.last_seen_at DESC
      LIMIT 1
    ) AS latest_event ON TRUE
    LEFT JOIN LATERAL (
      SELECT guest.phone_number
      FROM luma_event_guests AS guest
      LEFT JOIN luma_events AS event ON event.event_id = guest.event_id
      WHERE guest.person_id = person.person_id
        AND NULLIF(BTRIM(guest.phone_number), '') IS NOT NULL
      ORDER BY event.starts_at DESC NULLS LAST, event.date DESC NULLS LAST, guest.last_seen_at DESC
      LIMIT 1
    ) AS latest_phone ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(DISTINCT guest.event_id)
          FILTER (WHERE guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')::integer AS events_attended,
        COUNT(DISTINCT guest.event_id)
          FILTER (WHERE ${indexedRegisteredGuestPredicateSql()})::integer AS events_registered
        FROM luma_event_guests AS guest
        JOIN luma_events AS counted_event ON counted_event.event_id = guest.event_id
        WHERE guest.person_id = person.person_id
          AND counted_event.catalog_active = TRUE
          AND LOWER(COALESCE(counted_event.raw->>'status', '')) NOT IN ('cancelled', 'canceled')
    ) AS activity ON TRUE
    ORDER BY ranked.rank, person.last_seen_at DESC, person.name ASC
  `);

  const hasMore = matches.length > pageSize;
  const pageMatches = matches.slice(0, pageSize);
  if (!pageMatches.length) return { people: [], hasMore: false, nextOffset: resultOffset };
  const people = await db.lumaPerson.findMany({
    where: { personId: { in: pageMatches.map((match) => match.personId) } },
    select: INDEXED_PERSON_SELECT,
  });
  const peopleById = new Map(people.map((person) => [person.personId, person]));

  return {
    people: pageMatches.flatMap((match) => {
      const person = peopleById.get(match.personId);
      return person ? [{
        person: {
          ...indexedPersonToApiPerson(person, { phoneNumber: match.phoneNumber }),
          eventCounts: {
            attended: Number(match.eventsAttended) || 0,
            registered: Number(match.eventsRegistered) || 0,
          },
        },
        eventId: match.eventId || "",
      }] : [];
    }),
    hasMore,
    nextOffset: resultOffset + pageMatches.length,
  };
}

export async function searchIndexedPeopleByName(search: string, { limit = 20, offset = 0 } = {}) {
  const query = search.trim().slice(0, 120);
  if (!query) return { people: [], hasMore: false, nextOffset: 0 };
  const escapedQuery = query.replace(/[\\%_]/g, "\\$&");
  const containsQuery = `%${escapedQuery}%`;
  const prefixQuery = `${escapedQuery}%`;
  const pageSize = Math.max(1, Math.min(50, Math.trunc(limit) || 20));
  const resultOffset = Math.max(0, Math.min(10_000, Math.trunc(offset) || 0));
  const resultLimit = pageSize + 1;
  const matches = await prisma().$queryRaw<Array<{ personId: string }>>(Prisma.sql`
    SELECT person.person_id AS "personId"
    FROM luma_people AS person
    WHERE LOWER(person.name) LIKE LOWER(${containsQuery}) ESCAPE '\\'
    ORDER BY
      CASE
        WHEN LOWER(person.name) = LOWER(${query}) THEN 0
        WHEN LOWER(person.name) LIKE LOWER(${prefixQuery}) ESCAPE '\\' THEN 1
        ELSE 2
      END,
      person.last_seen_at DESC,
      person.name ASC
    LIMIT ${resultLimit}
    OFFSET ${resultOffset}
  `);
  const hasMore = matches.length > pageSize;
  const pageMatches = matches.slice(0, pageSize);
  return {
    ...await indexedPeopleSearchResult(pageMatches),
    hasMore,
    nextOffset: resultOffset + pageMatches.length,
  };
}

export async function listIndexedAudienceTagGroups() {
  if (audienceTagGroupCache && audienceTagGroupCache.expiresAt > Date.now()) return audienceTagGroupCache.groups;
  if (audienceTagGroupPromise) return audienceTagGroupPromise;
  audienceTagGroupPromise = prisma().$queryRaw<AudienceTagGroup[]>(Prisma.sql`
    WITH latest_manual AS MATERIALIZED (
      SELECT DISTINCT ON (mutation.person_id, mutation.tag_id)
        mutation.person_id,
        mutation.tag_id,
        mutation.removed
      FROM manual_tag_mutations AS mutation
      ORDER BY mutation.person_id, mutation.tag_id, mutation.assigned_at DESC, mutation.id DESC
    ),
    assignment_counts AS MATERIALIZED (
      SELECT assignment.tag_id, COUNT(*)::integer AS count
      FROM automatic_tag_assignments AS assignment
      GROUP BY assignment.tag_id

      UNION ALL

      SELECT mutation.tag_id, COUNT(*)::integer AS count
      FROM latest_manual AS mutation
      WHERE NOT mutation.removed
      GROUP BY mutation.tag_id
    ),
    tag_counts AS (
      SELECT assignment.tag_id, SUM(assignment.count)::integer AS count
      FROM assignment_counts AS assignment
      GROUP BY assignment.tag_id
    )
    SELECT
      definition.id,
      definition.name,
      definition.color,
      (definition.rule_key IS NOT NULL) AS automatic,
      definition.rule_key AS "ruleKey",
      tag_counts.count
    FROM guest_tags AS definition
    JOIN tag_counts ON tag_counts.tag_id = definition.id
    WHERE tag_counts.count > 0
    ORDER BY tag_counts.count DESC, definition.name ASC
    LIMIT 500
  `).then((groups) => {
    audienceTagGroupCache = { expiresAt: Date.now() + AUDIENCE_TAG_GROUP_CACHE_MS, groups };
    return groups;
  }).finally(() => {
    audienceTagGroupPromise = null;
  });
  return audienceTagGroupPromise;
}

export async function listIndexedAudienceSuperTagGroups() {
  if (audienceSuperTagGroupCache && audienceSuperTagGroupCache.expiresAt > Date.now()) return audienceSuperTagGroupCache.groups;
  if (audienceSuperTagGroupPromise) return audienceSuperTagGroupPromise;
  audienceSuperTagGroupPromise = prisma().$queryRaw<AudienceSuperTagGroup[]>(Prisma.sql`
    WITH latest_manual AS MATERIALIZED (
      SELECT DISTINCT ON (mutation.person_id, mutation.tag_id)
        mutation.person_id,
        mutation.tag_id,
        mutation.removed
      FROM manual_tag_mutations AS mutation
      ORDER BY mutation.person_id, mutation.tag_id, mutation.assigned_at DESC, mutation.id DESC
    ),
    members AS MATERIALIZED (
      SELECT rule.super_tag_id, assignment.person_id
      FROM super_tag_rules AS rule
      JOIN guest_tags AS definition
        ON (rule.source = 'tag' AND STRPOS(LOWER(definition.name), LOWER(rule.phrase)) > 0)
        OR (rule.source = 'tag_exact' AND LOWER(definition.name) = LOWER(rule.phrase))
      JOIN automatic_tag_assignments AS assignment ON assignment.tag_id = definition.id

      UNION

      SELECT rule.super_tag_id, latest.person_id
      FROM super_tag_rules AS rule
      JOIN guest_tags AS definition
        ON (rule.source = 'tag' AND STRPOS(LOWER(definition.name), LOWER(rule.phrase)) > 0)
        OR (rule.source = 'tag_exact' AND LOWER(definition.name) = LOWER(rule.phrase))
      JOIN latest_manual AS latest ON latest.tag_id = definition.id
      WHERE NOT latest.removed

      UNION

      SELECT rule.super_tag_id, guest.person_id
      FROM super_tag_rules AS rule
      JOIN luma_events AS event
        ON rule.source = 'event'
       AND STRPOS(LOWER(event.title), LOWER(rule.phrase)) > 0
      JOIN luma_event_guests AS guest ON guest.event_id = event.event_id
      WHERE guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in'
    ),
    member_counts AS (
      SELECT super_tag_id, COUNT(DISTINCT person_id)::integer AS count
      FROM members
      GROUP BY super_tag_id
    ),
    grouped_rules AS (
      SELECT
        rule.super_tag_id,
        JSONB_AGG(
          JSONB_BUILD_OBJECT('source', rule.source, 'phrase', rule.phrase)
          ORDER BY rule.id
        ) AS rules
      FROM super_tag_rules AS rule
      GROUP BY rule.super_tag_id
    )
    SELECT
      super_tag.id,
      super_tag.name,
      super_tag.color,
      COALESCE(member_counts.count, 0)::integer AS count,
      COALESCE(grouped_rules.rules, '[]'::jsonb) AS rules
    FROM super_tags AS super_tag
    LEFT JOIN member_counts ON member_counts.super_tag_id = super_tag.id
    LEFT JOIN grouped_rules ON grouped_rules.super_tag_id = super_tag.id
    ORDER BY member_counts.count DESC NULLS LAST, super_tag.name
  `).then((groups) => {
    audienceSuperTagGroupCache = { expiresAt: Date.now() + AUDIENCE_TAG_GROUP_CACHE_MS, groups };
    return groups;
  }).finally(() => {
    audienceSuperTagGroupPromise = null;
  });
  return audienceSuperTagGroupPromise;
}

export async function listIndexedPeopleByTag(tag: string, { tagId = "", limit = 5000, idsOnly = false } = {}) {
  const normalizedTag = tag.trim().slice(0, 80);
  const normalizedTagId = tagId.trim().slice(0, 120);
  if (!normalizedTag && !normalizedTagId) return { people: [], total: 0, truncated: false };
  const resultLimit = Math.max(1, Math.min(50_000, Math.trunc(limit) || 5000));
  const matches = await prisma().$queryRaw<Array<{ personId: string; total: number }>>(Prisma.sql`
    WITH selected_tag AS MATERIALIZED (
      SELECT definition.id
      FROM guest_tags AS definition
      WHERE (${normalizedTagId} <> '' AND definition.id = ${normalizedTagId})
         OR (${normalizedTagId} = '' AND LOWER(definition.name) = LOWER(${normalizedTag}))
      LIMIT 1
    ),
    latest_manual AS MATERIALIZED (
      SELECT DISTINCT ON (mutation.person_id, mutation.tag_id)
        mutation.person_id,
        mutation.tag_id,
        mutation.removed
      FROM manual_tag_mutations AS mutation
      JOIN selected_tag ON selected_tag.id = mutation.tag_id
      ORDER BY mutation.person_id, mutation.tag_id, mutation.assigned_at DESC, mutation.id DESC
    ),
    matching_people AS MATERIALIZED (
      SELECT assignment.person_id
      FROM automatic_tag_assignments AS assignment
      JOIN selected_tag ON selected_tag.id = assignment.tag_id

      UNION

      SELECT mutation.person_id
      FROM latest_manual AS mutation
      WHERE NOT mutation.removed
    )
    SELECT person.person_id AS "personId", COUNT(*) OVER ()::integer AS total
    FROM matching_people AS match
    JOIN luma_people AS person ON person.person_id = match.person_id
    ORDER BY person.last_seen_at DESC, person.name ASC
    LIMIT ${resultLimit}
  `);
  const total = Number(matches[0]?.total) || 0;
  if (idsOnly) return { personIds: matches.map((match) => match.personId), total, truncated: total > matches.length };
  const result = await indexedPeopleSearchResult(matches, { compact: true });
  return { ...result, total, truncated: total > matches.length };
}

export async function listIndexedPeopleByEventCohort(
  eventId: string,
  cohort: "attended" | "registered" | "invited",
  { limit = 5000, idsOnly = false } = {},
) {
  const normalizedEventId = eventId.trim().slice(0, 200);
  if (!normalizedEventId) return { people: [], total: 0, truncated: false };
  const resultLimit = Math.max(1, Math.min(50_000, Math.trunc(limit) || 5000));
  const matches = await prisma().$queryRaw<Array<{ personId: string; total: number }>>(Prisma.sql`
    SELECT guest.person_id AS "personId", COUNT(*) OVER ()::integer AS total
    FROM luma_event_guests AS guest
    JOIN luma_people AS person ON person.person_id = guest.person_id
    WHERE guest.event_id = ${normalizedEventId}
      AND ${cohort === "attended"
        ? Prisma.sql`(guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')`
        : cohort === "invited"
          ? Prisma.sql`(guest.invited_at IS NOT NULL OR guest.status = 'invited')`
          : indexedRegisteredGuestPredicateSql()}
    ORDER BY person.name ASC, person.person_id
    LIMIT ${resultLimit}
  `);
  const total = Number(matches[0]?.total) || 0;
  if (idsOnly) return { personIds: matches.map((match) => match.personId), total, truncated: total > matches.length };
  const result = await indexedPeopleSearchResult(matches, { compact: true });
  return { ...result, total, truncated: total > matches.length };
}

const AUDIENCE_RESOLUTION_LIMIT = 50_000;

function normalizedAudienceValues(values: unknown, limit = 500) {
  return Array.isArray(values)
    ? [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].slice(0, limit)
    : [];
}

function normalizedAudienceCohorts(values: unknown) {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    const eventId = String(value?.eventId || "").trim();
    const cohort = value?.cohort;
    return eventId && ["attended", "registered", "invited"].includes(cohort)
      ? [{ eventId, cohort: cohort as "attended" | "registered" | "invited" }]
      : [];
  }).slice(0, 500);
}

function normalizedAudienceEventAnswers(values: unknown, { requireCohort = false } = {}) {
  if (!Array.isArray(values)) return [];
  const normalized = values.flatMap((value) => {
    const eventId = String(value?.eventId || "").trim().slice(0, 200);
    const question = String(value?.question || "").trim().slice(0, 500);
    const answer = String(value?.answer || "").trim().slice(0, 500);
    const answerKey = String(value?.answerKey || "").trim().slice(0, 500);
    const cohort = value?.cohort;
    const validCohort = ["attended", "registered", "invited"].includes(cohort);
    return eventId && question && answer && answerKey && (!requireCohort || validCohort)
      ? [{ eventId, ...(validCohort ? { cohort: cohort as "attended" | "registered" | "invited" } : {}), question, answer, answerKey }]
      : [];
  });
  const unique = new Map(normalized.map((value) => [
    `${value.eventId}\u0000${value.question.toLocaleLowerCase()}\u0000${value.answerKey}`,
    value,
  ]));
  return [...unique.values()].slice(0, 500);
}

export function normalizeIndexedAudienceCriteria(criteria: IndexedAudienceCriteria | null | undefined): IndexedAudienceCriteria {
  return {
    includeTagIds: normalizedAudienceValues(criteria?.includeTagIds),
    excludeTagIds: normalizedAudienceValues(criteria?.excludeTagIds),
    includeSuperTagIds: normalizedAudienceValues(criteria?.includeSuperTagIds),
    excludeSuperTagIds: normalizedAudienceValues(criteria?.excludeSuperTagIds),
    includeEventCohorts: normalizedAudienceCohorts(criteria?.includeEventCohorts),
    excludeEventCohorts: normalizedAudienceCohorts(criteria?.excludeEventCohorts),
    includeEventAnswers: normalizedAudienceEventAnswers(criteria?.includeEventAnswers, { requireCohort: true }) as IndexedAudienceCriteria["includeEventAnswers"],
    excludeEventAnswers: normalizedAudienceEventAnswers(criteria?.excludeEventAnswers),
    excludeExistingEventIds: normalizedAudienceValues(criteria?.excludeExistingEventIds),
    includePersonIds: normalizedAudienceValues(criteria?.includePersonIds, AUDIENCE_RESOLUTION_LIMIT),
    excludePersonIds: normalizedAudienceValues(criteria?.excludePersonIds, AUDIENCE_RESOLUTION_LIMIT),
  };
}

function audienceSuperTagPeopleSql(superTagIds: string[]) {
  if (!superTagIds.length) return Prisma.sql`SELECT NULL::text AS person_id WHERE FALSE`;
  return Prisma.sql`
    SELECT assignment.person_id
    FROM super_tag_rules AS rule
    JOIN guest_tags AS definition
      ON (rule.source = 'tag' AND STRPOS(LOWER(definition.name), LOWER(rule.phrase)) > 0)
      OR (rule.source = 'tag_exact' AND LOWER(definition.name) = LOWER(rule.phrase))
    JOIN automatic_tag_assignments AS assignment ON assignment.tag_id = definition.id
    WHERE rule.super_tag_id IN (${Prisma.join(superTagIds)})

    UNION

    SELECT latest.person_id
    FROM super_tag_rules AS rule
    JOIN guest_tags AS definition
      ON (rule.source = 'tag' AND STRPOS(LOWER(definition.name), LOWER(rule.phrase)) > 0)
      OR (rule.source = 'tag_exact' AND LOWER(definition.name) = LOWER(rule.phrase))
    JOIN (
      SELECT DISTINCT ON (mutation.person_id, mutation.tag_id)
        mutation.person_id,
        mutation.tag_id,
        mutation.removed
      FROM manual_tag_mutations AS mutation
      ORDER BY mutation.person_id, mutation.tag_id, mutation.assigned_at DESC, mutation.id DESC
    ) AS latest ON latest.tag_id = definition.id
    WHERE rule.super_tag_id IN (${Prisma.join(superTagIds)})
      AND NOT latest.removed

    UNION

    SELECT guest.person_id
    FROM super_tag_rules AS rule
    JOIN luma_events AS event
      ON rule.source = 'event'
     AND STRPOS(LOWER(event.title), LOWER(rule.phrase)) > 0
    JOIN luma_event_guests AS guest ON guest.event_id = event.event_id
    WHERE rule.super_tag_id IN (${Prisma.join(superTagIds)})
      AND (guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')
  `;
}

export async function resolveIndexedAudiencePersonIds(
  rawCriteria: IndexedAudienceCriteria,
  { useCache = true } = {},
) {
  const criteria = normalizeIndexedAudienceCriteria(rawCriteria);
  const cacheKey = JSON.stringify(criteria);
  const cached = audienceResolutionCache.get(cacheKey);
  if (useCache && cached && cached.expiresAt > Date.now()) return cached.personIds;
  const include = new Set(criteria.includePersonIds || []);
  const exclude = new Set(criteria.excludePersonIds || []);
  const collect = async (target: Set<string>, resultPromise: Promise<any>) => {
    const result = await resultPromise;
    if (result.truncated) {
      const error = new Error(`Audience exceeds the ${AUDIENCE_RESOLUTION_LIMIT.toLocaleString()}-person safety limit.`) as HttpError;
      error.status = 400;
      throw error;
    }
    (result.personIds || []).forEach((personId: string) => target.add(personId));
  };

  await Promise.all([
    ...(criteria.includeTagIds || []).map((tagId) =>
      collect(include, listIndexedPeopleByTag("", { tagId, idsOnly: true, limit: AUDIENCE_RESOLUTION_LIMIT }))),
    ...(criteria.excludeTagIds || []).map((tagId) =>
      collect(exclude, listIndexedPeopleByTag("", { tagId, idsOnly: true, limit: AUDIENCE_RESOLUTION_LIMIT }))),
    ...((criteria.includeSuperTagIds || []).length ? [collect(include, listIndexedPeopleBySuperTags(criteria.includeSuperTagIds || []))] : []),
    ...((criteria.excludeSuperTagIds || []).length ? [collect(exclude, listIndexedPeopleBySuperTags(criteria.excludeSuperTagIds || []))] : []),
    ...(criteria.includeEventCohorts || []).map(({ eventId, cohort }) =>
      collect(include, listIndexedPeopleByEventCohort(eventId, cohort, { idsOnly: true, limit: AUDIENCE_RESOLUTION_LIMIT }))),
    ...(criteria.excludeEventCohorts || []).map(({ eventId, cohort }) =>
      collect(exclude, listIndexedPeopleByEventCohort(eventId, cohort, { idsOnly: true, limit: AUDIENCE_RESOLUTION_LIMIT }))),
  ]);
  const includeEventAnswers = criteria.includeEventAnswers || [];
  if (includeEventAnswers.length) {
    const matches = await prisma().$queryRaw<Array<{ personId: string }>>(Prisma.sql`
      SELECT DISTINCT guest.person_id AS "personId"
      FROM luma_event_guests AS guest
      WHERE ${audienceEventAnswersWhereSql(includeEventAnswers, { questionMode: audienceAnswerQuestionMode("include") })}
      LIMIT ${AUDIENCE_RESOLUTION_LIMIT + 1}
    `);
    if (matches.length > AUDIENCE_RESOLUTION_LIMIT) {
      const error = new Error(`Audience exceeds the ${AUDIENCE_RESOLUTION_LIMIT.toLocaleString()}-person safety limit.`) as HttpError;
      error.status = 400;
      throw error;
    }
    matches.forEach(({ personId }) => include.add(personId));
  }
  const excludeEventAnswers = criteria.excludeEventAnswers || [];
  if (excludeEventAnswers.length) {
    const matches = await prisma().$queryRaw<Array<{ personId: string }>>(Prisma.sql`
      SELECT DISTINCT guest.person_id AS "personId"
      FROM luma_event_guests AS guest
      WHERE ${audienceEventAnswersWhereSql(excludeEventAnswers, { questionMode: audienceAnswerQuestionMode("exclude") })}
      LIMIT ${AUDIENCE_RESOLUTION_LIMIT + 1}
    `);
    if (matches.length > AUDIENCE_RESOLUTION_LIMIT) {
      const error = new Error(`Audience exceeds the ${AUDIENCE_RESOLUTION_LIMIT.toLocaleString()}-person safety limit.`) as HttpError;
      error.status = 400;
      throw error;
    }
    matches.forEach(({ personId }) => exclude.add(personId));
  }
  if ((criteria.excludeExistingEventIds || []).length) {
    const existingGuests = await prisma().lumaEventGuest.findMany({
      where: { eventId: { in: criteria.excludeExistingEventIds } },
      select: { personId: true },
      distinct: ["personId"],
    });
    existingGuests.forEach(({ personId }) => exclude.add(personId));
  }

  const personIds = [...include].filter((personId) => !exclude.has(personId));
  if (audienceResolutionCache.size >= 50) {
    const oldestKey = audienceResolutionCache.keys().next().value;
    if (oldestKey) audienceResolutionCache.delete(oldestKey);
  }
  audienceResolutionCache.set(cacheKey, { expiresAt: Date.now() + AUDIENCE_RESOLUTION_CACHE_MS, personIds });
  return personIds;
}

async function listIndexedPeopleBySuperTags(superTagIds: string[]) {
  const rows = await prisma().$queryRaw<Array<{ personId: string; total: number }>>(Prisma.sql`
    WITH matching_people AS MATERIALIZED (
      ${audienceSuperTagPeopleSql(superTagIds)}
    )
    SELECT person_id AS "personId", COUNT(*) OVER ()::integer AS total
    FROM matching_people
    ORDER BY person_id
    LIMIT ${AUDIENCE_RESOLUTION_LIMIT}
  `);
  const total = Number(rows[0]?.total) || 0;
  return {
    personIds: rows.map((row) => row.personId),
    total,
    truncated: total > rows.length,
  };
}

function audienceValuesWhereSql(column: Prisma.Sql, values: string[]) {
  return values.length ? Prisma.sql`${column} IN (${Prisma.join(values)})` : Prisma.sql`FALSE`;
}

function indexedRegistrationAnswerChoicePredicateSql(item: Prisma.Sql, answer: string, answerKey: string): Prisma.Sql {
  if (isAnyRegistrationAnswer(answerKey)) {
    return Prisma.sql`BTRIM(COALESCE(${item} ->> 'value', '')) <> ''`;
  }
  const normalizedMatch = answerKey
    ? Prisma.sql`REGEXP_REPLACE(LOWER(BTRIM(COALESCE(${item} ->> 'value', ''))), '[^[:alnum:]]+', '', 'g') = ${answerKey}`
    : Prisma.sql`LOWER(BTRIM(COALESCE(${item} ->> 'value', ''))) = LOWER(${answer})`;
  const selectedValueMatch = answerKey
    ? Prisma.sql`REGEXP_REPLACE(LOWER(BTRIM(selected_value.value)), '[^[:alnum:]]+', '', 'g') = ${answerKey}`
    : Prisma.sql`LOWER(BTRIM(selected_value.value)) = LOWER(${answer})`;
  return Prisma.sql`(
    ${normalizedMatch}
    OR EXISTS (
      SELECT 1
      FROM JSONB_ARRAY_ELEMENTS_TEXT(
        CASE WHEN JSONB_TYPEOF(${item} -> 'values') = 'array'
          THEN ${item} -> 'values' ELSE '[]'::jsonb END
      ) AS selected_value(value)
      WHERE ${selectedValueMatch}
    )
    OR (
      REGEXP_REPLACE(LOWER(COALESCE(${item} ->> 'questionType', ${item} ->> 'question_type', '')), '[^[:alnum:]]+', '', 'g')
        IN ('multiselect', 'checkbox', 'checkboxes')
      AND POSITION(
        ' ' || REGEXP_REPLACE(LOWER(BTRIM(${answer})), '[^[:alnum:]]+', ' ', 'g') || ' '
        IN ' ' || REGEXP_REPLACE(LOWER(BTRIM(COALESCE(${item} ->> 'value', ''))), '[^[:alnum:]]+', ' ', 'g') || ' '
      ) > 0
    )
  )`;
}

function audienceEventCohortsWhereSql(selections: Array<{ eventId: string; cohort: "attended" | "registered" | "invited" }>) {
  if (!selections.length) return Prisma.sql`FALSE`;
  return Prisma.sql`(${Prisma.join(selections.map(({ eventId, cohort }) => Prisma.sql`
    (guest.event_id = ${eventId} AND ${cohort === "attended"
      ? Prisma.sql`(guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')`
      : cohort === "invited"
        ? Prisma.sql`(guest.invited_at IS NOT NULL OR guest.status = 'invited')`
        : indexedRegisteredGuestPredicateSql()})
  `), " OR ")})`;
}

function audienceEventAnswersWhereSql(
  selections: Array<{ eventId: string; cohort?: "attended" | "registered" | "invited"; question: string; answer: string; answerKey: string }>,
  { questionMode = "all" }: { questionMode?: "all" | "any" } = {},
) {
  if (!selections.length) return Prisma.sql`FALSE`;
  const eventGroups = new Map<string, {
    eventId: string;
    cohort?: "attended" | "registered" | "invited";
    questions: Map<string, { question: string; answers: Array<{ answer: string; answerKey: string }> }>;
  }>();
  selections.forEach(({ eventId, cohort, question, answer, answerKey }) => {
    const eventKey = `${eventId}\u0000${cohort || ""}`;
    const eventGroup = eventGroups.get(eventKey) || { eventId, cohort, questions: new Map() };
    const questionKey = question.toLocaleLowerCase();
    const questionGroup = eventGroup.questions.get(questionKey) || { question, answers: [] };
    questionGroup.answers.push({ answer, answerKey });
    eventGroup.questions.set(questionKey, questionGroup);
    eventGroups.set(eventKey, eventGroup);
  });
  return Prisma.sql`(${Prisma.join([...eventGroups.values()].map(({ eventId, cohort, questions }) => Prisma.sql`
    (guest.event_id = ${eventId}
      AND ${cohort === "attended"
        ? Prisma.sql`(guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')`
        : cohort === "invited"
          ? Prisma.sql`(guest.invited_at IS NOT NULL OR guest.status = 'invited')`
          : cohort === "registered" ? indexedRegisteredGuestPredicateSql() : Prisma.sql`TRUE`}
      AND (${Prisma.join([...questions.values()].map(({ question, answers }) => Prisma.sql`
        EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(guest.registration_answers) = 'array'
              THEN guest.registration_answers ELSE '[]'::jsonb END
          ) AS registration_answer
          WHERE LOWER(BTRIM(COALESCE(registration_answer->>'label', ''))) = LOWER(${question})
            AND (${Prisma.join(answers.map(({ answer, answerKey }) => Prisma.sql`
              ${indexedRegistrationAnswerChoicePredicateSql(Prisma.sql`registration_answer`, answer, answerKey)}
            `), " OR ")})
        )
      `), questionMode === "any" ? " OR " : " AND ")})
    )
  `), " OR ")})`;
}

export async function listIndexedAudiencePage(
  rawCriteria: IndexedAudienceCriteria,
  { cursor = "", pageSize = 100, includeTotals = true, query = "" }: { cursor?: string | number; pageSize?: number; includeTotals?: boolean; query?: string } = {},
) {
  const criteria = normalizeIndexedAudienceCriteria(rawCriteria);
  const normalizedQuery = String(query || "").trim().slice(0, 120);
  const searchPattern = `%${normalizedQuery}%`;
  const offset = includeTotals && typeof cursor === "number" ? Math.max(0, Math.trunc(cursor) || 0) : 0;
  const cursorPersonId = !includeTotals && typeof cursor === "string" ? cursor.trim().slice(0, 200) : "";
  const limit = Math.max(1, Math.min(200, Math.trunc(pageSize) || 100));
  const queryLimit = includeTotals ? limit : limit + 1;
  const includeTagIds = criteria.includeTagIds || [];
  const excludeTagIds = criteria.excludeTagIds || [];
  const includeSuperTagIds = criteria.includeSuperTagIds || [];
  const excludeSuperTagIds = criteria.excludeSuperTagIds || [];
  const allTagIds = [...new Set([...includeTagIds, ...excludeTagIds])];
  const includeEventCohorts = criteria.includeEventCohorts || [];
  const excludeEventCohorts = criteria.excludeEventCohorts || [];
  const includeEventAnswers = criteria.includeEventAnswers || [];
  const excludeEventAnswers = criteria.excludeEventAnswers || [];
  const includePersonIds = criteria.includePersonIds || [];
  const excludePersonIds = criteria.excludePersonIds || [];
  const excludeExistingEventIds = criteria.excludeExistingEventIds || [];
  const rows = await prisma().$queryRaw<Array<{
    personId: string;
    lumaUserId: string | null;
    email: string | null;
    name: string;
    avatarUrl: string | null;
    tags: Prisma.JsonValue;
    manualTags: Prisma.JsonValue;
    automaticTags: Prisma.JsonValue;
    totalCount: number;
    eligibleCount: number;
    attended: number;
    registered: number;
    existingTargetStatuses: string[] | null;
    existingTargetEventCount: number;
  }>>(Prisma.sql`
    WITH latest_manual AS MATERIALIZED (
      SELECT DISTINCT ON (mutation.person_id, mutation.tag_id)
        mutation.person_id,
        mutation.tag_id,
        mutation.removed
      FROM manual_tag_mutations AS mutation
      WHERE ${audienceValuesWhereSql(Prisma.sql`mutation.tag_id`, allTagIds)}
      ORDER BY mutation.person_id, mutation.tag_id, mutation.assigned_at DESC, mutation.id DESC
    ),
    included_people AS MATERIALIZED (
      SELECT assignment.person_id
      FROM automatic_tag_assignments AS assignment
      WHERE ${audienceValuesWhereSql(Prisma.sql`assignment.tag_id`, includeTagIds)}

      UNION

      SELECT mutation.person_id
      FROM latest_manual AS mutation
      WHERE NOT mutation.removed
        AND ${audienceValuesWhereSql(Prisma.sql`mutation.tag_id`, includeTagIds)}

      UNION

      SELECT match.person_id
      FROM (${audienceSuperTagPeopleSql(includeSuperTagIds)}) AS match

      UNION

      SELECT guest.person_id
      FROM luma_event_guests AS guest
      WHERE ${audienceEventCohortsWhereSql(includeEventCohorts)}

      UNION

      SELECT guest.person_id
      FROM luma_event_guests AS guest
      WHERE ${audienceEventAnswersWhereSql(includeEventAnswers, { questionMode: audienceAnswerQuestionMode("include") })}

      UNION

      SELECT person.person_id
      FROM luma_people AS person
      WHERE ${audienceValuesWhereSql(Prisma.sql`person.person_id`, includePersonIds)}
    ),
    excluded_people AS MATERIALIZED (
      SELECT assignment.person_id
      FROM automatic_tag_assignments AS assignment
      WHERE ${audienceValuesWhereSql(Prisma.sql`assignment.tag_id`, excludeTagIds)}

      UNION

      SELECT mutation.person_id
      FROM latest_manual AS mutation
      WHERE NOT mutation.removed
        AND ${audienceValuesWhereSql(Prisma.sql`mutation.tag_id`, excludeTagIds)}

      UNION

      SELECT match.person_id
      FROM (${audienceSuperTagPeopleSql(excludeSuperTagIds)}) AS match

      UNION

      SELECT guest.person_id
      FROM luma_event_guests AS guest
      WHERE ${audienceEventCohortsWhereSql(excludeEventCohorts)}

      UNION

      SELECT guest.person_id
      FROM luma_event_guests AS guest
      WHERE ${audienceEventAnswersWhereSql(excludeEventAnswers, { questionMode: audienceAnswerQuestionMode("exclude") })}

      UNION

      SELECT person.person_id
      FROM luma_people AS person
      WHERE ${audienceValuesWhereSql(Prisma.sql`person.person_id`, excludePersonIds)}
    ),
    target_members AS MATERIALIZED (
      SELECT
        guest.person_id,
        ARRAY_AGG(DISTINCT COALESCE(guest.status, 'registered')) AS statuses,
        COUNT(DISTINCT guest.event_id)::integer AS event_count
      FROM luma_event_guests AS guest
      WHERE ${audienceValuesWhereSql(Prisma.sql`guest.event_id`, excludeExistingEventIds)}
      GROUP BY guest.person_id
    ),
    audience_people AS MATERIALIZED (
      SELECT included.person_id
      FROM included_people AS included
      EXCEPT
      SELECT excluded.person_id
      FROM excluded_people AS excluded
    ),
    person_page AS MATERIALIZED (
      SELECT
        person.person_id,
        person.luma_user_id,
        person.email,
        person.name,
        person.avatar_url,
        person.tags,
        person.manual_tags,
        person.automatic_tags,
        ${includeTotals ? Prisma.sql`COUNT(*) OVER ()::integer` : Prisma.sql`NULL::integer`} AS total_count,
        ${includeTotals ? Prisma.sql`COUNT(*) FILTER (WHERE target.person_id IS NULL) OVER ()::integer` : Prisma.sql`NULL::integer`} AS eligible_count,
        target.statuses AS existing_target_statuses,
        COALESCE(target.event_count, 0)::integer AS existing_target_event_count,
        ${includeTotals
          ? Prisma.sql`ROW_NUMBER() OVER (ORDER BY person.last_seen_at DESC, person.name ASC, person.person_id)::integer`
          : Prisma.sql`0::integer`} AS page_order
      FROM audience_people AS audience
      JOIN luma_people AS person ON person.person_id = audience.person_id
      LEFT JOIN target_members AS target ON target.person_id = audience.person_id
      WHERE ${cursorPersonId ? Prisma.sql`person.person_id > ${cursorPersonId}` : Prisma.sql`TRUE`}
        AND ${normalizedQuery ? Prisma.sql`(
          person.name ILIKE ${searchPattern}
          OR person.email ILIKE ${searchPattern}
        )` : Prisma.sql`TRUE`}
      ORDER BY ${includeTotals
        ? Prisma.sql`person.last_seen_at DESC, person.name ASC, person.person_id`
        : Prisma.sql`person.person_id ASC`}
      LIMIT ${queryLimit}
      OFFSET ${offset}
    ),
    page_counts AS MATERIALIZED (
      SELECT
        guest.person_id,
        COUNT(*) FILTER (WHERE guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')::integer AS attended,
        COUNT(*) FILTER (WHERE guest.status IN ('registered', 'going', 'waitlisted', 'checked_in', 'no_show'))::integer AS registered
      FROM luma_event_guests AS guest
      JOIN luma_events AS counted_event ON counted_event.event_id = guest.event_id
      JOIN person_page AS page ON page.person_id = guest.person_id
      WHERE counted_event.catalog_active = TRUE
        AND LOWER(COALESCE(counted_event.raw->>'status', '')) NOT IN ('cancelled', 'canceled')
      GROUP BY guest.person_id
    )
    SELECT
      page.person_id AS "personId",
      page.luma_user_id AS "lumaUserId",
      page.email,
      page.name,
      page.avatar_url AS "avatarUrl",
      page.tags,
      page.manual_tags AS "manualTags",
      page.automatic_tags AS "automaticTags",
      page.total_count AS "totalCount",
      page.eligible_count AS "eligibleCount",
      page.existing_target_statuses AS "existingTargetStatuses",
      page.existing_target_event_count AS "existingTargetEventCount",
      page.page_order,
      COALESCE(counts.attended, 0)::integer AS attended,
      COALESCE(counts.registered, 0)::integer AS registered
    FROM person_page AS page
    LEFT JOIN page_counts AS counts ON counts.person_id = page.person_id
    ORDER BY ${includeTotals ? Prisma.sql`page.page_order` : Prisma.sql`page.person_id`}
  `);
  const hasMore = !includeTotals && rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const total = includeTotals ? Number(pageRows[0]?.totalCount) || 0 : null;
  const eligibleTotal = includeTotals ? Number(pageRows[0]?.eligibleCount) || 0 : null;
  const people = pageRows.map((row) => ({
    person: indexedPersonToApiPerson(row),
    eventCounts: {
      attended: Number(row.attended) || 0,
      registered: Number(row.registered) || 0,
    },
    alreadyInTargetEvent: Number(row.existingTargetEventCount) > 0,
    existingTargetStatuses: row.existingTargetStatuses || [],
    existingTargetEventCount: Number(row.existingTargetEventCount) || 0,
  }));
  const nextCursor = includeTotals
    ? offset + people.length < Number(total) ? offset + people.length : null
    : hasMore ? pageRows.at(-1)?.personId || null : null;
  return {
    people,
    pageInfo: {
      total,
      eligibleTotal,
      cursor: includeTotals ? offset : cursorPersonId || null,
      nextCursor,
      hasMore: includeTotals ? nextCursor !== null : hasMore,
    },
  };
}

export async function countIndexedAudience(criteria: IndexedAudienceCriteria) {
  const normalized = normalizeIndexedAudienceCriteria(criteria);
  const includeTagIds = normalized.includeTagIds || [];
  const excludeTagIds = normalized.excludeTagIds || [];
  const includeSuperTagIds = normalized.includeSuperTagIds || [];
  const excludeSuperTagIds = normalized.excludeSuperTagIds || [];
  const allTagIds = [...new Set([...includeTagIds, ...excludeTagIds])];
  const includeEventCohorts = normalized.includeEventCohorts || [];
  const excludeEventCohorts = normalized.excludeEventCohorts || [];
  const includeEventAnswers = normalized.includeEventAnswers || [];
  const excludeEventAnswers = normalized.excludeEventAnswers || [];
  const includePersonIds = normalized.includePersonIds || [];
  const excludePersonIds = normalized.excludePersonIds || [];
  const excludeExistingEventIds = normalized.excludeExistingEventIds || [];
  const [result] = await prisma().$queryRaw<Array<{ total: number; existingTotal: number }>>(Prisma.sql`
    WITH latest_manual AS MATERIALIZED (
      SELECT DISTINCT ON (mutation.person_id, mutation.tag_id)
        mutation.person_id,
        mutation.tag_id,
        mutation.removed
      FROM manual_tag_mutations AS mutation
      WHERE ${audienceValuesWhereSql(Prisma.sql`mutation.tag_id`, allTagIds)}
      ORDER BY mutation.person_id, mutation.tag_id, mutation.assigned_at DESC, mutation.id DESC
    ),
    included_people AS MATERIALIZED (
      SELECT assignment.person_id
      FROM automatic_tag_assignments AS assignment
      WHERE ${audienceValuesWhereSql(Prisma.sql`assignment.tag_id`, includeTagIds)}

      UNION

      SELECT mutation.person_id
      FROM latest_manual AS mutation
      WHERE NOT mutation.removed
        AND ${audienceValuesWhereSql(Prisma.sql`mutation.tag_id`, includeTagIds)}

      UNION

      SELECT match.person_id
      FROM (${audienceSuperTagPeopleSql(includeSuperTagIds)}) AS match

      UNION

      SELECT guest.person_id
      FROM luma_event_guests AS guest
      WHERE ${audienceEventCohortsWhereSql(includeEventCohorts)}

      UNION

      SELECT guest.person_id
      FROM luma_event_guests AS guest
      WHERE ${audienceEventAnswersWhereSql(includeEventAnswers, { questionMode: audienceAnswerQuestionMode("include") })}

      UNION

      SELECT person.person_id
      FROM luma_people AS person
      WHERE ${audienceValuesWhereSql(Prisma.sql`person.person_id`, includePersonIds)}
    ),
    excluded_people AS MATERIALIZED (
      SELECT assignment.person_id
      FROM automatic_tag_assignments AS assignment
      WHERE ${audienceValuesWhereSql(Prisma.sql`assignment.tag_id`, excludeTagIds)}

      UNION

      SELECT mutation.person_id
      FROM latest_manual AS mutation
      WHERE NOT mutation.removed
        AND ${audienceValuesWhereSql(Prisma.sql`mutation.tag_id`, excludeTagIds)}

      UNION

      SELECT match.person_id
      FROM (${audienceSuperTagPeopleSql(excludeSuperTagIds)}) AS match

      UNION

      SELECT guest.person_id
      FROM luma_event_guests AS guest
      WHERE ${audienceEventCohortsWhereSql(excludeEventCohorts)}

      UNION

      SELECT guest.person_id
      FROM luma_event_guests AS guest
      WHERE ${audienceEventAnswersWhereSql(excludeEventAnswers, { questionMode: audienceAnswerQuestionMode("exclude") })}

      UNION

      SELECT person.person_id
      FROM luma_people AS person
      WHERE ${audienceValuesWhereSql(Prisma.sql`person.person_id`, excludePersonIds)}
    ),
    audience_people AS MATERIALIZED (
      SELECT included.person_id
      FROM included_people AS included
      EXCEPT
      SELECT excluded.person_id
      FROM excluded_people AS excluded
    ),
    target_members AS MATERIALIZED (
      SELECT DISTINCT guest.person_id
      FROM luma_event_guests AS guest
      WHERE ${audienceValuesWhereSql(Prisma.sql`guest.event_id`, excludeExistingEventIds)}
    )
    SELECT
      COUNT(*)::integer AS total,
      COUNT(*) FILTER (WHERE target.person_id IS NOT NULL)::integer AS "existingTotal"
    FROM audience_people AS audience
    JOIN luma_people AS person ON person.person_id = audience.person_id
    LEFT JOIN target_members AS target ON target.person_id = audience.person_id
  `);
  const total = Number(result?.total) || 0;
  const existingTotal = Number(result?.existingTotal) || 0;
  return {
    total,
    eligibleTotal: total - existingTotal,
    existingTotal,
  };
}

export async function listIndexedAudienceInviteRecipients(criteria: IndexedAudienceCriteria) {
  const personIds = await resolveIndexedAudiencePersonIds(criteria, { useCache: false });
  if (!personIds.length) return [];
  const people = await prisma().lumaPerson.findMany({
    where: { personId: { in: personIds } },
    select: { personId: true, email: true, name: true },
  });
  return people
    .filter((person) => Boolean(person.email))
    .map((person) => ({ id: person.personId, email: person.email, name: person.name, source: "luma" }));
}

export async function listIndexedEventCohortCounts() {
  if (audienceEventCountCache && audienceEventCountCache.expiresAt > Date.now()) return audienceEventCountCache.counts;
  if (audienceEventCountPromise) return audienceEventCountPromise;
  audienceEventCountPromise = prisma().$queryRaw<AudienceEventCount[]>(Prisma.sql`
    SELECT
      guest.event_id AS "eventId",
      COUNT(*) FILTER (WHERE guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')::integer AS attended,
      COUNT(*) FILTER (WHERE ${indexedRegisteredGuestPredicateSql()})::integer AS registered,
      COUNT(*) FILTER (WHERE guest.invited_at IS NOT NULL OR guest.status = 'invited')::integer AS invited
    FROM luma_event_guests AS guest
    GROUP BY guest.event_id
  `).then((counts) => {
    audienceEventCountCache = { expiresAt: Date.now() + AUDIENCE_EVENT_COUNT_CACHE_MS, counts };
    return counts;
  }).finally(() => {
    audienceEventCountPromise = null;
  });
  return audienceEventCountPromise;
}

async function indexedPeopleSearchResult(matches: Array<{ personId: string }>, { compact = false } = {}) {
  if (!matches.length) return { people: [] };
  const db = prisma();
  const personIds = matches.map((match) => match.personId);
  const [people, countRows] = await Promise.all([
    db.lumaPerson.findMany({ where: { personId: { in: personIds } }, select: compact ? INDEXED_AUDIENCE_PERSON_SELECT : INDEXED_PERSON_SELECT }),
    db.$queryRaw<Array<{ personId: string; attended: number; registered: number }>>(Prisma.sql`
      SELECT
        guest.person_id AS "personId",
        COUNT(*) FILTER (WHERE guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')::integer AS attended,
        COUNT(*) FILTER (WHERE guest.status IN ('registered', 'going', 'waitlisted', 'checked_in', 'no_show'))::integer AS registered
      FROM luma_event_guests AS guest
      JOIN luma_events AS counted_event ON counted_event.event_id = guest.event_id
      WHERE guest.person_id IN (${Prisma.join(personIds)})
        AND counted_event.catalog_active = TRUE
        AND LOWER(COALESCE(counted_event.raw->>'status', '')) NOT IN ('cancelled', 'canceled')
      GROUP BY guest.person_id
    `),
  ]);
  const peopleById = new Map(people.map((person) => [person.personId, person]));
  const countsById = new Map(countRows.map((row) => [row.personId, { attended: Number(row.attended) || 0, registered: Number(row.registered) || 0 }]));
  return {
    people: matches.flatMap((match) => {
      const person = peopleById.get(match.personId);
      return person ? [{ person: indexedPersonToApiPerson(person), eventCounts: countsById.get(match.personId) || { attended: 0, registered: 0 } }] : [];
    }),
  };
}

export async function listIndexedEventGuests(
  eventId: string,
  query: GuestListQuery = { filter: "all", search: "", tags: [], cursor: 0, pageSize: 50, includeSummary: true },
  diagnosticReporter?: EventSwitchDiagnosticReporter,
  knownEventBoundary?: { startsAt: Date | null; endsAt?: Date | null; date: Date | null } | null,
) {
  const db = prisma();
  const includeSummary = query.includeSummary !== false;
  const includeEventCounts = query.includeEventCounts !== false;
  const guestPageSort = indexedGuestPageSortSql(query);
  // EVENT_SWITCH_DIAGNOSTICS: each report isolates one database phase without adding log I/O to the query path.
  let diagnosticStartedAt = Date.now();
  const eventBoundary = knownEventBoundary || await db.lumaEvent.findUnique({
    where: { eventId },
    select: { startsAt: true, endsAt: true, date: true },
  });
  const eventBoundaryStage = knownEventBoundary ? "event_boundary_provided" : "event_boundary";
  diagnosticReporter?.(eventBoundaryStage, Date.now() - diagnosticStartedAt, {
    found: Boolean(eventBoundary),
  });
  const firstRegisterWhere = guestStatusWhere(eventId, "first_registers", eventBoundary);
  diagnosticStartedAt = Date.now();
  const pageRows = await db.$queryRaw<IndexedGuestPageRow[]>(Prisma.sql`
    WITH
    ${indexedNewReferralFilterCtesSql(query)}
    guest_page AS (
      SELECT
        guest.*,
        COUNT(*) OVER ()::integer AS total_count
      FROM luma_event_guests AS guest
      ${indexedGuestPageWhereSql(eventId, query, eventBoundary)}
      ORDER BY
        CASE WHEN ${isOnlyInvitedStatusFilter(query) && (query.sortBy || "status_date") === "status_date"} THEN
          CASE WHEN guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)}) THEN 0 WHEN guest.status = 'invited' THEN 1 ELSE 2 END
        ELSE 0 END,
        ${guestPageSort}
      LIMIT ${query.pageSize}
      OFFSET ${query.cursor}
    )
    SELECT
      guest.total_count AS "totalCount",
      guest.event_id AS "eventId",
      guest.person_id AS "personId",
      guest.luma_guest_id AS "lumaGuestId",
      guest.email,
      ${indexedGuestPhoneNumberSql()} AS "phoneNumber",
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
      latest_comment.body AS "personCrmNotes",
      latest_comment.created_at AS "personCrmNotesUpdatedAt",
      COALESCE(latest_comment.comment_count, 0)::integer AS "personCrmNoteCount"
    FROM guest_page AS guest
    JOIN luma_people AS person
      ON person.person_id = guest.person_id
    LEFT JOIN LATERAL (
      SELECT
        comment.body,
        comment.created_at,
        COUNT(*) OVER ()::integer AS comment_count
      FROM guest_comments AS comment
      WHERE comment.person_id = person.person_id
      ORDER BY comment.created_at DESC, comment.id DESC
      LIMIT 1
    ) AS latest_comment ON TRUE
    ORDER BY
      CASE WHEN ${isOnlyInvitedStatusFilter(query) && (query.sortBy || "status_date") === "status_date"} THEN
        CASE WHEN guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)}) THEN 0 WHEN guest.status = 'invited' THEN 1 ELSE 2 END
      ELSE 0 END,
      ${guestPageSort}
  `);
  const rows = pageRows.map((row) => indexedGuestPageRowToRecord(row, eventBoundary?.endsAt));
  const filteredCount = pageRows[0]?.totalCount ?? query.cursor;
  diagnosticReporter?.("guest_page_joined_count", Date.now() - diagnosticStartedAt, { rowCount: rows.length, filteredCount });

  let stats = null;
  let analyticsQuestions = null;
  let analyticsAllQuestions = null;
  if (includeSummary) {
    ({ stats, analyticsQuestions, analyticsAllQuestions } = await indexedEventAnalytics(db, eventId, eventBoundary, firstRegisterWhere, diagnosticReporter));
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
    event: { endsAt: isoOrNull(eventBoundary?.endsAt) },
    guests,
    people: [...peopleById.values()],
    loadedAt: new Date().toISOString(),
    indexed: true,
    indexHasGuests: includeSummary ? Boolean(stats?.total) : true,
    ...(stats ? { stats, analyticsQuestions, analyticsAllQuestions } : {}),
    pageInfo: {
      total: filteredCount,
      pageSize: query.pageSize,
      hasMore: nextCursor < filteredCount,
      nextCursor: nextCursor < filteredCount ? String(nextCursor) : null,
    },
    query: {
      filter: query.filter,
      filters: guestQueryIncludedStatusFilters(query),
      filterMode: query.filterMode || "any",
      excludedFilters: query.excludedFilters || [],
      search: query.search,
      tags: query.tags,
      tagMode: query.tagMode || "any",
      excludedTags: query.excludedTags || [],
      sortBy: query.sortBy || "status_date",
      sortDirection: query.sortDirection || "desc",
      hasNotes: Boolean(query.hasNotes),
      attendedGreaterThan: query.attendedGreaterThan ?? null,
    },
  };
}

export async function listIndexedEventGuestMutationTargets(
  eventId: string,
  query: GuestListQuery,
  { limit = 1001 }: { limit?: number } = {},
) {
  const db = prisma();
  const eventBoundary = await db.lumaEvent.findUnique({
    where: { eventId },
    select: { startsAt: true, date: true },
  });
  if (!eventBoundary) return [];
  const resultLimit = Math.max(1, Math.min(5001, Math.trunc(limit) || 1001));
  return db.$queryRaw<Array<{ personId: string; lumaGuestId: string | null }>>(Prisma.sql`
    WITH
    ${indexedNewReferralFilterCtesSql(query)}
    matching_guests AS MATERIALIZED (
      SELECT guest.person_id, guest.luma_guest_id
      FROM luma_event_guests AS guest
      ${indexedGuestPageWhereSql(eventId, query, eventBoundary)}
    )
    SELECT
      guest.person_id AS "personId",
      guest.luma_guest_id AS "lumaGuestId"
    FROM matching_guests AS guest
    ORDER BY guest.person_id, guest.luma_guest_id NULLS LAST
    LIMIT ${resultLimit}
  `);
}

export async function listIndexedMultiEventGuests(
  eventIds: string[],
  query: GuestListQuery = { filter: "all", search: "", tags: [], cursor: 0, pageSize: 50, includeSummary: false },
) {
  const boundedEventIds = [...new Set(eventIds.filter(Boolean))].slice(0, MAX_SELECTED_EVENT_IDS);
  if (boundedEventIds.length < 2) return null;
  const db = prisma();
  const statusDateSortDirection = query.sortDirection === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const statusDateAggregate = (query.sortBy || "status_date") === "status_date" && query.sortDirection === "asc" ? Prisma.sql`MIN` : Prisma.sql`MAX`;
  const withinPersonSortDirection = (query.sortBy || "status_date") === "status_date" ? statusDateSortDirection : Prisma.sql`DESC`;
  const personPageSort = indexedPersonPageSortSql(query, "person");
  const resultPageSort = indexedPersonPageSortSql(query, "page");
  const pageRows = await db.$queryRaw<IndexedMultiEventGuestPageRow[]>(Prisma.sql`
    WITH selected_events AS MATERIALIZED (
      SELECT event_id, starts_at, date
      FROM luma_events
      WHERE event_id IN (${Prisma.join(boundedEventIds)})
    ),
    ${indexedNewReferralFilterCtesSql(query)}
    matching_guests AS MATERIALIZED (
      SELECT guest.*
      FROM luma_event_guests AS guest
      JOIN selected_events AS selected_event ON selected_event.event_id = guest.event_id
      ${indexedMultiEventGuestPageWhereSql(query)}
    ),
    matching_people AS MATERIALIZED (
      SELECT
        guest.person_id,
        ${statusDateAggregate}(${indexedGuestStatusDateSql()}) AS latest_activity,
        MIN(CASE WHEN guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)}) THEN 0 WHEN guest.status = 'invited' THEN 1 ELSE 2 END)::integer AS invitation_sort,
        (
          SELECT COUNT(*)::integer
          FROM luma_event_guests AS lifetime_guest
          JOIN luma_events AS lifetime_event ON lifetime_event.event_id = lifetime_guest.event_id
          WHERE lifetime_guest.person_id = guest.person_id
            AND (lifetime_guest.checked_in_at IS NOT NULL OR lifetime_guest.status = 'checked_in')
            AND lifetime_event.catalog_active = TRUE
            AND LOWER(COALESCE(lifetime_event.raw->>'status', '')) NOT IN ('cancelled', 'canceled')
        ) AS events_attended,
        (
          SELECT COUNT(*)::integer
          FROM luma_event_guests AS lifetime_guest
          JOIN luma_events AS lifetime_event ON lifetime_event.event_id = lifetime_guest.event_id
          WHERE lifetime_guest.person_id = guest.person_id
            AND lifetime_guest.status IN ('registered', 'going', 'waitlisted', 'checked_in', 'no_show')
            AND lifetime_event.catalog_active = TRUE
            AND LOWER(COALESCE(lifetime_event.raw->>'status', '')) NOT IN ('cancelled', 'canceled')
        ) AS events_registered,
        COUNT(*)::integer AS registration_count
      FROM matching_guests AS guest
      GROUP BY guest.person_id
    ),
    person_page AS (
      SELECT
        person.person_id,
        person.latest_activity,
        person.invitation_sort,
        person.events_attended,
        person.events_registered,
        COUNT(*) OVER ()::integer AS total_count,
        SUM(person.registration_count) OVER ()::integer AS matching_registration_count
      FROM matching_people AS person
      ORDER BY
        CASE WHEN ${isOnlyInvitedStatusFilter(query) && (query.sortBy || "status_date") === "status_date"} THEN person.invitation_sort ELSE 0 END,
        ${personPageSort}
      LIMIT ${query.pageSize}
      OFFSET ${query.cursor}
    )
    SELECT
      page.total_count AS "totalCount",
      page.matching_registration_count AS "matchingRegistrationCount",
      guest.event_id AS "eventId",
      guest.person_id AS "personId",
      guest.luma_guest_id AS "lumaGuestId",
      guest.email,
      ${indexedGuestPhoneNumberSql()} AS "phoneNumber",
      guest.status,
      guest.luma_approval_status AS "lumaApprovalStatus",
      guest.operator_decision AS "operatorDecision",
      guest.registered_at AS "registeredAt",
      guest.invited_at AS "invitedAt",
      guest.created_at AS "createdAt",
      guest.updated_at AS "updatedAt",
      guest.approved_at AS "approvedAt",
      guest.checked_in_at AS "checkedInAt",
      guest_event.ends_at AS "eventEndsAt",
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
      latest_comment.body AS "personCrmNotes",
      latest_comment.created_at AS "personCrmNotesUpdatedAt",
      COALESCE(latest_comment.comment_count, 0)::integer AS "personCrmNoteCount"
    FROM person_page AS page
    JOIN matching_guests AS guest ON guest.person_id = page.person_id
    JOIN luma_events AS guest_event ON guest_event.event_id = guest.event_id
    JOIN luma_people AS person ON person.person_id = page.person_id
    LEFT JOIN LATERAL (
      SELECT
        comment.body,
        comment.created_at,
        COUNT(*) OVER ()::integer AS comment_count
      FROM guest_comments AS comment
      WHERE comment.person_id = person.person_id
      ORDER BY comment.created_at DESC, comment.id DESC
      LIMIT 1
    ) AS latest_comment ON TRUE
    ORDER BY
      CASE WHEN ${isOnlyInvitedStatusFilter(query) && (query.sortBy || "status_date") === "status_date"} THEN page.invitation_sort ELSE 0 END,
      ${resultPageSort},
      ${indexedGuestStatusDateSql()} ${withinPersonSortDirection} NULLS LAST,
      guest.event_id
  `);

  const rows = pageRows.map((row) => indexedGuestPageRowToRecord(row, row.eventEndsAt));
  const personIds = [...new Set(rows.map((row) => String(row.personId)))];
  const eventCountRows = personIds.length
    ? await db.$queryRaw<Array<{ personId: string; attended: number; registered: number }>>(Prisma.sql`
        SELECT
          guest.person_id AS "personId",
          COUNT(*) FILTER (WHERE guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')::integer AS attended,
          COUNT(*) FILTER (WHERE guest.status IN ('registered', 'going', 'waitlisted', 'checked_in', 'no_show'))::integer AS registered
        FROM luma_event_guests AS guest
        JOIN luma_events AS counted_event ON counted_event.event_id = guest.event_id
        WHERE guest.person_id IN (${Prisma.join(personIds)})
          AND counted_event.catalog_active = TRUE
          AND LOWER(COALESCE(counted_event.raw->>'status', '')) NOT IN ('cancelled', 'canceled')
        GROUP BY guest.person_id
      `)
    : [];
  const eventCountsByPerson = new Map(eventCountRows.map((row) => [row.personId, {
    attended: Number(row.attended) || 0,
    registered: Number(row.registered) || 0,
    history: 0,
  }]));
  const peopleById = new Map();
  const guests = rows.map((row) => {
    const person = indexedPersonToApiPerson(row.person, row);
    if (!peopleById.has(person.id)) peopleById.set(person.id, person);
    return {
      ...indexedGuestToApiGuest(row, eventCountsByPerson.get(row.personId)),
      eventId: row.eventId,
    };
  });
  const total = Number(pageRows[0]?.totalCount) || 0;
  const matchingRegistrations = Number(pageRows[0]?.matchingRegistrationCount) || 0;
  const nextCursor = query.cursor + personIds.length;

  return {
    source: "luma-index",
    eventIds: boundedEventIds,
    guests,
    people: [...peopleById.values()],
    loadedAt: new Date().toISOString(),
    indexed: true,
    pageInfo: {
      total,
      matchingRegistrations,
      pageSize: query.pageSize,
      loaded: nextCursor,
      hasMore: nextCursor < total,
      nextCursor: nextCursor < total ? String(nextCursor) : null,
    },
    query: {
      filter: query.filter,
      filters: guestQueryIncludedStatusFilters(query),
      filterMode: query.filterMode || "any",
      excludedFilters: query.excludedFilters || [],
      search: query.search,
      tags: query.tags,
      tagMode: query.tagMode || "any",
      excludedTags: query.excludedTags || [],
      sortBy: query.sortBy || "status_date",
      sortDirection: query.sortDirection || "desc",
      hasNotes: Boolean(query.hasNotes),
      attendedGreaterThan: query.attendedGreaterThan ?? null,
    },
  };
}

function indexedGuestPageSortSql(query: GuestListQuery) {
  const direction = query.sortDirection === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const countExpression = query.sortBy === "events_attended"
    ? Prisma.sql`(
          SELECT COUNT(*)::integer
          FROM luma_event_guests AS lifetime_guest
          JOIN luma_events AS lifetime_event ON lifetime_event.event_id = lifetime_guest.event_id
          WHERE lifetime_guest.person_id = guest.person_id
            AND (lifetime_guest.checked_in_at IS NOT NULL OR lifetime_guest.status = 'checked_in')
            AND lifetime_event.catalog_active = TRUE
            AND LOWER(COALESCE(lifetime_event.raw->>'status', '')) NOT IN ('cancelled', 'canceled')
      )`
    : query.sortBy === "events_registered"
      ? Prisma.sql`(
          SELECT COUNT(*)::integer
          FROM luma_event_guests AS lifetime_guest
          JOIN luma_events AS lifetime_event ON lifetime_event.event_id = lifetime_guest.event_id
          WHERE lifetime_guest.person_id = guest.person_id
            AND lifetime_guest.status IN ('registered', 'going', 'waitlisted', 'checked_in', 'no_show')
            AND lifetime_event.catalog_active = TRUE
            AND LOWER(COALESCE(lifetime_event.raw->>'status', '')) NOT IN ('cancelled', 'canceled')
        )`
      : null;
  return countExpression
    ? Prisma.sql`${countExpression} ${direction}, ${indexedGuestStatusDateSql()} DESC NULLS LAST, guest.person_id`
    : Prisma.sql`${indexedGuestStatusDateSql()} ${direction} NULLS LAST, guest.person_id`;
}

function indexedPersonPageSortSql(query: GuestListQuery, alias: "person" | "page") {
  const direction = query.sortDirection === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  if (alias === "person") {
    if (query.sortBy === "events_attended") {
      return Prisma.sql`person.events_attended ${direction}, person.latest_activity DESC NULLS LAST, person.person_id`;
    }
    if (query.sortBy === "events_registered") {
      return Prisma.sql`person.events_registered ${direction}, person.latest_activity DESC NULLS LAST, person.person_id`;
    }
    return Prisma.sql`person.latest_activity ${direction} NULLS LAST, person.person_id`;
  }
  if (query.sortBy === "events_attended") {
    return Prisma.sql`page.events_attended ${direction}, page.latest_activity DESC NULLS LAST, page.person_id`;
  }
  if (query.sortBy === "events_registered") {
    return Prisma.sql`page.events_registered ${direction}, page.latest_activity DESC NULLS LAST, page.person_id`;
  }
  return Prisma.sql`page.latest_activity ${direction} NULLS LAST, page.person_id`;
}

function indexedMultiEventGuestPageWhereSql(query: GuestListQuery) {
  const predicates: Prisma.Sql[] = [];
  appendIndexedStatusRules(predicates, query, indexedMultiEventStatusPredicateSql);

  if (query.search) {
    const searchPattern = `%${query.search}%`;
    const phoneDigits = phoneSearchDigits(query.search);
    const phonePattern = `%${phoneDigits}%`;
    predicates.push(Prisma.sql`(
      guest.search_text ILIKE ${searchPattern}
      OR guest.profile_description ILIKE ${searchPattern}
      OR guest.email ILIKE ${searchPattern}
      OR (${Boolean(phoneDigits)} AND REGEXP_REPLACE(COALESCE(guest.phone_number, ''), '[^0-9]', '', 'g') LIKE ${phonePattern})
      OR EXISTS (
        SELECT 1 FROM luma_people AS search_person
        WHERE search_person.person_id = guest.person_id
          AND (
            search_person.name ILIKE ${searchPattern}
            OR search_person.email ILIKE ${searchPattern}
            OR (${Boolean(phoneDigits)} AND REGEXP_REPLACE(COALESCE(search_person.phone_number, ''), '[^0-9]', '', 'g') LIKE ${phonePattern})
            OR search_person.title ILIKE ${searchPattern}
            OR search_person.bio ILIKE ${searchPattern}
          )
      )
      OR EXISTS (
        SELECT 1
        FROM guest_comments AS search_comment
        WHERE search_comment.person_id = guest.person_id
          AND search_comment.body ILIKE ${searchPattern}
      )
    )`);
  }

  if (query.tags.length) {
    const tagPredicates = query.tags.map((tag) => Prisma.sql`tag_person.tags @> CAST(${JSON.stringify([tag])} AS jsonb)`);
    predicates.push(Prisma.sql`EXISTS (
      SELECT 1 FROM luma_people AS tag_person
      WHERE tag_person.person_id = guest.person_id
        AND (${Prisma.join(tagPredicates, query.tagMode === "all" ? " AND " : " OR ")})
    )`);
  }
  if (query.excludedTags?.length) {
    const excludedTagPredicates = query.excludedTags.map((tag) => Prisma.sql`excluded_tag_person.tags @> CAST(${JSON.stringify([tag])} AS jsonb)`);
    predicates.push(Prisma.sql`NOT EXISTS (
      SELECT 1 FROM luma_people AS excluded_tag_person
      WHERE excluded_tag_person.person_id = guest.person_id
        AND (${Prisma.join(excludedTagPredicates, " OR ")})
    )`);
  }
  if (query.latestTagId) predicates.push(indexedLatestProfileTagPredicateSql(query.latestTagId));

  if (query.hasNotes) {
    predicates.push(Prisma.sql`EXISTS (
      SELECT 1
      FROM guest_comments AS noted_comment
      WHERE noted_comment.person_id = guest.person_id
    )`);
  }

  if (query.attendedGreaterThan != null) {
    predicates.push(Prisma.sql`(
      SELECT COUNT(*)
      FROM luma_event_guests AS attended_guest
      WHERE attended_guest.person_id = guest.person_id
        AND (attended_guest.checked_in_at IS NOT NULL OR attended_guest.status = 'checked_in')
    ) > ${query.attendedGreaterThan}`);
  }

  const answerPredicate = indexedRegistrationAnswerPredicateSql(query);
  if (answerPredicate) predicates.push(answerPredicate);

  return predicates.length ? Prisma.sql`WHERE ${Prisma.join(predicates, " AND ")}` : Prisma.empty;
}

function indexedGuestPageWhereSql(
  eventId: string,
  query: GuestListQuery,
  eventBoundary: { startsAt?: Date | null; date?: Date | null } | null,
) {
  const predicates: Prisma.Sql[] = [Prisma.sql`guest.event_id = ${eventId}`];
  appendIndexedStatusRules(
    predicates,
    query,
    (filter) => indexedEventStatusPredicateSql(filter, eventId, eventBoundary),
  );

  if (query.search) {
    const searchPattern = `%${query.search}%`;
    const phoneDigits = phoneSearchDigits(query.search);
    const phonePattern = `%${phoneDigits}%`;
    predicates.push(Prisma.sql`
      (
        guest.search_text ILIKE ${searchPattern}
        OR guest.profile_description ILIKE ${searchPattern}
        OR guest.email ILIKE ${searchPattern}
        OR (${Boolean(phoneDigits)} AND REGEXP_REPLACE(COALESCE(guest.phone_number, ''), '[^0-9]', '', 'g') LIKE ${phonePattern})
        OR EXISTS (
          SELECT 1
          FROM luma_people AS search_person
          WHERE search_person.person_id = guest.person_id
            AND (
              search_person.name ILIKE ${searchPattern}
              OR search_person.email ILIKE ${searchPattern}
              OR (${Boolean(phoneDigits)} AND REGEXP_REPLACE(COALESCE(search_person.phone_number, ''), '[^0-9]', '', 'g') LIKE ${phonePattern})
              OR search_person.title ILIKE ${searchPattern}
              OR search_person.bio ILIKE ${searchPattern}
            )
        )
        OR EXISTS (
          SELECT 1
          FROM guest_comments AS search_comment
          WHERE search_comment.person_id = guest.person_id
            AND search_comment.body ILIKE ${searchPattern}
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
          AND (${Prisma.join(tagPredicates, query.tagMode === "all" ? " AND " : " OR ")})
      )
    `);
  }
  if (query.excludedTags?.length) {
    const excludedTagPredicates = query.excludedTags.map((tag) => Prisma.sql`
      excluded_tag_person.tags @> CAST(${JSON.stringify([tag])} AS jsonb)
    `);
    predicates.push(Prisma.sql`
      NOT EXISTS (
        SELECT 1
        FROM luma_people AS excluded_tag_person
        WHERE excluded_tag_person.person_id = guest.person_id
          AND (${Prisma.join(excludedTagPredicates, " OR ")})
      )
    `);
  }
  if (query.latestTagId) predicates.push(indexedLatestProfileTagPredicateSql(query.latestTagId));

  if (query.hasNotes) {
    predicates.push(Prisma.sql`EXISTS (
      SELECT 1
      FROM guest_comments AS noted_comment
      WHERE noted_comment.person_id = guest.person_id
    )`);
  }

  if (query.attendedGreaterThan != null) {
    predicates.push(Prisma.sql`(
      SELECT COUNT(*)
      FROM luma_event_guests AS attended_guest
      WHERE attended_guest.person_id = guest.person_id
        AND (attended_guest.checked_in_at IS NOT NULL OR attended_guest.status = 'checked_in')
    ) > ${query.attendedGreaterThan}`);
  }


  const answerPredicate = indexedRegistrationAnswerPredicateSql(query);
  if (answerPredicate) predicates.push(answerPredicate);

  return Prisma.sql`WHERE ${Prisma.join(predicates, " AND ")}`;
}

function indexedLatestProfileTagPredicateSql(latestTagId: string) {
  return Prisma.sql`
    COALESCE((
      SELECT
        CASE
          WHEN definition.id IS NOT NULL THEN definition.id
          ELSE 'legacy:' || LOWER(profile_tag.name)
        END
      FROM luma_people AS latest_tag_person
      CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS_TEXT(
        CASE
          WHEN JSONB_TYPEOF(latest_tag_person.tags) = 'array' THEN latest_tag_person.tags
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS profile_tag(name, ordinality)
      LEFT JOIN guest_tags AS definition ON LOWER(definition.name) = LOWER(profile_tag.name)
      LEFT JOIN LATERAL (
        SELECT mutation.assigned_at, mutation.removed
        FROM manual_tag_mutations AS mutation
        WHERE mutation.person_id = latest_tag_person.person_id
          AND mutation.tag_id = definition.id
        ORDER BY mutation.assigned_at DESC NULLS LAST, mutation.id DESC
        LIMIT 1
      ) AS manual ON NOT manual.removed
      LEFT JOIN automatic_tag_assignments AS automatic
        ON automatic.person_id = latest_tag_person.person_id
        AND automatic.tag_id = definition.id
      WHERE latest_tag_person.person_id = guest.person_id
      ORDER BY
        GREATEST(manual.assigned_at, automatic.assigned_at) DESC NULLS LAST,
        profile_tag.ordinality DESC,
        LOWER(profile_tag.name)
      LIMIT 1
    ), 'untagged') = ${latestTagId}
  `;
}

function indexedRegistrationAnswerPredicateSql(query: GuestListQuery): Prisma.Sql | null {
  if (query.answerGroups?.length) {
    const predicates = query.answerGroups.map((group) => indexedRegistrationAnswerGroupPredicateSql(group));
    return Prisma.sql`(${Prisma.join(predicates.map((predicate) => Prisma.sql`(${predicate})`), " OR ")})`;
  }
  if (!query.answerQuestion) return null;
  return indexedRegistrationAnswerGroupPredicateSql({
    question: query.answerQuestion,
    answer: query.answer || "",
    answerKey: query.answerKey || "",
    checkedInOnly: false,
  });
}

function indexedRegistrationAnswerGroupPredicateSql(group: { question: string; answer: string; answerKey: string; checkedInOnly: boolean }): Prisma.Sql {
  const valuePredicate = group.answerKey || group.answer
    ? Prisma.sql`AND ${indexedRegistrationAnswerChoicePredicateSql(Prisma.sql`answer.item`, group.answer, group.answerKey)}`
    : Prisma.empty;
  const checkedInPredicate = group.checkedInOnly
    ? Prisma.sql`AND (guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')`
    : Prisma.empty;
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM JSONB_ARRAY_ELEMENTS(
      CASE
        WHEN JSONB_TYPEOF(guest.registration_answers) = 'array' THEN guest.registration_answers
        ELSE '[]'::jsonb
      END
    ) AS answer(item)
    WHERE LOWER(BTRIM(answer.item ->> 'label')) = LOWER(${group.question})
      AND BTRIM(answer.item ->> 'value') <> ''
      ${valuePredicate}
      ${checkedInPredicate}
  )`;
}

function appendIndexedStatusRules(
  predicates: Prisma.Sql[],
  query: GuestListQuery,
  predicateForFilter: (filter: GuestFilter) => Prisma.Sql,
) {
  const included = guestQueryIncludedStatusFilters(query).map(predicateForFilter);
  if (included.length) {
    predicates.push(included.length === 1
      ? included[0]
      : Prisma.sql`(${Prisma.join(included.map((predicate) => Prisma.sql`(${predicate})`), query.filterMode === "all" ? " AND " : " OR ")})`);
  }
  for (const predicate of (query.excludedFilters || []).filter((filter) => filter !== "all").map(predicateForFilter)) {
    predicates.push(Prisma.sql`NOT (${predicate})`);
  }
}

function indexedMultiEventStatusPredicateSql(filter: GuestFilter): Prisma.Sql {
  if (["first_registers", "accepted_first_registers", "new_faces"].includes(filter)) {
    const cohort = filter === "new_faces"
      ? Prisma.sql`guest.status = 'checked_in'`
      : filter === "first_registers"
        ? indexedRegisteredGuestPredicateSql()
        : Prisma.sql`guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)})`;
    return Prisma.sql`(
      ${cohort}
      AND NOT EXISTS (
        SELECT 1
        FROM luma_event_guests AS previous_guest
        LEFT JOIN luma_events AS previous_event ON previous_event.event_id = previous_guest.event_id
        WHERE previous_guest.person_id = guest.person_id
          AND previous_guest.event_id <> guest.event_id
          AND (
            (selected_event.starts_at IS NOT NULL AND (
              previous_event.starts_at < selected_event.starts_at
              OR (previous_event.starts_at IS NULL AND selected_event.date IS NOT NULL AND previous_event.date < selected_event.date)
            ))
            OR (selected_event.starts_at IS NULL AND selected_event.date IS NOT NULL AND previous_event.date < selected_event.date)
          )
      )
    )`;
  }
  return indexedSimpleStatusPredicateSql(filter);
}

function indexedEventStatusPredicateSql(
  filter: GuestFilter,
  eventId: string,
  eventBoundary: { startsAt?: Date | null; date?: Date | null } | null,
): Prisma.Sql {
  if (["first_registers", "accepted_first_registers", "new_faces"].includes(filter)) {
    const cohort = filter === "new_faces"
      ? Prisma.sql`guest.status = 'checked_in'`
      : filter === "first_registers"
        ? indexedRegisteredGuestPredicateSql()
        : Prisma.sql`guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)})`;
    return Prisma.sql`(
      ${cohort}
      AND NOT EXISTS (
        SELECT 1
        FROM luma_event_guests AS previous_guest
        LEFT JOIN luma_events AS previous_event
          ON previous_event.event_id = previous_guest.event_id
        WHERE previous_guest.person_id = guest.person_id
          AND previous_guest.event_id <> ${eventId}
          ${previousEventBoundarySql(eventBoundary)}
      )
    )`;
  }
  return indexedSimpleStatusPredicateSql(filter);
}

function indexedSimpleStatusPredicateSql(filter: GuestFilter): Prisma.Sql {
  if (filter === "checked_in") return Prisma.sql`(guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')`;
  if (filter === "accepted") return Prisma.sql`guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)})`;
  if (filter === "no_show") return indexedDerivedNoShowPredicateSql();
  if (filter === "to_decide") {
    return Prisma.sql`(
      guest.status = 'registered'
      OR (guest.status = 'waitlisted' AND guest.operator_decision IS DISTINCT FROM 'waitlisted')
    )`;
  }
  if (filter === "registered") return indexedRegisteredGuestPredicateSql();
  if (filter === "invited") return Prisma.sql`(guest.invited_at IS NOT NULL OR guest.status = 'invited')`;
  if (isIndexedInvitationOutcomeFilter(filter)) return indexedInvitationOutcomeFilterPredicateSql(filter);
  if (isIndexedReferralFilter(filter)) return indexedReferralFilterPredicateSql(filter);
  return Prisma.sql`guest.status = ${filter}`;
}

function indexedDerivedNoShowPredicateSql(): Prisma.Sql {
  return Prisma.sql`(
    guest.status IN ('going', 'no_show')
    AND guest.checked_in_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM luma_events AS status_event
      WHERE status_event.event_id = guest.event_id
        AND status_event.catalog_active = TRUE
        AND status_event.ends_at IS NOT NULL
        AND status_event.ends_at <= CURRENT_TIMESTAMP
        AND LOWER(COALESCE(status_event.raw->>'status', '')) NOT IN ('cancelled', 'canceled')
    )
  )`;
}

function indexedNewReferralFilterCtesSql(query: GuestListQuery) {
  const filters = guestQueryStatusFilters(query);
  if (!filters.some(isIndexedReferralFilter)) return Prisma.empty;
  return Prisma.sql`
    latest_referral_mutations AS MATERIALIZED (
      SELECT DISTINCT ON (mutation.person_id, mutation.tag_id)
        mutation.person_id,
        mutation.tag_id,
        mutation.assigned_event_id,
        mutation.removed
      FROM manual_tag_mutations AS mutation
      JOIN guest_tags AS definition ON definition.id = mutation.tag_id
      WHERE definition.semantic_key = 'referral'
      ORDER BY mutation.person_id, mutation.tag_id, mutation.assigned_at DESC NULLS LAST, mutation.id DESC
    ),
    ${filters.includes("new_referrals") ? Prisma.sql`
      first_referral_attributions AS MATERIALIZED (
        SELECT DISTINCT ON (mutation.person_id, mutation.tag_id)
          mutation.person_id,
          mutation.tag_id,
          mutation.assigned_event_id
        FROM manual_tag_mutations AS mutation
        JOIN guest_tags AS definition ON definition.id = mutation.tag_id
        WHERE definition.semantic_key = 'referral'
          AND mutation.removed = FALSE
          AND mutation.assigned_event_id IS NOT NULL
        ORDER BY mutation.person_id, mutation.tag_id, mutation.assigned_at ASC NULLS LAST, mutation.id ASC
      ),
    ` : Prisma.empty}
  `;
}

const INDEXED_INVITATION_OUTCOME_FILTERS = new Set<GuestListQuery["filter"]>([
  "invited_no_response",
  "invited_accepted",
  "invited_going",
  "invited_checked_in",
  "invited_no_show",
  "invited_declined",
]);

const INDEXED_REFERRAL_FILTERS = new Set<GuestListQuery["filter"]>([
  "referrals",
  "new_referrals",
  "invited_referrals",
  "invited_referral_no_response",
  "invited_referral_accepted",
  "invited_referral_declined",
]);

function isIndexedInvitationOutcomeFilter(filter: GuestListQuery["filter"]) {
  return INDEXED_INVITATION_OUTCOME_FILTERS.has(filter);
}

function isIndexedReferralFilter(filter: GuestListQuery["filter"]) {
  return INDEXED_REFERRAL_FILTERS.has(filter);
}

function indexedInvitationOutcomeFilterPredicateSql(filter: GuestListQuery["filter"]) {
  if (filter === "invited_no_response") return Prisma.sql`guest.status = 'invited'`;
  if (filter === "invited_accepted") {
    return Prisma.sql`(
      ${indexedInvitationEvidencePredicateSql()}
      AND (guest.checked_in_at IS NOT NULL OR guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)}))
    )`;
  }
  if (filter === "invited_going") {
    return Prisma.sql`(
      ${indexedInvitationEvidencePredicateSql()}
      AND guest.status = 'going'
      AND NOT ${indexedDerivedNoShowPredicateSql()}
    )`;
  }
  if (filter === "invited_checked_in") {
    return Prisma.sql`(
      ${indexedInvitationEvidencePredicateSql()}
      AND (guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')
    )`;
  }
  if (filter === "invited_no_show") {
    return Prisma.sql`(${indexedInvitationEvidencePredicateSql()} AND ${indexedDerivedNoShowPredicateSql()})`;
  }
  return Prisma.sql`(${indexedInvitationEvidencePredicateSql()} AND guest.status = 'declined')`;
}

function indexedReferralFilterPredicateSql(filter: GuestListQuery["filter"]) {
  const cohortPredicate = filter === "referrals" || filter === "new_referrals"
    ? Prisma.sql`(guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')`
    : filter === "invited_referrals"
      ? indexedInvitationEvidencePredicateSql()
      : filter === "invited_referral_no_response"
        ? Prisma.sql`guest.status = 'invited'`
        : filter === "invited_referral_accepted"
          ? Prisma.sql`(
              ${indexedInvitationEvidencePredicateSql()}
              AND (guest.checked_in_at IS NOT NULL OR guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)}))
            )`
          : Prisma.sql`(${indexedInvitationEvidencePredicateSql()} AND guest.status = 'declined')`;
  return Prisma.sql`
    ${cohortPredicate}
    AND EXISTS (
      SELECT 1
      FROM latest_referral_mutations AS referral
      WHERE referral.person_id = guest.person_id
        AND referral.removed = FALSE
    )
    ${filter === "new_referrals" ? Prisma.sql`
      AND EXISTS (
        SELECT 1
        FROM first_referral_attributions AS referral
        WHERE referral.person_id = guest.person_id
          AND referral.assigned_event_id = guest.event_id
      )
    ` : Prisma.empty}
  `;
}

function indexedGuestPageRowToRecord(row: IndexedGuestPageRow, eventEndsAt: Date | null | undefined = row.eventEndsAt) {
  return {
    eventId: row.eventId,
    personId: row.personId,
    lumaGuestId: row.lumaGuestId,
    email: row.email,
    phoneNumber: row.phoneNumber,
    status: guestStatusAfterEvent(row, { endsAt: eventEndsAt }),
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
      crmNoteCount: Number(row.personCrmNoteCount) || 0,
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
    JOIN luma_events AS counted_event ON counted_event.event_id = guest.event_id
    WHERE guest.person_id IN (${Prisma.join(boundedPersonIds)})
      AND counted_event.catalog_active = TRUE
      AND LOWER(COALESCE(counted_event.raw->>'status', '')) NOT IN ('cancelled', 'canceled')
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
  knownEventBoundary?: { startsAt: Date | null; endsAt?: Date | null; date: Date | null } | null,
) {
  const db = prisma();
  // EVENT_SWITCH_DIAGNOSTICS: analytics is timed independently from guest-page loading.
  let diagnosticStartedAt = Date.now();
  const eventBoundary = knownEventBoundary || await db.lumaEvent.findUnique({
    where: { eventId },
    select: { startsAt: true, endsAt: true, date: true },
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

export async function getIndexedMultiEventStats(eventIds: string[]) {
  const boundedEventIds = [...new Set(eventIds.filter(Boolean))].slice(0, MAX_SELECTED_EVENT_IDS);
  if (!boundedEventIds.length) return null;
  const db = prisma();
  const uncachedEvents = await db.lumaEvent.findMany({
    where: {
      eventId: { in: boundedEventIds },
      overviewStatsUpdatedAt: null,
    },
    select: { eventId: true },
  });
  if (uncachedEvents.length) {
    await refreshIndexedEventOverviewStats(uncachedEvents.map((event) => event.eventId));
  }
  const rows = await db.$queryRaw<Array<{
    eventCount: number;
    total: number;
    checkedIn: number;
    accepted: number;
    registered: number;
    pending: number;
    declined: number;
    invited: number;
    waitlisted: number;
    toDecide: number;
    firstRegisters: number;
    newRegistrations: number;
    newFaces: number;
    referredRegistrations: number;
    newReferrals: number;
    referredAccepted: number;
    referredCheckedIn: number;
    referredFirstRegisters: number;
    referredReturning: number;
    invitationTotal: number;
    invitedGoing: number;
    invitedCheckedIn: number;
    invitedNoShow: number;
    invitedNoResponse: number;
    invitedDeclined: number;
    invitedReferralTotal: number;
    invitedReferralGoing: number;
    invitedReferralCheckedIn: number;
    invitedReferralNoShow: number;
    invitedReferralNoResponse: number;
    invitedReferralDeclined: number;
  }>>(Prisma.sql`
    WITH selected_events AS MATERIALIZED (
      SELECT event_id, starts_at, date
      FROM luma_events
      WHERE event_id IN (${Prisma.join(boundedEventIds)})
    ),
    guest_cohort AS MATERIALIZED (
      SELECT guest.*
      FROM luma_event_guests AS guest
      JOIN selected_events AS selected_event ON selected_event.event_id = guest.event_id
    )
    SELECT
      (SELECT COUNT(*)::integer FROM selected_events) AS "eventCount",
      COUNT(DISTINCT guest.person_id)::integer AS total,
      COUNT(DISTINCT guest.person_id) FILTER (WHERE guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')::integer AS "checkedIn",
      COUNT(DISTINCT guest.person_id) FILTER (WHERE guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)}))::integer AS accepted,
      COUNT(DISTINCT guest.person_id) FILTER (WHERE ${indexedRegisteredGuestPredicateSql()})::integer AS registered,
      COUNT(DISTINCT guest.person_id) FILTER (WHERE guest.status = 'registered')::integer AS pending,
      COUNT(DISTINCT guest.person_id) FILTER (WHERE guest.status = 'declined')::integer AS declined,
      COUNT(DISTINCT guest.person_id) FILTER (WHERE guest.invited_at IS NOT NULL OR guest.status = 'invited')::integer AS invited,
      COUNT(*) FILTER (WHERE ${indexedInvitationEvidencePredicateSql()})::integer AS "invitationTotal",
      COUNT(*) FILTER (
        WHERE ${indexedInvitationEvidencePredicateSql()} AND guest.status = 'going' AND NOT ${indexedDerivedNoShowPredicateSql()}
      )::integer AS "invitedGoing",
      COUNT(*) FILTER (
        WHERE ${indexedInvitationEvidencePredicateSql()}
          AND (guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')
      )::integer AS "invitedCheckedIn",
      COUNT(*) FILTER (
        WHERE ${indexedInvitationEvidencePredicateSql()} AND ${indexedDerivedNoShowPredicateSql()}
      )::integer AS "invitedNoShow",
      COUNT(*) FILTER (WHERE guest.status = 'invited')::integer AS "invitedNoResponse",
      COUNT(*) FILTER (
        WHERE ${indexedInvitationEvidencePredicateSql()} AND guest.status = 'declined'
      )::integer AS "invitedDeclined",
      COUNT(*) FILTER (
        WHERE guest.is_referred AND (guest.invited_at IS NOT NULL OR guest.status = 'invited')
      )::integer AS "invitedReferralTotal",
      COUNT(*) FILTER (
        WHERE guest.is_referred
          AND ${indexedInvitationEvidencePredicateSql()}
          AND guest.status = 'going'
          AND NOT ${indexedDerivedNoShowPredicateSql()}
      )::integer AS "invitedReferralGoing",
      COUNT(*) FILTER (
        WHERE guest.is_referred
          AND ${indexedInvitationEvidencePredicateSql()}
          AND (guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')
      )::integer AS "invitedReferralCheckedIn",
      COUNT(*) FILTER (
        WHERE guest.is_referred
          AND ${indexedInvitationEvidencePredicateSql()}
          AND ${indexedDerivedNoShowPredicateSql()}
      )::integer AS "invitedReferralNoShow",
      COUNT(*) FILTER (
        WHERE guest.is_referred AND guest.status = 'invited'
      )::integer AS "invitedReferralNoResponse",
      COUNT(*) FILTER (
        WHERE guest.is_referred
          AND ${indexedInvitationEvidencePredicateSql()}
          AND guest.status = 'declined'
      )::integer AS "invitedReferralDeclined",
      COUNT(DISTINCT guest.person_id) FILTER (WHERE guest.status = 'waitlisted')::integer AS waitlisted,
      COUNT(DISTINCT guest.person_id) FILTER (
        WHERE guest.status = 'registered'
          OR (guest.status = 'waitlisted' AND guest.operator_decision IS DISTINCT FROM 'waitlisted')
      )::integer AS "toDecide",
      COUNT(DISTINCT guest.person_id) FILTER (
        WHERE guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)}) AND NOT guest.has_prior_event
      )::integer AS "firstRegisters",
      COUNT(DISTINCT guest.person_id) FILTER (
        WHERE ${indexedRegisteredGuestPredicateSql()} AND NOT guest.has_prior_event
      )::integer AS "newRegistrations",
      COUNT(DISTINCT guest.person_id) FILTER (
        WHERE (guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in') AND NOT guest.has_prior_event
      )::integer AS "newFaces",
      COUNT(DISTINCT guest.person_id) FILTER (
        WHERE guest.is_referred AND ${indexedRegisteredGuestPredicateSql()}
      )::integer AS "referredRegistrations",
      COUNT(DISTINCT guest.person_id) FILTER (
        WHERE guest.is_referred
          AND guest.is_new_referral
          AND (guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')
      )::integer AS "newReferrals",
      COUNT(DISTINCT guest.person_id) FILTER (
        WHERE guest.is_referred AND guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)})
      )::integer AS "referredAccepted",
      COUNT(DISTINCT guest.person_id) FILTER (
        WHERE guest.is_referred AND (guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')
      )::integer AS "referredCheckedIn",
      COUNT(DISTINCT guest.person_id) FILTER (
        WHERE guest.is_referred AND guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)}) AND NOT guest.has_prior_event
      )::integer AS "referredFirstRegisters",
      COUNT(DISTINCT guest.person_id) FILTER (
        WHERE guest.is_referred AND guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)}) AND guest.has_prior_event
      )::integer AS "referredReturning"
    FROM guest_cohort AS guest
  `);
  const tagDistribution = await db.$queryRaw<Array<{ id: string; label: string; color: string; count: number }>>(Prisma.sql`
    WITH attendees AS MATERIALIZED (
      SELECT DISTINCT guest.person_id
      FROM luma_event_guests AS guest
      WHERE guest.event_id IN (${Prisma.join(boundedEventIds)})
        AND (guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')
    ),
    latest_manual_state AS MATERIALIZED (
      SELECT DISTINCT ON (mutation.person_id, mutation.tag_id)
        mutation.person_id,
        mutation.tag_id,
        mutation.assigned_at,
        mutation.removed
      FROM manual_tag_mutations AS mutation
      JOIN attendees ON attendees.person_id = mutation.person_id
      ORDER BY mutation.person_id, mutation.tag_id, mutation.assigned_at DESC NULLS LAST, mutation.id DESC
    ),
    profile_tags AS MATERIALIZED (
      SELECT
        attendee.person_id,
        profile_tag.name,
        profile_tag.ordinality,
        definition.id,
        definition.color,
        GREATEST(manual.assigned_at, automatic.assigned_at) AS assigned_at
      FROM attendees AS attendee
      JOIN luma_people AS person ON person.person_id = attendee.person_id
      CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS_TEXT(
        CASE WHEN JSONB_TYPEOF(person.tags) = 'array' THEN person.tags ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS profile_tag(name, ordinality)
      LEFT JOIN guest_tags AS definition ON LOWER(definition.name) = LOWER(profile_tag.name)
      LEFT JOIN latest_manual_state AS manual
        ON manual.person_id = attendee.person_id
        AND manual.tag_id = definition.id
        AND NOT manual.removed
      LEFT JOIN automatic_tag_assignments AS automatic
        ON automatic.person_id = attendee.person_id
        AND automatic.tag_id = definition.id
    ),
    latest_profile_tag AS (
      SELECT person_id, id, name, color
      FROM (
        SELECT
          profile_tags.*,
          ROW_NUMBER() OVER (
            PARTITION BY profile_tags.person_id
            ORDER BY profile_tags.assigned_at DESC NULLS LAST, profile_tags.ordinality DESC, LOWER(profile_tags.name)
          ) AS rank
        FROM profile_tags
      ) AS ranked
      WHERE rank = 1
    ),
    attendee_tags AS (
      SELECT
        attendee.person_id,
        CASE
          WHEN latest_profile_tag.name IS NULL THEN 'untagged'
          ELSE COALESCE(latest_profile_tag.id, 'legacy:' || LOWER(latest_profile_tag.name))
        END AS id,
        COALESCE(latest_profile_tag.name, 'Untagged') AS label,
        COALESCE(latest_profile_tag.color, '#706f69') AS color
      FROM attendees AS attendee
      LEFT JOIN latest_profile_tag ON latest_profile_tag.person_id = attendee.person_id
    )
    SELECT id, label, color, COUNT(*)::integer AS count
    FROM attendee_tags
    GROUP BY id, label, color
    ORDER BY count DESC, LOWER(label), id
  `);
  const stats = rows[0] || {
    eventCount: 0,
    total: 0,
    checkedIn: 0,
    accepted: 0,
    registered: 0,
    pending: 0,
    declined: 0,
    invited: 0,
    waitlisted: 0,
    toDecide: 0,
    firstRegisters: 0,
    newRegistrations: 0,
    newFaces: 0,
    referredRegistrations: 0,
    newReferrals: 0,
    referredAccepted: 0,
    referredCheckedIn: 0,
    referredFirstRegisters: 0,
    referredReturning: 0,
    invitationTotal: 0,
    invitedGoing: 0,
    invitedCheckedIn: 0,
    invitedNoShow: 0,
    invitedNoResponse: 0,
    invitedDeclined: 0,
    invitedReferralTotal: 0,
    invitedReferralGoing: 0,
    invitedReferralCheckedIn: 0,
    invitedReferralNoShow: 0,
    invitedReferralNoResponse: 0,
    invitedReferralDeclined: 0,
  };
  return {
    source: "luma-index",
    eventIds: boundedEventIds,
    uniquePeople: true,
    stats: { ...stats, tagDistribution },
  };
}

export async function listIndexedAnalyticsRespondents(query: AnalyticsRespondentQuery) {
  const eventIds = [...new Set(query.eventIds.filter(Boolean))].slice(0, MAX_SELECTED_EVENT_IDS);
  if (!eventIds.length || !query.question) {
    return {
      source: "luma-index",
      question: query.question,
      answer: query.answer,
      respondents: [],
      pageInfo: { total: 0, pageSize: query.pageSize, hasMore: false, nextCursor: null },
    };
  }

  const answerFilter = query.answerKey || query.answer
    ? Prisma.sql`AND ${indexedRegistrationAnswerChoicePredicateSql(Prisma.sql`response.item`, query.answer, query.answerKey)}`
    : Prisma.empty;
  const pageRows = await prisma().$queryRaw<Array<{
    personId: string;
    eventId: string;
    eventTitle: string;
    responseValue: string;
    responseAt: Date | null;
    totalCount: number;
  }>>(Prisma.sql`
    WITH selected_events AS MATERIALIZED (
      SELECT event_id, title, starts_at, date
      FROM luma_events
      WHERE event_id IN (${Prisma.join(eventIds)})
    ),
    matching_responses AS MATERIALIZED (
      SELECT
        guest.person_id,
        guest.event_id,
        selected_event.title AS event_title,
        BTRIM(response.item ->> 'value') AS response_value,
        COALESCE(guest.registered_at, guest.created_at, guest.last_seen_at) AS response_at
      FROM luma_event_guests AS guest
      JOIN selected_events AS selected_event ON selected_event.event_id = guest.event_id
      CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(
        CASE
          WHEN JSONB_TYPEOF(guest.registration_answers) = 'array' THEN guest.registration_answers
          ELSE '[]'::jsonb
        END
      ) AS response(item)
      WHERE guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)})
        AND LOWER(BTRIM(response.item ->> 'label')) = LOWER(${query.question})
        AND BTRIM(response.item ->> 'value') <> ''
        ${answerFilter}
        AND NOT EXISTS (
          SELECT 1
          FROM luma_event_guests AS previous_guest
          LEFT JOIN luma_events AS previous_event ON previous_event.event_id = previous_guest.event_id
          WHERE previous_guest.person_id = guest.person_id
            AND previous_guest.event_id <> guest.event_id
            AND (
              (selected_event.starts_at IS NOT NULL AND (
                previous_event.starts_at < selected_event.starts_at
                OR (
                  previous_event.starts_at IS NULL
                  AND selected_event.date IS NOT NULL
                  AND previous_event.date < selected_event.date
                )
              ))
              OR (
                selected_event.starts_at IS NULL
                AND selected_event.date IS NOT NULL
                AND previous_event.date < selected_event.date
              )
            )
        )
    ),
    unique_people AS MATERIALIZED (
      SELECT DISTINCT ON (person_id)
        person_id,
        event_id,
        event_title,
        response_value,
        response_at
      FROM matching_responses
      ORDER BY person_id, response_at DESC NULLS LAST, event_id
    )
    SELECT
      person_id AS "personId",
      event_id AS "eventId",
      event_title AS "eventTitle",
      response_value AS "responseValue",
      response_at AS "responseAt",
      COUNT(*) OVER()::integer AS "totalCount"
    FROM unique_people
    ORDER BY response_at DESC NULLS LAST, person_id
    LIMIT ${query.pageSize}
    OFFSET ${query.cursor}
  `);

  const personIds = pageRows.map((row) => row.personId);
  const people = personIds.length
    ? await prisma().lumaPerson.findMany({
        where: { personId: { in: personIds } },
        select: INDEXED_PERSON_SELECT,
      })
    : [];
  const peopleById = new Map(people.map((person) => [person.personId, indexedPersonToApiPerson(person)]));
  const respondents = pageRows.flatMap((row) => {
    const person = peopleById.get(row.personId);
    return person ? [{
      person,
      eventId: row.eventId,
      eventTitle: row.eventTitle,
      response: row.responseValue,
      respondedAt: isoOrNull(row.responseAt),
    }] : [];
  });
  const total = Number(pageRows[0]?.totalCount) || 0;
  const nextCursor = query.cursor + respondents.length;

  return {
    source: "luma-index",
    question: query.question,
    answer: query.answer,
    respondents,
    pageInfo: {
      total,
      pageSize: query.pageSize,
      hasMore: nextCursor < total,
      nextCursor: nextCursor < total ? String(nextCursor) : null,
    },
  };
}

async function indexedEventAnalytics(
  db: PrismaClient,
  eventId: string,
  eventBoundary: { startsAt: Date | null; date: Date | null },
  firstRegisterWhere: Record<string, any> | null,
  diagnosticReporter?: EventSwitchDiagnosticReporter,
) {
  const diagnosticStartedAt = Date.now();
  const analyticsQuestionLimit = safeInt("LUMA_ANALYTICS_MAX_NEW_FACES", 1000, 1, 5000);
  const [summaryRows, analyticsQuestionRows, analyticsAllQuestionRows, tagDistributionRows] = await db.$transaction([
    db.$queryRaw<Array<{ total: number; checkedIn: number; accepted: number; registered: number; pending: number; declined: number; invited: number; waitlisted: number; toDecide: number; firstRegisters: number; newRegistrations: number; newFaces: number; referredRegistrations: number; newReferrals: number; referredAccepted: number; referredCheckedIn: number; referredFirstRegisters: number; referredReturning: number; invitationTotal: number; invitedGoing: number; invitedCheckedIn: number; invitedNoShow: number; invitedNoResponse: number; invitedDeclined: number; invitedReferralTotal: number; invitedReferralGoing: number; invitedReferralCheckedIn: number; invitedReferralNoShow: number; invitedReferralNoResponse: number; invitedReferralDeclined: number }>>(Prisma.sql`
      WITH guest_cohort AS MATERIALIZED (
        SELECT guest.*
        FROM luma_event_guests AS guest
        WHERE guest.event_id = ${eventId}
      )
      SELECT
        COUNT(*)::integer AS total,
        COUNT(*) FILTER (WHERE guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')::integer AS "checkedIn",
        COUNT(*) FILTER (WHERE guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)}))::integer AS accepted,
        COUNT(*) FILTER (WHERE ${indexedRegisteredGuestPredicateSql()})::integer AS registered,
        COUNT(*) FILTER (WHERE guest.status = 'registered')::integer AS pending,
        COUNT(*) FILTER (WHERE guest.status = 'declined')::integer AS declined,
        COUNT(*) FILTER (WHERE guest.invited_at IS NOT NULL OR guest.status = 'invited')::integer AS invited,
        COUNT(*) FILTER (WHERE ${indexedInvitationEvidencePredicateSql()})::integer AS "invitationTotal",
        COUNT(*) FILTER (
          WHERE ${indexedInvitationEvidencePredicateSql()} AND guest.status = 'going' AND NOT ${indexedDerivedNoShowPredicateSql()}
        )::integer AS "invitedGoing",
        COUNT(*) FILTER (
          WHERE ${indexedInvitationEvidencePredicateSql()}
            AND (guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')
        )::integer AS "invitedCheckedIn",
        COUNT(*) FILTER (
          WHERE ${indexedInvitationEvidencePredicateSql()} AND ${indexedDerivedNoShowPredicateSql()}
        )::integer AS "invitedNoShow",
        COUNT(*) FILTER (WHERE guest.status = 'invited')::integer AS "invitedNoResponse",
        COUNT(*) FILTER (
          WHERE ${indexedInvitationEvidencePredicateSql()} AND guest.status = 'declined'
        )::integer AS "invitedDeclined",
        COUNT(*) FILTER (
          WHERE guest.is_referred AND (guest.invited_at IS NOT NULL OR guest.status = 'invited')
        )::integer AS "invitedReferralTotal",
        COUNT(*) FILTER (
          WHERE guest.is_referred
            AND ${indexedInvitationEvidencePredicateSql()}
            AND guest.status = 'going'
            AND NOT ${indexedDerivedNoShowPredicateSql()}
        )::integer AS "invitedReferralGoing",
        COUNT(*) FILTER (
          WHERE guest.is_referred
            AND ${indexedInvitationEvidencePredicateSql()}
            AND (guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')
        )::integer AS "invitedReferralCheckedIn",
        COUNT(*) FILTER (
          WHERE guest.is_referred
            AND ${indexedInvitationEvidencePredicateSql()}
            AND ${indexedDerivedNoShowPredicateSql()}
        )::integer AS "invitedReferralNoShow",
        COUNT(*) FILTER (
          WHERE guest.is_referred AND guest.status = 'invited'
        )::integer AS "invitedReferralNoResponse",
        COUNT(*) FILTER (
          WHERE guest.is_referred
            AND ${indexedInvitationEvidencePredicateSql()}
            AND guest.status = 'declined'
        )::integer AS "invitedReferralDeclined",
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
          WHERE ${indexedRegisteredGuestPredicateSql()}
            AND NOT guest.has_prior_event
        )::integer AS "newRegistrations",
        COUNT(*) FILTER (
          WHERE guest.status = 'checked_in'
            AND NOT guest.has_prior_event
        )::integer AS "newFaces",
        COUNT(*) FILTER (
          WHERE guest.is_referred
            AND ${indexedRegisteredGuestPredicateSql()}
        )::integer AS "referredRegistrations",
        COUNT(*) FILTER (
          WHERE guest.is_referred
            AND guest.is_new_referral
            AND (guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')
        )::integer AS "newReferrals",
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
      select: { personId: true, registrationAnswers: true, checkedInAt: true, status: true },
      take: analyticsQuestionLimit,
      orderBy: [{ registeredAt: "desc" }, { createdAt: "desc" }, { lastSeenAt: "desc" }],
    }),
    db.lumaEventGuest.findMany({
      where: {
        eventId,
        OR: [
          { status: { in: [...GUEST_REGISTERED_STATUSES] } },
          { status: "declined", registeredAt: { not: null } },
        ],
      },
      select: { personId: true, registrationAnswers: true, checkedInAt: true, status: true },
      take: analyticsQuestionLimit,
      orderBy: [{ registeredAt: "desc" }, { createdAt: "desc" }, { lastSeenAt: "desc" }],
    }),
    db.$queryRaw<Array<{ id: string; label: string; color: string; count: number }>>(Prisma.sql`
      WITH attendees AS MATERIALIZED (
        SELECT DISTINCT guest.person_id
        FROM luma_event_guests AS guest
        WHERE guest.event_id = ${eventId}
          AND (guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')
      ),
      latest_manual_state AS MATERIALIZED (
        SELECT DISTINCT ON (mutation.person_id, mutation.tag_id)
          mutation.person_id,
          mutation.tag_id,
          mutation.assigned_at,
          mutation.removed
        FROM manual_tag_mutations AS mutation
        JOIN attendees ON attendees.person_id = mutation.person_id
        ORDER BY mutation.person_id, mutation.tag_id, mutation.assigned_at DESC NULLS LAST, mutation.id DESC
      ),
      profile_tags AS MATERIALIZED (
        SELECT
          attendee.person_id,
          profile_tag.name,
          profile_tag.ordinality,
          definition.id,
          definition.color,
          GREATEST(manual.assigned_at, automatic.assigned_at) AS assigned_at
        FROM attendees AS attendee
        JOIN luma_people AS person ON person.person_id = attendee.person_id
        CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS_TEXT(
          CASE WHEN JSONB_TYPEOF(person.tags) = 'array' THEN person.tags ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS profile_tag(name, ordinality)
        LEFT JOIN guest_tags AS definition ON LOWER(definition.name) = LOWER(profile_tag.name)
        LEFT JOIN latest_manual_state AS manual
          ON manual.person_id = attendee.person_id
          AND manual.tag_id = definition.id
          AND NOT manual.removed
        LEFT JOIN automatic_tag_assignments AS automatic
          ON automatic.person_id = attendee.person_id
          AND automatic.tag_id = definition.id
      ),
      latest_profile_tag AS (
        SELECT person_id, id, name, color
        FROM (
          SELECT
            profile_tags.*,
            ROW_NUMBER() OVER (
              PARTITION BY profile_tags.person_id
              ORDER BY profile_tags.assigned_at DESC NULLS LAST, profile_tags.ordinality DESC, LOWER(profile_tags.name)
            ) AS rank
          FROM profile_tags
        ) AS ranked
        WHERE rank = 1
      ),
      attendee_tags AS (
        SELECT
          attendee.person_id,
          CASE
            WHEN latest_profile_tag.name IS NULL THEN 'untagged'
            ELSE COALESCE(latest_profile_tag.id, 'legacy:' || LOWER(latest_profile_tag.name))
          END AS id,
          COALESCE(latest_profile_tag.name, 'Untagged') AS label,
          COALESCE(latest_profile_tag.color, '#706f69') AS color
        FROM attendees AS attendee
        LEFT JOIN latest_profile_tag ON latest_profile_tag.person_id = attendee.person_id
      )
      SELECT id, label, color, COUNT(*)::integer AS count
      FROM attendee_tags
      GROUP BY id, label, color
      ORDER BY count DESC, LOWER(label), id
    `),
  ]);
  diagnosticReporter?.("analytics_queries", Date.now() - diagnosticStartedAt, {
    answerRowCount: analyticsQuestionRows.length,
    allAnswerRowCount: analyticsAllQuestionRows.length,
    tagCount: tagDistributionRows.length,
  });
  return {
    stats: summaryRows[0] || { total: 0, checkedIn: 0, accepted: 0, registered: 0, pending: 0, declined: 0, invited: 0, waitlisted: 0, toDecide: 0, firstRegisters: 0, newRegistrations: 0, newFaces: 0, referredRegistrations: 0, newReferrals: 0, referredAccepted: 0, referredCheckedIn: 0, referredFirstRegisters: 0, referredReturning: 0, invitationTotal: 0, invitedGoing: 0, invitedCheckedIn: 0, invitedNoShow: 0, invitedNoResponse: 0, invitedDeclined: 0, invitedReferralTotal: 0, invitedReferralGoing: 0, invitedReferralCheckedIn: 0, invitedReferralNoShow: 0, invitedReferralNoResponse: 0, invitedReferralDeclined: 0 },
    analyticsQuestions: buildRegistrationQuestionAnalytics(analyticsQuestionRows),
    analyticsAllQuestions: buildRegistrationQuestionAnalytics(analyticsAllQuestionRows),
    tagDistribution: tagDistributionRows,
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
        WHERE (guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')
          AND history_event.catalog_active = TRUE
          AND LOWER(COALESCE(history_event.raw->>'status', '')) NOT IN ('cancelled', 'canceled')
      )::integer AS attended,
      COUNT(*) FILTER (
        WHERE guest.status IN ('registered', 'going', 'waitlisted', 'checked_in', 'no_show')
          AND history_event.catalog_active = TRUE
          AND LOWER(COALESCE(history_event.raw->>'status', '')) NOT IN ('cancelled', 'canceled')
      )::integer AS registered,
      COUNT(*) FILTER (
        WHERE guest.event_id <> ${eventId}
          AND history_event.catalog_active = TRUE
          AND LOWER(COALESCE(history_event.raw->>'status', '')) NOT IN ('cancelled', 'canceled')
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
  return prisma().$queryRaw<Array<{ id: string; name: string; color: string; managed: boolean; ruleKey: string | null; semanticKey: string | null }>>(Prisma.sql`
    WITH person_tags AS (
      SELECT MIN(tag_value) AS name
      FROM luma_people
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(tags) = 'array' THEN tags ELSE '[]'::jsonb END
      ) AS tag_values(tag_value)
      WHERE LENGTH(TRIM(tag_value)) > 0
      GROUP BY LOWER(tag_value)
    )
    SELECT tag.id, tag.name, tag.color, tag.managed, tag.rule_key AS "ruleKey", tag.semantic_key AS "semanticKey"
    FROM guest_tags AS tag
    UNION ALL
    SELECT MD5(LOWER(person_tag.name)) AS id, person_tag.name, ${DEFAULT_TAG_COLOR} AS color, FALSE AS managed, NULL::text AS "ruleKey", NULL::text AS "semanticKey"
    FROM person_tags AS person_tag
    WHERE NOT EXISTS (
      SELECT 1 FROM guest_tags AS tag WHERE LOWER(tag.name) = LOWER(person_tag.name)
    )
    ORDER BY name
    LIMIT 500
  `);
}

export async function listIndexedSuperTags() {
  return prisma().$queryRaw<Array<{
    id: string;
    name: string;
    color: string;
    rules: Array<{ source: "tag_exact" | "tag" | "event"; phrase: string }>;
  }>>(Prisma.sql`
    SELECT
      super_tag.id,
      super_tag.name,
      super_tag.color,
      COALESCE(
        JSONB_AGG(
          JSONB_BUILD_OBJECT('source', rule.source, 'phrase', rule.phrase)
          ORDER BY rule.id
        ) FILTER (WHERE rule.id IS NOT NULL),
        '[]'::jsonb
      ) AS rules
    FROM super_tags AS super_tag
    LEFT JOIN super_tag_rules AS rule ON rule.super_tag_id = super_tag.id
    GROUP BY super_tag.id
    ORDER BY super_tag.name
  `);
}

function normalizeSuperTagRules(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((rule) => {
    const source = ["tag_exact", "tag", "event"].includes(rule?.source) ? rule.source : "";
    const phrase = typeof rule?.phrase === "string" ? rule.phrase.trim().replace(/\s+/g, " ").slice(0, 80) : "";
    const key = `${source}:${phrase.toLocaleLowerCase()}`;
    if (!source || phrase.length < 2 || seen.has(key)) return [];
    seen.add(key);
    return [{ source, phrase }];
  }).slice(0, 20);
}

export async function syncIndexedSuperTags(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) {
    const error = new Error("Provide up to 100 supertags.") as HttpError;
    error.status = 400;
    throw error;
  }
  const items = value.map((item) => {
    const id = typeof item?.id === "string" && item.id.trim() && !item.id.startsWith("new-") ? item.id.trim().slice(0, 120) : randomUUID();
    const name = normalizeTagName(item?.name);
    const color = normalizeTagColor(item?.color || "#38bdf8");
    const rules = normalizeSuperTagRules(item?.rules);
    if (!rules.length) {
      const error = new Error(`${name} needs at least one tag-name or event-name phrase.`) as HttpError;
      error.status = 400;
      throw error;
    }
    return { id, name, color, rules };
  });
  const names = new Set<string>();
  for (const item of items) {
    const key = item.name.toLocaleLowerCase();
    if (names.has(key)) {
      const error = new Error("Supertag names must be unique.") as HttpError;
      error.status = 409;
      throw error;
    }
    names.add(key);
  }

  await prisma().$transaction(async (db: Prisma.TransactionClient) => {
    const ids = items.map((item) => item.id);
    if (ids.length) {
      await db.$executeRaw(Prisma.sql`DELETE FROM super_tags WHERE id NOT IN (${Prisma.join(ids)})`);
    } else {
      await db.$executeRaw(Prisma.sql`DELETE FROM super_tags`);
    }
    for (const item of items) {
      await db.$executeRaw(Prisma.sql`
        INSERT INTO super_tags (id, name, color, updated_at)
        VALUES (${item.id}, ${item.name}, ${item.color}, NOW())
        ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name, color = EXCLUDED.color, updated_at = NOW()
      `);
      await db.$executeRaw(Prisma.sql`DELETE FROM super_tag_rules WHERE super_tag_id = ${item.id}`);
      for (const rule of item.rules) {
        await db.$executeRaw(Prisma.sql`
          INSERT INTO super_tag_rules (super_tag_id, source, phrase)
          VALUES (${item.id}, ${rule.source}, ${rule.phrase})
        `);
      }
    }
  });
  invalidateAudienceTagGroupCache();
  return listIndexedSuperTags();
}

export async function createIndexedTagDefinition(value: { name?: unknown; color?: unknown }) {
  const id = randomUUID();
  const name = normalizeTagName(value.name);
  const color = normalizeTagColor(value.color);
  const semanticKey = name.toLocaleLowerCase() === REFERRED_PERSON_TAG.toLocaleLowerCase() ? "referral" : null;
  const rows = await prisma().$queryRaw<Array<{ id: string; name: string; color: string; managed: boolean; ruleKey: string | null; semanticKey: string | null }>>(Prisma.sql`
    INSERT INTO guest_tags (id, name, color, semantic_key, updated_at)
    VALUES (${id}, ${name}, ${color}, ${semanticKey}, NOW())
    ON CONFLICT DO NOTHING
    RETURNING id, name, color, managed, rule_key AS "ruleKey", semantic_key AS "semanticKey"
  `);
  if (rows[0]) {
    invalidateAudienceTagGroupCache();
    return rows[0];
  }
  const existing = await prisma().$queryRaw<Array<{ id: string; name: string; color: string; managed: boolean; ruleKey: string | null; semanticKey: string | null }>>(Prisma.sql`
    SELECT id, name, color, managed, rule_key AS "ruleKey", semantic_key AS "semanticKey" FROM guest_tags WHERE LOWER(name) = LOWER(${name}) LIMIT 1
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
  const result = await prisma().$transaction(async (db: Prisma.TransactionClient) => {
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
  invalidateAudienceTagGroupCache();
  return result;
}

type IndexedPersonTagMutationResult = {
  personId: string;
  tags: Prisma.JsonValue;
  manualTags: Prisma.JsonValue;
  automaticTags: Prisma.JsonValue;
};

export async function mutateIndexedPeopleTags({
  people,
  tagIds,
  removed,
}: {
  people: Array<{ personId: string; eventId: string | null }>;
  tagIds: string[];
  removed: boolean;
}) {
  const result = await prisma().$transaction(async (db: Prisma.TransactionClient) => {
    const personIds = people.map((person) => person.personId);
    const eventIds = [...new Set(people.map((person) => person.eventId).filter((eventId): eventId is string => Boolean(eventId)))];
    const [storedPeople, definitions, eventCount] = await Promise.all([
      db.lumaPerson.findMany({
        where: { personId: { in: personIds } },
        select: { personId: true, manualTags: true },
      }),
      db.guestTag.findMany({
        where: { id: { in: tagIds } },
        select: { id: true, name: true, managed: true },
      }),
      db.lumaEvent.count({ where: { eventId: { in: eventIds } } }),
    ]);
    if (storedPeople.length !== personIds.length) throw notFound("One or more selected guests could not be found.");
    if (definitions.length !== tagIds.length) throw notFound("One or more selected tags could not be found.");
    if (eventCount !== eventIds.length) throw notFound("One or more selected events could not be found.");
    if (definitions.some((definition) => definition.managed)) {
      const error = new Error("Automatic tags cannot be changed manually.") as HttpError;
      error.status = 409;
      throw error;
    }

    if (!removed) {
      const addedTagNames = definitions.map((definition) => definition.name);
      for (const person of storedPeople) {
        const resultingNames = new Set(normalizePersonTags(person.manualTags).map((tag) => tag.toLocaleLowerCase()));
        addedTagNames.forEach((tag) => resultingNames.add(tag.toLocaleLowerCase()));
        if (resultingNames.size > MAX_PERSON_TAGS) {
          const error = new Error(`A person can have at most ${MAX_PERSON_TAGS} tags.`) as HttpError;
          error.status = 400;
          throw error;
        }
      }
    }

    const selectedPeopleSql = Prisma.join(
      people.map((person) => Prisma.sql`(${person.personId}, ${person.eventId})`),
      ", ",
    );
    const selectedTagsSql = Prisma.join(tagIds.map((tagId) => Prisma.sql`(${tagId})`), ", ");
    await db.$executeRaw(Prisma.sql`
      WITH selected_people(person_id, event_id) AS (VALUES ${selectedPeopleSql}),
      selected_tags(tag_id) AS (VALUES ${selectedTagsSql}),
      latest AS MATERIALIZED (
        SELECT DISTINCT ON (mutation.person_id, mutation.tag_id)
          mutation.person_id,
          mutation.tag_id,
          mutation.removed
        FROM manual_tag_mutations AS mutation
        JOIN selected_people AS person ON person.person_id = mutation.person_id
        JOIN selected_tags AS tag ON tag.tag_id = mutation.tag_id
        ORDER BY mutation.person_id, mutation.tag_id, mutation.assigned_at DESC NULLS LAST, mutation.id DESC
      )
      INSERT INTO manual_tag_mutations (person_id, tag_id, assigned_at, assigned_event_id, removed)
      SELECT person.person_id, tag.tag_id, NOW(), person.event_id, ${removed}
      FROM selected_people AS person
      CROSS JOIN selected_tags AS tag
      LEFT JOIN latest
        ON latest.person_id = person.person_id
        AND latest.tag_id = tag.tag_id
      WHERE latest.removed IS DISTINCT FROM ${removed}
    `);

    const selectedPersonIdsSql = Prisma.join(personIds.map((personId) => Prisma.sql`(${personId})`), ", ");
    return db.$queryRaw<IndexedPersonTagMutationResult[]>(Prisma.sql`
      WITH selected_people(person_id) AS (VALUES ${selectedPersonIdsSql}),
      latest_manual AS MATERIALIZED (
        SELECT DISTINCT ON (mutation.person_id, mutation.tag_id)
          mutation.person_id,
          mutation.tag_id,
          mutation.removed
        FROM manual_tag_mutations AS mutation
        JOIN selected_people AS person ON person.person_id = mutation.person_id
        ORDER BY mutation.person_id, mutation.tag_id, mutation.assigned_at DESC NULLS LAST, mutation.id DESC
      ),
      manual_tags AS (
        SELECT
          person.person_id,
          COALESCE(
            JSONB_AGG(definition.name ORDER BY LOWER(definition.name), definition.name)
              FILTER (WHERE latest.removed = FALSE AND definition.id IS NOT NULL),
            '[]'::jsonb
          ) AS tags
        FROM selected_people AS person
        LEFT JOIN latest_manual AS latest ON latest.person_id = person.person_id
        LEFT JOIN guest_tags AS definition ON definition.id = latest.tag_id
        GROUP BY person.person_id
      ),
      automatic_tags AS (
        SELECT
          person.person_id,
          COALESCE(
            JSONB_AGG(definition.name ORDER BY LOWER(definition.name), definition.name)
              FILTER (WHERE definition.id IS NOT NULL),
            '[]'::jsonb
          ) AS tags
        FROM selected_people AS person
        LEFT JOIN automatic_tag_assignments AS assignment ON assignment.person_id = person.person_id
        LEFT JOIN guest_tags AS definition ON definition.id = assignment.tag_id
        GROUP BY person.person_id
      ),
      combined_tags AS (
        SELECT
          manual.person_id,
          manual.tags AS manual_tags,
          automatic.tags AS automatic_tags,
          COALESCE((
            SELECT JSONB_AGG(unique_tag.name ORDER BY LOWER(unique_tag.name), unique_tag.name)
            FROM (
              SELECT MIN(tag_value.value) AS name
              FROM jsonb_array_elements_text(manual.tags || automatic.tags) AS tag_value(value)
              GROUP BY LOWER(tag_value.value)
            ) AS unique_tag
          ), '[]'::jsonb) AS tags
        FROM manual_tags AS manual
        JOIN automatic_tags AS automatic ON automatic.person_id = manual.person_id
      ),
      updated AS (
        UPDATE luma_people AS person
        SET
          manual_tags = combined.manual_tags,
          automatic_tags = combined.automatic_tags,
          tags = combined.tags
        FROM combined_tags AS combined
        WHERE person.person_id = combined.person_id
        RETURNING
          person.person_id AS "personId",
          person.tags,
          person.manual_tags AS "manualTags",
          person.automatic_tags AS "automaticTags"
      )
      SELECT * FROM updated ORDER BY "personId"
    `);
  });
  invalidateAudienceTagGroupCache();
  const changesReferralMembership = await prisma().guestTag.count({
    where: { id: { in: tagIds }, semanticKey: "referral" },
  });
  if (changesReferralMembership) {
    const affectedEvents = await prisma().lumaEventGuest.findMany({
      where: { personId: { in: people.map((person) => person.personId) } },
      distinct: ["eventId"],
      select: { eventId: true },
    });
    await refreshIndexedEventOverviewStats(affectedEvents.map((event) => event.eventId));
  }
  return result;
}

export async function mutateIndexedPersonTag({ personId, tagId, eventId, removed }: { personId: string; tagId: string; eventId: string | null; removed: boolean }) {
  const [person] = await mutateIndexedPeopleTags({
    people: [{ personId, eventId }],
    tagIds: [tagId],
    removed,
  });
  if (!person) throw notFound("Person not found.");
  return person;
}

export async function matchIndexedPeopleByEmails(emails: string[]) {
  const normalizedEmails = [...new Set(emails.map((email) => normalizeEmail(email)).filter(Boolean))];
  if (!normalizedEmails.length) return [];
  return prisma().lumaPerson.findMany({
    where: { emailLower: { in: normalizedEmails } },
    select: {
      personId: true,
      name: true,
      email: true,
      emailLower: true,
      tags: true,
      manualTags: true,
      automaticTags: true,
    },
    orderBy: [{ name: "asc" }, { personId: "asc" }],
  });
}

function notFound(message: string) {
  const error = new Error(message) as HttpError;
  error.status = 404;
  return error;
}

export async function listIndexedPersonComments(personId: string, { limit = 200 }: { limit?: number } = {}) {
  const comments = await prisma().guestComment.findMany({
    where: { personId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.max(1, Math.min(500, Math.trunc(limit) || 200)),
    select: {
      id: true,
      personId: true,
      body: true,
      author: true,
      createdAt: true,
    },
  });
  return comments.reverse();
}

export async function appendIndexedPersonComment({
  personId,
  body,
  author,
}: {
  personId: string;
  body: string;
  author: string;
}) {
  return prisma().$transaction(async (transaction) => {
    const person = await transaction.lumaPerson.findUnique({
      where: { personId },
      select: { personId: true },
    });
    if (!person) throw notFound("Person not found.");
    const comment = await transaction.guestComment.create({
      data: { personId, body, author },
      select: {
        id: true,
        personId: true,
        body: true,
        author: true,
        createdAt: true,
      },
    });
    return comment;
  });
}

export async function updateIndexedPersonComment({
  personId,
  commentId,
  body,
}: {
  personId: string;
  commentId: bigint;
  body: string;
}) {
  return prisma().$transaction(async (transaction) => {
    const existing = await transaction.guestComment.findFirst({
      where: { id: commentId, personId },
      select: { id: true },
    });
    if (!existing) throw notFound("Comment not found.");
    const comment = await transaction.guestComment.update({
      where: { id: commentId },
      data: { body },
      select: {
        id: true,
        personId: true,
        body: true,
        author: true,
        createdAt: true,
      },
    });
    const summary = await indexedPersonCommentSummary(transaction, personId);
    return { comment, ...summary };
  });
}

export async function deleteIndexedPersonComment({
  personId,
  commentId,
}: {
  personId: string;
  commentId: bigint;
}) {
  return prisma().$transaction(async (transaction) => {
    const removed = await transaction.guestComment.deleteMany({
      where: { id: commentId, personId },
    });
    if (!removed.count) throw notFound("Comment not found.");
    return indexedPersonCommentSummary(transaction, personId);
  });
}

async function indexedPersonCommentSummary(
  transaction: Prisma.TransactionClient,
  personId: string,
) {
  const [latestComment, commentCount] = await Promise.all([
    transaction.guestComment.findFirst({
      where: { personId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { body: true, createdAt: true },
    }),
    transaction.guestComment.count({ where: { personId } }),
  ]);
  return { latestComment, commentCount };
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

  const result = await prisma().$transaction(async (db: Prisma.TransactionClient) => {
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
  if (!dryRun && result.status === "success") invalidateAudienceTagGroupCache();
  return result;
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
        AND EXISTS (
          SELECT 1
          FROM luma_event_guests AS attributed_guest
          WHERE attributed_guest.event_id = event.event_id
            AND (
              attributed_guest.checked_in_at IS NOT NULL
              OR attributed_guest.status = 'checked_in'
            )
        )
      ORDER BY event.starts_at DESC, event.event_id DESC
      LIMIT 5
    )
    SELECT
      CONCAT(
        ${AUTOMATIC_TAG_RULESET_VERSION},
        ':',
        COALESCE(STRING_AGG(event_id, ',' ORDER BY starts_at DESC, event_id DESC), '')
      ) AS fingerprint,
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
    attributed_events AS MATERIALIZED (
      SELECT DISTINCT guest.event_id
      FROM luma_event_guests AS guest
      WHERE guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in'
    ),
    newcomer_activity AS MATERIALIZED (
      SELECT
        guest.person_id,
        COUNT(DISTINCT guest.event_id) FILTER (
          WHERE guest.status IN ('registered', 'going', 'waitlisted', 'checked_in', 'no_show')
        )::integer AS registration_count,
        COUNT(DISTINCT guest.event_id) FILTER (
          WHERE guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in'
        )::integer AS check_in_count,
        COALESCE(
          JSONB_AGG(DISTINCT guest.event_id) FILTER (
            WHERE guest.status IN ('registered', 'going', 'waitlisted', 'checked_in', 'no_show')
          ),
          '[]'::jsonb
        ) AS event_ids
      FROM luma_event_guests AS guest
      JOIN luma_events AS counted_event ON counted_event.event_id = guest.event_id
      JOIN attributed_events AS attributed_event ON attributed_event.event_id = guest.event_id
      JOIN target_people AS target ON target.person_id = guest.person_id
      WHERE counted_event.catalog_active = TRUE
        AND LOWER(COALESCE(counted_event.raw->>'status', '')) NOT IN ('cancelled', 'canceled')
      GROUP BY guest.person_id
    ),
    newcomer_matches AS (
      SELECT
        activity.person_id,
        'new_guest'::text AS rule_key,
        JSONB_BUILD_OBJECT(
          'eventIds', activity.event_ids,
          'registrationCount', activity.registration_count,
          'checkInCount', activity.check_in_count,
          'maximumRegistrations', ${NEW_GUEST_MAX_REGISTRATIONS}
        ) AS evidence
      FROM newcomer_activity AS activity
      WHERE activity.registration_count BETWEEN 1 AND ${NEW_GUEST_MAX_REGISTRATIONS}
        AND activity.check_in_count = 0
    ),
    attendance_ratio_matches AS (
      SELECT
        activity.person_id,
        CASE
          WHEN activity.registration_count >= 2
            AND activity.check_in_count * 100 >= activity.registration_count * 90 THEN 'reliable'::text
          ELSE 'consistent'::text
        END AS rule_key,
        JSONB_BUILD_OBJECT(
          'eventIds', activity.event_ids,
          'registrationCount', activity.registration_count,
          'checkInCount', activity.check_in_count,
          'attendancePercent', ROUND((activity.check_in_count::numeric / activity.registration_count) * 100, 1)
        ) AS evidence
      FROM newcomer_activity AS activity
      WHERE activity.registration_count >= 1
        AND activity.check_in_count >= 2
        AND activity.check_in_count * 100 >= activity.registration_count * 75
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
        AND EXISTS (
          SELECT 1
          FROM attributed_events AS attributed_event
          WHERE attributed_event.event_id = event.event_id
        )
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
      SELECT * FROM newcomer_matches
      UNION ALL
      SELECT * FROM attendance_ratio_matches
      UNION ALL
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
      person: { select: INDEXED_TRACE_PERSON_SELECT },
      event: {
        select: {
          title: true,
          date: true,
          startsAt: true,
          endsAt: true,
          category: true,
          location: true,
          lumaUrl: true,
          catalogActive: true,
          raw: true,
        },
      },
    },
    take: limit,
    orderBy: [{ checkedInAt: "desc" }, { registeredAt: "desc" }, { createdAt: "desc" }, { lastSeenAt: "desc" }],
  });

  const records = rows.map(indexedGuestToTraceRecord).sort((a, b) => new Date(b.eventStartsAt || b.eventDate || b.sortAt).getTime() - new Date(a.eventStartsAt || a.eventDate || a.sortAt).getTime());

  return {
    source: "luma-index",
    person: rows[0] ? indexedPersonToApiPerson(rows[0].person, rows[0]) : null,
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
  if (result.count) await refreshIndexedEventOverviewStats([eventId]);
  return { updatedCount: result.count };
}

export async function updateIndexedGuestCheckIn({ eventId, lumaGuestId, checkedIn }) {
  if (!eventId || !lumaGuestId) return { updatedCount: 0 };
  const now = new Date();
  const result = await prisma().lumaEventGuest.updateMany({
    where: { eventId, lumaGuestId },
    data: {
      status: checkedIn ? "checked_in" : "going",
      lumaApprovalStatus: "approved",
      checkedInAt: checkedIn ? now : null,
      updatedAt: now,
      lastSeenAt: now,
      syncedAt: now,
    },
  });
  if (result.count) await refreshIndexedEventOverviewStats([eventId]);
  return { updatedCount: result.count };
}

export async function updateIndexedPersonPhoneNumber(personId: string, phoneNumber: string | null) {
  if (!personId) return { updatedCount: 0 };
  const result = await prisma().lumaPerson.updateMany({
    where: { personId },
    data: { phoneNumber },
  });
  return { updatedCount: result.count };
}

export async function listIndexedGuestReferrerTargets(eventId: string, limit = 100) {
  if (!eventId) return [];
  const boundedLimit = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 100, 500));
  return prisma().$queryRaw<Array<{ personId: string; lumaUserId: string }>>(Prisma.sql`
    SELECT
      guest.person_id AS "personId",
      guest.luma_user_id AS "lumaUserId"
    FROM luma_event_guests AS guest
    WHERE guest.event_id = ${eventId}
      AND guest.luma_user_id IS NOT NULL
      AND (
        guest.referrer IS NULL
        OR guest.referrer = 'null'::jsonb
        OR guest.referrer = '{}'::jsonb
        OR COALESCE(guest.referrer ->> 'detailsVersion', '') <> '1'
      )
    ORDER BY guest.registered_at DESC NULLS LAST, guest.last_seen_at DESC
    LIMIT ${boundedLimit}
  `);
}

export async function updateIndexedGuestReferrers(eventId: string, updates: Array<{ personId: string; referrer: AnyRecord }>) {
  if (!eventId || !updates.length) return { updatedCount: 0 };
  const now = new Date();
  const uniqueUpdates = [...new Map(
    updates
      .filter((update) => update?.personId && update.referrer)
      .map((update) => [update.personId, update]),
  ).values()];
  if (!uniqueUpdates.length) return { updatedCount: 0 };

  const results = await prisma().$transaction(uniqueUpdates.map((update) => (
    prisma().lumaEventGuest.updateMany({
      where: { eventId, personId: update.personId },
      data: {
        referrer: sanitizeJson(update.referrer),
        syncedAt: now,
      },
    })
  )));
  return { updatedCount: results.reduce((total, result) => total + result.count, 0) };
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

export async function claimLumaWebhookDelivery({
  webhookId,
  webhookType,
  eventId,
  guestId,
  payloadSha256,
  staleAfterSeconds = 30,
}) {
  const data = {
    webhookId,
    webhookType,
    eventId,
    guestId,
    payloadSha256,
    status: "processing",
  };
  try {
    await prisma().lumaWebhookDelivery.create({ data });
    return { claimed: true, duplicate: false, attempt: 1 };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
  }

  const existing = await prisma().lumaWebhookDelivery.findUnique({ where: { webhookId } });
  if (!existing) return { claimed: false, duplicate: true, attempt: 0 };
  if (existing.payloadSha256 !== payloadSha256) {
    const error = new Error("Webhook ID was reused with a different payload.") as HttpError;
    error.status = 409;
    throw error;
  }
  if (existing.status === "processed") {
    return { claimed: false, duplicate: true, attempt: existing.attempts };
  }

  const staleBefore = new Date(Date.now() - Math.max(5, staleAfterSeconds) * 1000);
  const reclaimed = await prisma().lumaWebhookDelivery.updateMany({
    where: {
      webhookId,
      OR: [
        { status: "failed" },
        { status: "processing", updatedAt: { lt: staleBefore } },
      ],
    },
    data: {
      webhookType,
      eventId,
      guestId,
      status: "processing",
      attempts: { increment: 1 },
      error: null,
      processedAt: null,
    },
  });
  return {
    claimed: reclaimed.count === 1,
    duplicate: reclaimed.count !== 1,
    attempt: existing.attempts + (reclaimed.count === 1 ? 1 : 0),
  };
}

export async function finishLumaWebhookDelivery(webhookId: string, error: unknown = null) {
  const failed = Boolean(error);
  return prisma().lumaWebhookDelivery.update({
    where: { webhookId },
    data: {
      status: failed ? "failed" : "processed",
      error: failed ? String(error instanceof Error ? error.message : error).slice(0, 2000) : null,
      processedAt: failed ? null : new Date(),
    },
  });
}

export async function recordLumaWebhookState({ eventId, webhookId }: { eventId: string; webhookId: string }) {
  const now = new Date();
  return prisma().lumaEventSyncState.upsert({
    where: { eventId },
    create: {
      eventId,
      lastEventSyncAt: now,
      lastWebhookAt: now,
      lastWebhookId: webhookId,
      lastStatus: "webhook",
      error: null,
    },
    update: {
      lastEventSyncAt: now,
      lastWebhookAt: now,
      lastWebhookId: webhookId,
      lastStatus: "webhook",
      error: null,
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
        "capacity", "luma_url", "catalog_active", "raw", "last_seen_at", "synced_at"
      )
      VALUES ${Prisma.join(
        rows.map(
          (row) => Prisma.sql`(
            ${row.eventId}, ${row.title}, ${row.date}, ${row.startsAt}, ${row.endsAt}, ${row.visibility}, ${row.location}, ${row.category},
            ${row.capacity}, ${row.lumaUrl}, ${row.catalogActive}, ${row.rawJson}::jsonb, ${row.lastSeenAt}, ${row.syncedAt}
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
        "catalog_active" = TRUE,
        "raw" = EXCLUDED."raw",
        "last_seen_at" = EXCLUDED."last_seen_at",
        "synced_at" = EXCLUDED."synced_at"
    `,
  );

  return { skipped: false, eventCount: rows.length };
}

export async function archiveIndexedEventsMissingFromCatalog(eventIds: string[]) {
  if (!hasLumaDb()) return { skipped: true, archivedEventCount: 0 };
  const activeEventIds = [...new Set(eventIds.filter(Boolean))];
  const result = await prisma().lumaEvent.updateMany({
    where: {
      catalogActive: true,
      ...(activeEventIds.length ? { eventId: { notIn: activeEventIds } } : {}),
    },
    data: { catalogActive: false },
  });
  return { skipped: false, archivedEventCount: result.count };
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
    catalogActive: true,
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
      phoneNumber: guest.phoneNumber || null,
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
      phoneNumber: guest.phoneNumber || null,
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
      phone_number,
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
          ${row.phoneNumber},
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
      phone_number = COALESCE(NULLIF(BTRIM(luma_people.phone_number), ''), EXCLUDED.phone_number),
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
      phone_number,
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
          ${row.phoneNumber},
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
      phone_number = COALESCE(NULLIF(BTRIM(luma_event_guests.phone_number), ''), EXCLUDED.phone_number),
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
      checked_in_at = EXCLUDED.checked_in_at,
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
      phoneNumber: guest.phoneNumber || null,
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
  if (guest.phoneNumber) {
    await tx.lumaPerson.updateMany({
      where: {
        personId,
        OR: [{ phoneNumber: null }, { phoneNumber: "" }],
      },
      data: { phoneNumber: guest.phoneNumber },
    });
  }

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
      phoneNumber: guest.phoneNumber || null,
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
  if (guest.phoneNumber) {
    await tx.lumaEventGuest.updateMany({
      where: {
        eventId: event.id,
        personId,
        OR: [{ phoneNumber: null }, { phoneNumber: "" }],
      },
      data: { phoneNumber: guest.phoneNumber },
    });
  }
}

function indexedEventToApiEvent(row) {
  const guestStats = row.overviewStatsUpdatedAt
    ? normalizedEventOverviewStats(row.overviewStats)
    : null;
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
    ...(guestStats ? {
      guestStats,
      guestStatsUpdatedAt: isoOrNull(row.overviewStatsUpdatedAt),
    } : {}),
  };
}

const EVENT_OVERVIEW_STAT_KEYS = [
  "total",
  "checkedIn",
  "accepted",
  "registered",
  "pending",
  "declined",
  "invited",
  "waitlisted",
  "toDecide",
  "firstRegisters",
  "newRegistrations",
  "newFaces",
  "referredRegistrations",
  "newReferrals",
  "referredAccepted",
  "referredCheckedIn",
  "referredFirstRegisters",
  "referredReturning",
  "invitationTotal",
  "invitedGoing",
  "invitedCheckedIn",
  "invitedNoShow",
  "invitedNoResponse",
  "invitedDeclined",
  "invitedReferralTotal",
  "invitedReferralGoing",
  "invitedReferralCheckedIn",
  "invitedReferralNoShow",
  "invitedReferralNoResponse",
  "invitedReferralDeclined",
] as const;

function normalizedEventOverviewStats(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (Number(source.version) !== 1) return null;
  return Object.fromEntries(EVENT_OVERVIEW_STAT_KEYS.map((key) => [
    key,
    Math.max(0, Number(source[key]) || 0),
  ]));
}

function indexedPersonToApiPerson(row: any, guestRow: any = {}) {
  const avatarCandidates = indexedAvatarCandidates(row.raw, row.avatarUrl);
  const latestComment = Array.isArray(row.comments) ? row.comments[0] : null;
  const crmNotes = row.crmNotes ?? latestComment?.body ?? "";
  const crmNotesUpdatedAt = row.crmNotesUpdatedAt ?? latestComment?.createdAt ?? null;
  const crmNoteCount = Number(row.crmNoteCount ?? row._count?.comments ?? (latestComment ? 1 : 0)) || 0;
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
    socialLinks: Array.isArray(row.socialLinks) && row.socialLinks.length ? row.socialLinks : guestRow.socialLinks || [],
    referrer: row.referrer || guestRow.referrer || null,
    groups: row.groups || [],
    tags: row.tags || [],
    manualTags: row.manualTags || [],
    automaticTags: row.automaticTags || [],
    phoneNumber: row.phoneNumber || guestRow.phoneNumber || "",
    crmNotes,
    crmNotesUpdatedAt: isoOrNull(crmNotesUpdatedAt),
    crmNoteCount,
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
    phoneNumber: row.person?.phoneNumber || row.phoneNumber || "",
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
  const rawEvent = row.event?.raw && typeof row.event.raw === "object" && !Array.isArray(row.event.raw) ? row.event.raw : {};
  const rawEventStatus = String(rawEvent.status || "").toLowerCase();
  return {
    eventId: row.eventId,
    eventTitle: row.event?.title || "Untitled event",
    eventDate: dateString(row.event?.date || row.event?.startsAt || row.lastSeenAt),
    eventStartsAt: isoOrNull(row.event?.startsAt),
    eventEndsAt: isoOrNull(row.event?.endsAt),
    eventCategory: row.event?.category || "Luma",
    eventLocation: row.event?.location || "Location TBD",
    eventUrl: row.event?.lumaUrl || "",
    eventCancelled: ["cancelled", "canceled"].includes(rawEventStatus),
    eventCatalogActive: row.event?.catalogActive !== false,
    personId: row.personId,
    lumaGuestId: row.lumaGuestId,
    status: row.status || "registered",
    lumaApprovalStatus: row.lumaApprovalStatus,
    registeredAt,
    invitedAt: isoOrNull(row.invitedAt),
    checkedInAt: isoOrNull(row.checkedInAt),
    approvedAt: isoOrNull(row.approvedAt),
    profileDescription: row.profileDescription || row.person?.bio || "",
    socialLinks: Array.isArray(row.socialLinks) && row.socialLinks.length ? row.socialLinks : row.person?.socialLinks || [],
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

function latestDate(...values) {
  const dates = values
    .map(parseDateTime)
    .filter((value): value is Date => Boolean(value));
  return dates.length ? new Date(Math.max(...dates.map((value) => value.getTime()))) : null;
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
