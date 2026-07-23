import assert from "node:assert/strict";
import test from "node:test";
import { parsePeopleSearchQuery } from "../search/people/query";

test("people search trims its query and accepts a bounded result limit", () => {
  const parsed = parsePeopleSearchQuery(new URLSearchParams({ q: "  reliable  ", limit: "12" }));
  assert.deepEqual(parsed, { query: "reliable", limit: 12, scope: "all" });
});

test("people search clamps result limits and defaults invalid limits", () => {
  assert.equal(parsePeopleSearchQuery(new URLSearchParams({ limit: "1000" })).limit, 20);
  assert.equal(parsePeopleSearchQuery(new URLSearchParams({ limit: "nope" })).limit, 8);
});

test("name-only people search supports a larger bounded directory page", () => {
  assert.deepEqual(
    parsePeopleSearchQuery(new URLSearchParams({ q: "Ada", scope: "name", limit: "40" })),
    { query: "Ada", limit: 40, scope: "name" },
  );
  assert.equal(parsePeopleSearchQuery(new URLSearchParams({ scope: "name", limit: "100" })).limit, 50);
});
