import assert from "node:assert/strict";
import test from "node:test";
import { connectionCheckFailed, readLumaNotifications, reconcileLumaNotifications, type LumaConnection } from "../../luma-notifications";

const connection = (status: "connected" | "invalid" | "unavailable"): LumaConnection => ({
  apiKeyCount: 1, sessions: [{ name: "LUMA_SESSION_TOKEN", status }], checkedAt: new Date().toISOString(),
});

test("an unresolved session survives reload and repeated checks without duplicate badges", () => {
  const original = reconcileLumaNotifications([], connection("invalid"));
  const restored = readLumaNotifications(JSON.stringify(original));
  assert.deepEqual(restored, original);
  const repeated = reconcileLumaNotifications(restored, connection("invalid"));
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].title, "Reconnect your Luma session");
});

test("an inconclusive check keeps the existing problem; successful verification clears it", () => {
  const original = reconcileLumaNotifications([], connection("invalid"));
  const unavailable = reconcileLumaNotifications(original, connection("unavailable"));
  assert.deepEqual(unavailable, original);
  const recovered = reconcileLumaNotifications([...unavailable, connectionCheckFailed], connection("connected"));
  assert.deepEqual(recovered, []);
});

test("fixing one session leaves notifications for other unresolved sessions", () => {
  const result = reconcileLumaNotifications([], {
    ...connection("connected"),
    sessions: [
      { name: "LUMA_SESSION_TOKEN", status: "connected" },
      { name: "LUMA_SESSION_TOKEN_2", status: "invalid" },
    ],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "luma-session:LUMA_SESSION_TOKEN_2");
});

test("missing configuration stays actionable until a session is configured", () => {
  const missing = reconcileLumaNotifications([], { ...connection("connected"), sessions: [] });
  assert.equal(missing[0].title, "Connect your Luma session");
  assert.deepEqual(reconcileLumaNotifications(missing, connection("connected")), []);
});

test("corrupt browser storage does not prevent notification checks", () => {
  for (const value of [null, "invalid", "null", "{}", '[null,{}, {"id": 1}]']) {
    assert.deepEqual(readLumaNotifications(value), []);
  }
});
