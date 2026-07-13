type LumaEventLinkInput = {
  id?: unknown;
  source?: unknown;
};

export function lumaEventManageUrl(event: LumaEventLinkInput): string {
  const eventId = String(event?.id || "").trim();
  if (event?.source !== "luma" || !/^evt-[A-Za-z0-9_-]+$/.test(eventId)) return "";
  return `https://luma.com/event/manage/${encodeURIComponent(eventId)}`;
}
