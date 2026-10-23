import assert from "node:assert/strict";
import { test } from "node:test";
import { projectCioAnswers, projectCioTags } from "./cio-mapping";
import { buildCioProjection } from "./cio-projection";
import { sendCioProjection } from "./cio-sync";

const now = new Date("2026-10-22T12:00:00Z");
const guest = (value: unknown, date: string | null, extras = {}) => ({ eventId: "evt-test", raw: {
  registered_at: date, registration_answers: [{ question_id: "company-q", label: "Company", value, ...extras }],
} });
test("newest source answer wins even when an older event was imported most recently", () => {
  const old = { ...guest("Old company", "2025-01-01T00:00:00Z"), syncedAt: "2026-10-22T00:00:00Z" };
  const fresh = { ...guest("New company", "2026-01-01T00:00:00Z"), syncedAt: "2026-01-01T00:00:00Z" };
  assert.equal(projectCioAnswers([old, fresh], {}, now).state.company.value, "New company");
  assert.deepEqual(projectCioAnswers([old, fresh], {}, now), projectCioAnswers([fresh, old], {}, now));
});
test("prior delivered facts survive an old backfill, blank answer and disappearing source row", () => {
  const prior = projectCioAnswers([guest("Current", "2026-01-01T00:00:00Z")], {}, now).state;
  for (const rows of [[], [guest("Old", "2025-01-01T00:00:00Z")], [guest("", "2026-10-21T00:00:00Z")]]) {
    assert.deepEqual(projectCioAnswers(rows, prior, now).state, prior);
  }
});
test("answer clocks take precedence; invalid explicit clocks cannot borrow a registration date", () => {
  const result = projectCioAnswers([guest("Edited", "2025-01-01T00:00:00Z", { updated_at: "2026-09-01T00:00:00Z" })], {}, now);
  assert.equal(result.state.company.time_basis, "answer");
  assert.equal(result.state.company.answered_at, Date.parse("2026-09-01T00:00:00Z") / 1000);
  for (const date of ["unknown", "2028-01-01T00:00:00Z"]) {
    const invalid = projectCioAnswers([guest("Bad clock", "2025-01-01T00:00:00Z", { updated_at: date })], {}, now);
    assert.deepEqual(invalid.state, {}); assert.ok(invalid.review.includes("company:unknown_source_time"));
  }
});
test("equal-time disagreements require review and preserve the last delivered fact", () => {
  const rows = [guest("One", "2026-01-01T00:00:00Z"), guest("Two", "2026-01-01T00:00:00Z")];
  assert.deepEqual(projectCioAnswers(rows, {}, now).state, {});
  const prior = projectCioAnswers([guest("Previous", "2025-01-01T00:00:00Z")], {}, now).state;
  const result = projectCioAnswers(rows, prior, now);
  assert.deepEqual(result.state, prior); assert.ok(result.review.includes("company:equal_time_conflict"));
});
test("missing source clocks never borrow guest updates, event dates, sync time or import time", () => {
  const result = projectCioAnswers([{ ...guest("Unknown", null), updatedAt: now, registeredAt: now, syncedAt: now, event: { startsAt: now } }], {}, now);
  assert.deepEqual(result.state, {}); assert.deepEqual(result.review, ["company:unknown_source_time"]);
});
test("only mapped scalar answers are exported; structured values and invalid URLs are reviewed", () => {
  const row = guest({ company_name: "Ambiguous", job_title: "Founder" }, "2026-01-01T00:00:00Z");
  row.raw.registration_answers.push({ label: "LinkedIn URL", value: "https://linkedin.com.evil.test/p", question_id: "url-q" } as any);
  row.raw.registration_answers.push({ label: "Private notes", value: "Not exported", question_id: "notes" } as any);
  const result = projectCioAnswers([row], {}, now);
  assert.deepEqual(result.state, {}); assert.deepEqual(result.review, ["company:unsupported_or_blank", "linkedin_url:invalid_value"]);
});
test("tags tolerate emoji decorations and exclude subjective automatic labels", () => {
  const result = projectCioTags([{ tags: ["☠️ Blacklist", "✉️ No Invite", "🤝 Partner", "💀 Superflaker", "Interesting"] }]);
  assert.deepEqual(result, { tags: ["blacklist", "no_invite", "partner"], blacklisted: true, noInvite: true });
});
test("the observed optional LinkedIn question accepts full URLs and narrow profile paths", () => {
  for (const [value, expected] of [
    ["https://www.linkedin.com/in/example-person", "https://www.linkedin.com/in/example-person"],
    [" /in/example-person-123/ ", "https://www.linkedin.com/in/example-person-123/"],
  ]) {
    const row = guest(value, "2026-01-01T00:00:00Z", { label: "(Optional) What is your LinkedIn profile?" });
    const result = projectCioAnswers([row], {}, now);
    assert.equal(result.state.linkedin_url.value, expected);
    assert.equal(result.state.linkedin_url.answered_at, Date.parse("2026-01-01T00:00:00Z") / 1000);
    assert.equal(result.state.linkedin_url.time_basis, "registration");
    assert.deepEqual(result.review, []);
  }
});
test("LinkedIn path expansion rejects ambiguous input and does not expand project URLs", () => {
  for (const value of ["//evil.test/in/person", "/in/person?redirect=https://evil.test", "/in/../person", "/company/example", "/in/person\\other", "https://linkedin.com.evil.test/in/person", "https://user:pass@linkedin.com/in/person"]) {
    const row = guest(value, "2026-01-01T00:00:00Z", { label: "(Optional) What is your LinkedIn profile?" });
    const result = projectCioAnswers([row], {}, now);
    assert.deepEqual(result.state, {});
    assert.deepEqual(result.review, ["linkedin_url:invalid_value"]);
  }
  const project = projectCioAnswers([guest("/in/example-person", "2026-01-01T00:00:00Z", { label: "Project URL" })], {}, now);
  assert.deepEqual(project.state, {});
  assert.deepEqual(project.review, ["project_url:invalid_value"]);
});
test("renaming a pinned exclusion tag preserves its exclusion meaning", () => {
  const result = projectCioTags([{ tags: ["Do not contact"] }], [{ name: "Do not contact", semanticKey: "cio_blacklist" }]);
  assert.equal(result.blacklisted, true); assert.deepEqual(result.tags, ["blacklist"]);
});
test("tag-only people have deliverable exclusions without registrations; canonical traits stay absent", () => {
  const result = buildCioProjection({ email: "a@example.com", guests: [], people: [{ tags: ["☠️ Blacklist"] }] });
  assert.equal(result.hasOwnedFacts, true); assert.equal(result.hasRegistrations, false);
  assert.equal(result.attrs.finc_luma_marketing_blocked, true);
  assert.deepEqual(result.attrs.finc_luma_exclusion_reasons, ["blacklist"]);
  assert.ok(Object.keys(result.attrs).every(key => key.startsWith("finc_luma_")));
});
const env = { NODE_ENV: "production", GUESTBOOK_ENVIRONMENT: "production", CIO_SYNC_ENABLED: "true", CIO_SYNC_SEND_ENABLED: "true",
  CIO_SYNC_IDENTITY_CONFIRMED: "email_lookup", CIO_SYNC_PROFILE_MODE: "create_reviewed", CIO_SYNC_AUTOMATIONS_REVIEWED: "true",
  CIO_SYNC_FULL_ROLLOUT: "true", CUSTOMERIO_APP_API_KEY: "test", CUSTOMERIO_SITE_ID: "test", CUSTOMERIO_TRACK_API_KEY: "test" };
test("excluded profiles are never created but existing profiles receive restriction updates", async () => {
  const attrs = buildCioProjection({ email: "a@example.com", guests: [], people: [{ tags: ["No Invite"] }] }).attrs;
  let puts = 0;
  const missing: typeof fetch = async (_url, init) => { if (init?.method === "PUT") puts++; return Response.json({ results: [] }); };
  await assert.rejects(sendCioProjection("a@example.com", attrs, missing, env), /cio_profile_excluded/);
  assert.equal(puts, 0);
  const existing: typeof fetch = async (_url, init) => {
    if (init?.method === "GET") return Response.json({ results: [{ email: "a@example.com", cio_id: "abc123" }] });
    puts++; const payload = JSON.parse(String(init?.body)); assert.equal(payload._update, true);
    assert.equal(payload.finc_luma_no_invite, true); assert.equal(payload.email, undefined);
    return new Response("", { status: 200 });
  };
  await sendCioProjection("a@example.com", attrs, existing, env); assert.equal(puts, 1);
});
