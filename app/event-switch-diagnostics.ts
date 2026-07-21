// EVENT_SWITCH_DIAGNOSTICS: temporary event-navigation instrumentation. Remove this file and same-named hooks as a unit.
export const EVENT_SWITCH_DIAGNOSTICS_ACTION = "logEventSwitchDiagnostic";
export const EVENT_SWITCH_DIAGNOSTICS_PARAM = "event_switch_diagnostic_id";
export const EVENT_SWITCH_DIAGNOSTICS_PREFIX = "diagnostic.event_switch";

export type EventSwitchDiagnosticReporter = (
  stage: string,
  durationMs: number,
  details?: Record<string, string | number | boolean | null>,
) => void;

export function normalizeEventSwitchDiagnosticId(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9-]{8,80}$/i.test(normalized) ? normalized : "";
}

export function normalizeClientEventSwitchDiagnostic(body: Record<string, any>) {
  const timings = Object.fromEntries(
    Object.entries(body.timings && typeof body.timings === "object" ? body.timings : {})
      .slice(0, 16)
      .map(([key, value]) => [safeLabel(key), safeDuration(value)])
      .filter(([key]) => Boolean(key)),
  );

  return {
    diagnosticId: normalizeEventSwitchDiagnosticId(body.diagnosticId),
    eventId: safeIdentifier(body.eventId),
    tab: ["overview", "invite", "analytics"].includes(body.tab) ? body.tab : "unknown",
    outcome: ["rendered", "error"].includes(body.outcome) ? body.outcome : "unknown",
    serverRequestId: safeIdentifier(body.serverRequestId),
    cached: Boolean(body.cached),
    rowCount: safeCount(body.rowCount),
    timings,
  };
}

function safeIdentifier(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 100) : "";
}

function safeLabel(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/[^a-z0-9_.-]/gi, "_").slice(0, 60) : "";
}

function safeDuration(value: unknown) {
  const duration = Number(value);
  return Number.isFinite(duration) ? Math.min(60_000, Math.max(0, Math.round(duration * 10) / 10)) : 0;
}

function safeCount(value: unknown) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.min(100_000, Math.max(0, Math.trunc(count))) : 0;
}
