import { Prisma } from "@prisma/client";

// An assignment remains evidence even when a later mutation removes the tag.
// Event attribution records where it was assigned, not where it can match.
export function historicalManualTagFiltersSql(
  personId: Prisma.Sql,
  included: string[],
  excluded: string[] = [],
  mode: "any" | "all" = "any",
): Prisma.Sql {
  const hasEverHad = (name: string) => Prisma.sql`EXISTS (
    SELECT 1
    FROM manual_tag_mutations AS historical_tag
    JOIN guest_tags AS historical_definition ON historical_definition.id = historical_tag.tag_id
    WHERE historical_tag.person_id = ${personId}
      AND historical_tag.removed = FALSE
      AND historical_definition.managed = FALSE
      AND LOWER(historical_definition.name) = LOWER(${name})
  )`;
  const predicates: Prisma.Sql[] = [];
  if (included.length) {
    predicates.push(Prisma.sql`(${Prisma.join(included.map(hasEverHad), mode === "all" ? " AND " : " OR ")})`);
  }
  for (const name of excluded) predicates.push(Prisma.sql`NOT (${hasEverHad(name)})`);
  return predicates.length ? Prisma.sql`(${Prisma.join(predicates, " AND ")})` : Prisma.empty;
}
