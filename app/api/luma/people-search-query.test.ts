import assert from "node:assert/strict";
import test from "node:test";
import { parsePeopleSearchQuery } from "../search/people/query";

test("people search parses a bounded pagination offset", () => {
  assert.equal(parsePeopleSearchQuery(new URLSearchParams("q=founder&offset=40&limit=20")).offset, 40);
  assert.equal(parsePeopleSearchQuery(new URLSearchParams("q=founder&offset=-10")).offset, 0);
  assert.equal(parsePeopleSearchQuery(new URLSearchParams("q=founder&offset=99999")).offset, 10_000);
});

test("people search defaults invalid offsets to the first page", () => {
  assert.equal(parsePeopleSearchQuery(new URLSearchParams("q=founder&offset=nope")).offset, 0);
});
