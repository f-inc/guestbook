import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTagColor, normalizeTagName } from "./tag-catalog";

test("normalizes tag catalog fields", () => {
  assert.equal(normalizeTagName("  Community   Partner "), "Community Partner");
  assert.equal(normalizeTagColor("#A855F7"), "#a855f7");
});

test("rejects malformed tag catalog fields", () => {
  assert.throws(() => normalizeTagName("  "), /required/);
  assert.throws(() => normalizeTagColor("purple"), /six-digit hex/);
});
