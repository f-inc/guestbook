import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRequestsUrl, requestsUrl } from "../../../requests/url";

test("request links restore the stable ID, search, and page offset", () => {
  const state = { requestId: "event/one?two&three", search: "guest+one@example.test", offset: 75 };
  const url = new URL(requestsUrl("https://guestbook.test/requests", state), "https://guestbook.test");
  assert.deepEqual(parseRequestsUrl(url.search), state);
  assert.equal(url.searchParams.get("request"), state.requestId);
});

test("default request links omit empty filters and preserve other URL state", () => {
  const url = requestsUrl("https://guestbook.test/requests?q=old&offset=50&request=old&source=email#details", { requestId: "new", search: "", offset: 0 });
  assert.equal(url, "/requests?request=new&source=email#details");
  assert.equal(requestsUrl(`https://guestbook.test${url}`, { requestId: "", search: "", offset: 0 }), "/requests?source=email#details");
});

test("malformed request URL state stays within the API query bounds", () => {
  for (const offset of ["-1", "1.5", "NaN", "Infinity", "1000001", "9007199254740992"]) {
    assert.equal(parseRequestsUrl(`?offset=${offset}`).offset, 0);
  }
  assert.deepEqual(parseRequestsUrl(""), { requestId: "", search: "", offset: 0 });
  assert.equal(parseRequestsUrl("?offset=1000000").offset, 1_000_000);
  assert.deepEqual(parseRequestsUrl("?request=%20event-one%20&q=%20robotics%20"), { requestId: "event-one", search: "robotics", offset: 0 });
  const long = "x".repeat(501);
  assert.equal(parseRequestsUrl(`?q=${long}&request=${long}`).search.length, 500);
  assert.equal(parseRequestsUrl(`?q=${long}&request=${long}`).requestId.length, 500);
});
