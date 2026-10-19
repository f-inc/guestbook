// Keep values and labels synchronized with os-v2/packages/shared/src/types/event-request.ts
// and os-web/src/lib/event-request.ts. Stored answers use the stable value, never the label.
export const EVENT_INVOLVEMENT_OPTIONS = [
  { value: "fully_host_find_sponsors", label: "I will fully host the event + find sponsors" },
  { value: "fully_host_need_sponsor_help", label: "I will fully host the event + need help with sponsors" },
  { value: "need_hosting_help_find_sponsors", label: "I need help hosting the event but can find sponsors" },
  { value: "need_hosting_and_sponsor_help", label: "I need help hosting the event + need help with sponsors" },
] as const;

export function involvementLabel(value: unknown): string | undefined {
  return EVENT_INVOLVEMENT_OPTIONS.find((option) => option.value === value)?.label;
}
