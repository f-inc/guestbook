import assert from "node:assert/strict";
import test from "node:test";
import { PeopleSearchCache } from "../../people-search-cache";

test("recent searches keep query/filter pages separate and expire without extending freshness", () => {
  const cache = new PeopleSearchCache<string>(60, 2);
  cache.set("ada\u0000any", "all", 0);
  cache.set("ada\u0000VIP", "filtered", 0);
  assert.equal(cache.get("ada\u0000any", 30), "all");
  assert.equal(cache.get("ada\u0000VIP", 30), "filtered");
  assert.equal(cache.get("ada\u0000any", 60), undefined);
});

test("cache evicts the least recently used search and clears after edits or authentication changes", () => {
  const cache = new PeopleSearchCache<string>(60, 2);
  cache.set("ada", "Ada", 0);
  cache.set("alex", "Alex", 0);
  cache.get("ada", 1);
  cache.set("grace", "Grace", 2);
  assert.equal(cache.get("alex", 3), undefined);
  assert.equal(cache.get("ada", 3), "Ada");
  const revision = cache.revision;
  cache.clear();
  assert.notEqual(cache.revision, revision);
  assert.equal(cache.get("ada", 4), undefined);
  assert.equal(cache.get("grace", 4), undefined);
});
