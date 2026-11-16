import { Prisma } from "@prisma/client";
export const humanIdentityEnabled = () =>
  process.env.GUESTBOOK_IDENTITY_MODE === "human";
const tables: Record<string, string> = {
  luma_people: "guestbook_people",
  luma_event_guests: "guestbook_event_guests",
  guest_comments: "guestbook_comments",
  manual_tag_mutations: "guestbook_manual_tag_mutations",
  automatic_tag_assignments: "guestbook_automatic_tag_assignments",
  guestbook_person_email_addresses: "guestbook_human_person_email_addresses",
  guestbook_inactive_people: "guestbook_human_inactive_people",
};
const delegates: Record<string, string> = {
  lumaPerson: "guestbookPerson",
  lumaEventGuest: "guestbookEventGuest",
  guestComment: "guestbookComment",
  manualTagMutation: "guestbookManualTagMutation",
  automaticTagAssignment: "guestbookAutomaticTagAssignment",
};
// Rewrite SQL identifier fragments, never bound values or user-provided strings.
export function humanSql(query: Prisma.Sql): Prisma.Sql {
  return Prisma.sql(
    query.strings.map((s) =>
      s
        .replace(
          /\b(luma_people|luma_event_guests|guest_comments|manual_tag_mutations|automatic_tag_assignments|guestbook_person_email_addresses|guestbook_inactive_people)\b/g,
          (n) => tables[n],
        )
        .replace(
          /\b(FROM|JOIN) guestbook_people\b/g,
          "$1 guestbook_active_people",
        ),
    ) as any,
    ...query.values,
  );
}
const clients = new WeakMap<object, any>();
function relationKeys(model: string) {
  return model === "lumaEvent"
    ? { guests: "humanGuests", manualTagMutations: "humanManualTagMutations" }
    : model === "guestTag"
      ? {
          automaticAssignments: "humanAutomaticAssignments",
          manualMutations: "humanManualMutations",
        }
      : {};
}
function rename(value: any, keys: Record<string, string>): any {
  if (Array.isArray(value)) return value.map((v) => rename(v, keys));
  if (
    !value ||
    typeof value !== "object" ||
    value instanceof Date ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      keys[k] || k,
      ["data", "raw"].includes(k) ? v : rename(v, keys),
    ]),
  );
}
export function humanClient<T>(source: T): T;
export function humanClient(source: any): any {
  if (!humanIdentityEnabled()) return source;
  if (clients.has(source)) return clients.get(source);
  const proxy = new Proxy(source, {
    get(target, prop: string) {
      if (prop === "$source") return target;
      if (prop === "$transaction")
        return (action: any, options: any) =>
          typeof action === "function"
            ? target.$transaction(async (tx: any) => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(821157031)`;
                return action(humanClient(tx));
              }, options)
            : target
                .$transaction(
                  [
                    target.$executeRaw`SELECT pg_advisory_xact_lock(821157031)`,
                    ...action,
                  ],
                  options,
                )
                .then((rows: any[]) => rows.slice(1));
      if (prop === "$queryRaw" || prop === "$executeRaw")
        return (query: any, ...values: any[]) => {
          const sql = Array.isArray(query)
            ? Prisma.sql(query, ...values)
            : query;
          return target[prop](humanSql(sql));
        };
      if (prop in delegates || prop === "lumaEvent" || prop === "guestTag") {
        const delegate = target[delegates[prop] || prop],
          keys = relationKeys(prop);
        const reverse = Object.fromEntries(
          Object.entries(keys).map(([a, b]) => [b, a]),
        );
        return new Proxy(delegate, {
          get(d, method: string) {
            return (args: any = {}) => {
              const input = rename(args, keys);
              if (
                prop === "lumaPerson" &&
                [
                  "findMany",
                  "findFirst",
                  "count",
                  "aggregate",
                  "groupBy",
                  "updateMany",
                  "deleteMany",
                ].includes(method)
              )
                input.where = {
                  AND: [input.where || {}, { mergedIntoId: null }],
                };
              if (
                prop === "lumaPerson" &&
                ["findUnique", "update", "delete"].includes(method)
              )
                input.where = { ...input.where, mergedIntoId: null };
              const result = d[method](input);
              return Object.keys(keys).some((k) =>
                JSON.stringify(args).includes(`"${k}"`),
              )
                ? result.then((value: any) => rename(value, reverse))
                : result;
            };
          },
        });
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  clients.set(source, proxy);
  return proxy;
}
