import assert from "node:assert/strict";
import test from "node:test";
import { MAX_BULK_EMAILS, parseBulkEmails } from "./bulk-email-tags";

test("parses, normalizes, and deduplicates pasted emails", () => {
  assert.deepEqual(parseBulkEmails("A@Example.com, b@example.com\na@example.com;bad"), {
    emails: ["a@example.com", "b@example.com"],
    invalidEmails: ["bad"],
  });
});

test("requires at least one pasted value", () => {
  assert.throws(() => parseBulkEmails("  \n "), /at least one email/i);
});

test("bounds the number of unique emails", () => {
  const value = Array.from({ length: MAX_BULK_EMAILS + 1 }, (_, index) => `person-${index}@example.com`).join("\n");
  assert.throws(() => parseBulkEmails(value), /up to 2,000/i);
});
