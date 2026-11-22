import { Prisma } from "@prisma/client";
import { prisma } from "../api/luma/db";
import { GUEST_ACCEPTED_STATUSES, GUEST_REGISTERED_STATUSES } from "../api/luma/guest-query";
import {
  evaluateOpenCampusFunnel,
  type FunnelQuery,
} from "../api/v1/analytics/open-campus-funnel/cohort";
import { loadFunnelHistory } from "../api/v1/analytics/open-campus-funnel/history";

export const stageLabels: Record<string, string> = {
  registrations: "Event registrations",
  accepted: "Accepted event registrations",
  checkedIn: "Recorded event check-ins",
  firstVisit: "First non-Open Campus visits",
  ocRegistered: "Open Campus registrations after first visit",
  ocAccepted: "Open Campus acceptances after first visit",
  ocCheckedIn: "Open Campus check-ins after first visit",
};
export function parseDrilldown(params: URLSearchParams) {
  const allowed = [
    "stage",
    "from",
    "to",
    "category",
    "status",
    "location",
    "event",
    "history",
    "expected",
    "page",
  ];
  if (
    [...params.keys()].some(
      (key) =>
        !allowed.includes(key) ||
        (!["event", "history"].includes(key) && params.getAll(key).length > 1),
    )
  )
    throw Error("Invalid metric link.");
  const stage = params.get("stage") ?? "";
  if (!stageLabels[stage]) throw Error("Unknown metric stage.");
  const from = params.get("from") ?? "",
    to = params.get("to") ?? "";
  const valid = (s: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(s)) &&
    new Date(s).toISOString().slice(0, 10) === s;
  if (
    !valid(from) ||
    !valid(to) ||
    Date.parse(to) <= Date.parse(from) ||
    Date.parse(to) - Date.parse(from) > 366 * 86400000
  )
    throw Error("Invalid metric dates.");
  const ids = (key: string) => {
    const list = [...new Set(params.getAll(key))];
    if (list.length > 2000 || list.some((id) => !id || id.length > 200))
      throw Error("Invalid event selection.");
    return list;
  };
  const page = Number(params.get("page") ?? "1");
  if (!Number.isSafeInteger(page) || page < 1 || page > 2000) throw Error("Invalid page.");
  const expected = params.has("expected") ? Number(params.get("expected")) : null;
  if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0))
    throw Error("Invalid expected count.");
  const query: FunnelQuery = { from, to };
  for (const name of ["category", "location"] as const)
    if (params.has(name)) {
      const value = params.get(name)!;
      if (value.length > 2000) throw Error("Invalid filters.");
      query[name] = value;
    }
  if (params.has("status")) {
    const status = params.get("status")!;
    if (!["held", "ongoing", "upcoming", "unknown"].includes(status))
      throw Error("Invalid status.");
    query.status = status;
  }
  return { stage, query, eventIds: ids("event"), historyScope: ids("history"), page, expected };
}
export async function readMetricPeople(input: ReturnType<typeof parseDrilldown>, db = prisma()) {
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      let members: { personId: string; eventId: string }[] = [];
      const titles = new Map<string, string>();
      if (["registrations", "accepted", "checkedIn"].includes(input.stage)) {
        if (input.eventIds.length > 500) throw Error("Event selection exceeds the read limit.");
        if (input.eventIds.length) {
          const events = await tx.lumaEvent.findMany({
            where: { eventId: { in: input.eventIds } },
            select: { eventId: true, title: true },
          });
          for (const event of events) titles.set(event.eventId, event.title);
          const status =
            input.stage === "accepted"
              ? { status: { in: GUEST_ACCEPTED_STATUSES } }
              : input.stage === "checkedIn"
                ? { OR: [{ checkedInAt: { not: null } }, { status: "checked_in" }] }
                : {
                    OR: [
                      { status: { in: GUEST_REGISTERED_STATUSES } },
                      { status: "declined", registeredAt: { not: null } },
                    ],
                  };
          const rows = await tx.lumaEventGuest.findMany({
            where: { eventId: { in: input.eventIds }, ...status },
            select: { personId: true, eventId: true },
            orderBy: [{ eventId: "asc" }, { personId: "asc" }],
            take: 100001,
          });
          if (rows.length > 100000) throw Error("Metric list exceeds its read limit.");
          members = rows;
        }
      } else {
        const { events, guests } = await loadFunnelHistory(tx, input.historyScope);
        for (const event of events) titles.set(event.eventId, event.title);
        const evaluation = evaluateOpenCampusFunnel(events, guests, input.query);
        const kind = (
          {
            firstVisit: "firstVisit",
            ocRegistered: "registered",
            ocAccepted: "accepted",
            ocCheckedIn: "checkedIn",
          } as Record<string, string>
        )[input.stage];
        members = evaluation.members[kind];
      }
      const total = members.length;
      const visible = members.slice((input.page - 1) * 50, input.page * 50);
      const people = visible.length
        ? await tx.lumaPerson.findMany({
            where: { personId: { in: visible.map((row) => row.personId) } },
            select: { personId: true, name: true },
          })
        : [];
      const names = new Map(people.map((person) => [person.personId, person.name]));
      return {
        total,
        rows: visible.map((row) => ({
          ...row,
          name: names.get(row.personId) || "Unnamed person",
          eventTitle: titles.get(row.eventId) || "Event",
        })),
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 },
  );
}
