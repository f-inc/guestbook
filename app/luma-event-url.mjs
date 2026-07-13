export function lumaEventManageUrl(event) {
  const eventId = String(event?.id || "").trim();
  if (event?.source !== "luma" || !/^evt-[A-Za-z0-9_-]+$/.test(eventId)) return "";
  return `https://luma.com/event/manage/${encodeURIComponent(eventId)}`;
}
