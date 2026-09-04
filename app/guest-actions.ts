export type GuestAction = [label: string, status: string];

export function actionsForStatus(status: string): GuestAction[] {
  if (status === "checked_in") return [["Undo", "going"]];
  if (status === "no_show") return [["Check in", "checked_in"]];
  if (status === "registered") return [["Approve", "going"], ["Waitlist", "waitlisted"], ["Decline", "declined"]];
  if (status === "waitlisted") return [["Approve", "going"], ["Decline", "declined"]];
  if (status === "going") return [["Check in", "checked_in"], ["Waitlist", "waitlisted"], ["Decline", "declined"]];
  if (status === "invited") return [["Approve", "going"], ["Decline", "declined"]];
  if (status === "declined") return [["Approve", "going"], ["Waitlist", "waitlisted"]];
  return [];
}
