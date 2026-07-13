const DEFAULT_EVENT_TIMEZONE = "America/Los_Angeles";

type LumaEventDateInput = Record<string, any>;

export function lumaEventDate(event: LumaEventDateInput = {}, fallbackValue: unknown = ""): string {
  const source = firstString(event.start_at, event.startAt, fallbackValue, event.created_at);
  if (!source) return new Date().toISOString().slice(0, 10);

  const instant = new Date(source);
  if (Number.isNaN(instant.getTime())) return source.slice(0, 10);

  const timezone = lumaEventTimezone(event);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

export function lumaEventTimezone(event: LumaEventDateInput = {}): string {
  return firstString(
    event.timezone,
    event.time_zone,
    event.timezone_name,
    event.calendar?.timezone,
    event.calendar?.time_zone,
    event.geo_address_info?.timezone,
    event.geo_address_json?.timezone,
    event.location?.timezone,
    process.env.LUMA_DEFAULT_TIMEZONE,
    DEFAULT_EVENT_TIMEZONE,
  );
}

function firstString(...values: unknown[]): string {
  const value = values.find((candidate) => typeof candidate === "string" && candidate.trim());
  return typeof value === "string" ? value.trim() : "";
}
