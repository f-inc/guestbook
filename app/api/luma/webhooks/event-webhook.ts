const EVENT_TYPES = new Set(["event.created", "event.updated", "event.canceled"]);

export function parseLumaEventWebhook(payload: any) {
  if (!EVENT_TYPES.has(payload?.type)) return null;
  const data = payload.data;
  if (!data || Array.isArray(data) || typeof data.id !== "string" || !data.id.trim()) {
    throw Object.assign(new Error("Event ID is required."), { status: 400 });
  }
  return { type: payload.type as string, eventId: data.id, data };
}

export function mergeLumaEventWebhook(parsed: NonNullable<ReturnType<typeof parseLumaEventWebhook>>, existing: any = {}) {
  // Cancellation payloads can contain fewer fields than the original event.
  // Preserve the last known title/dates instead of replacing them with defaults.
  return { ...existing, ...parsed.data, ...(parsed.type === "event.canceled" ? { status: "canceled" } : {}) };
}
