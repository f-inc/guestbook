import assert from "node:assert/strict";
import test from "node:test";
import { parsePeopleSearchQuery } from "../search/people/query";

test("parses people search tag and comment filters", () => {
  const params = new URLSearchParams([
    ["q", " haseab "],
    ["tag", "New"],
    ["tag", "New"],
    ["tag", "Referred"],
    ["exclude_tag", "Flaker"],
    ["tag_mode", "all"],
    ["comments", "with"],
    ["limit", "500"],
  ]);

  assert.deepEqual(parsePeopleSearchQuery(params), {
    query: "haseab",
    limit: 20,
    scope: "all",
    includedTags: ["New", "Referred"],
    excludedTags: ["Flaker"],
    tagMode: "all",
    comments: "with",
    hasFilters: true,
  });
});

test("defaults invalid people search filters to inactive values", () => {
  const result = parsePeopleSearchQuery(new URLSearchParams("comments=sometimes&tag_mode=none"));

  assert.equal(result.query, "");
  assert.equal(result.comments, "any");
  assert.equal(result.tagMode, "any");
  assert.equal(result.hasFilters, false);
});
