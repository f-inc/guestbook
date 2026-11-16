import { humanIdentityEnabled } from "../../../../luma/human-mode";
import { randomUUID } from "node:crypto";
import { fetchLiveGuests } from "../../../live-guests";
import { prisma } from "../../../../luma/db";
import { apiError, authorize, checkEventAccess, fail, json, page, pagination } from "../../../shared";
export async function guests(request: Request, eventId: string, db?: ReturnType<typeof prisma>, fetchGuests = fetchLiveGuests) {
  const requestId = `integration-${randomUUID()}`;
  try {
    db ??= prisma();
    const key = await authorize(request, "guests:read", db);
    checkEventAccess(key, eventId);
    if (!/^[a-z0-9_-]{1,160}$/i.test(eventId)) fail("Invalid event ID.");
    const params = new URL(request.url).searchParams;
    const { limit, cursor } = pagination(params, ["status", "approval_status", "operator_decision", "checked_in", "registered"]);
    const status = params.get("status");
    // Fetch every Luma status before filtering the response. Preserve approval
    // values rather than guessing who initiated a decline.
    if (status !== null && (!/^[a-z_]{1,64}$/.test(status))) fail("Invalid status.");
    for (const field of ["approval_status", "operator_decision"]) {
      if (params.has(field) && !/^[a-z_]{1,64}$/.test(params.get(field)!)) fail(`Invalid ${field}.`);
    }
    for (const field of ["checked_in", "registered"]) {
      if (params.has(field) && !["true", "false"].includes(params.get(field)!)) fail(`${field} must be true or false.`);
    }
    const event = await db.lumaEvent.findUnique({ where: { eventId }, select: { eventId: true } });
    if (!event) fail("Event not found.", 404);
    const includeEmail = key.scopes.includes("guests:email");
    const checkedIn = params.get("checked_in");
    const registered = params.get("registered");
    const live = await fetchGuests(eventId, requestId);
    if (humanIdentityEnabled()) {
      const source=(db as any).$source||db;
      const registrations=await source.lumaEventGuest.findMany({where:{eventId,OR:[{personId:{in:live.guests.map(g=>g.personId)}},{lumaGuestId:{in:live.guests.map(g=>g.lumaGuestId)}}]},select:{personId:true,lumaGuestId:true,person:{select:{humanIdentity:{select:{personId:true,person:{select:{name:true}}}}}}}});
      const mapping=new Map<string,string>();const names=new Map<string,string>();
      registrations.forEach((r:any)=>{if(r.person.humanIdentity){names.set(r.person.humanIdentity.personId,r.person.humanIdentity.person.name);mapping.set(r.personId,r.person.humanIdentity.personId);if(r.lumaGuestId)mapping.set(`guest:${r.lumaGuestId}`,r.person.humanIdentity.personId);}});
      const unique=new Map<string,typeof live.guests[number]>();
      for(const guest of live.guests){
        const personId=mapping.get(guest.personId)||mapping.get(`guest:${guest.lumaGuestId}`);
        if(!personId)fail("This event's human index is incomplete. Refresh its guests in Guestbook.",503);
        const preferredName=names.get(personId)||guest.name;
        const row={...guest,personId,name:/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(preferredName)?"Unnamed guest":preferredName};const prior=unique.get(personId);
        if(!prior||row.checkedIn||(!prior.checkedIn&&row.registeredAt))unique.set(personId,row);
      }
      live.guests=[...unique.values()];
    }
    const decisions = await db.lumaEventGuest.findMany({
      where: { eventId, personId: { in: live.guests.map(guest => guest.personId) } },
      select: { personId: true, operatorDecision: true },
    });
    const byPerson = new Map<string, string | null>(decisions.map((row: any) => [row.personId, row.operatorDecision]));
    const rows = live.guests.map(guest => ({ ...guest, operatorDecision: byPerson.get(guest.personId) || null }))
      .filter(guest => (!status || guest.status === status)
        && (!params.has("approval_status") || guest.lumaApprovalStatus === params.get("approval_status"))
        && (!params.has("operator_decision") || guest.operatorDecision === params.get("operator_decision"))
        && (checkedIn === null || guest.checkedIn === (checkedIn === "true"))
        && (registered === null || Boolean(guest.registeredAt) === (registered === "true"))
        && (!cursor || guest.personId > cursor))
      .sort((a, b) => a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0);
    const result = page(rows, limit, row => row.personId);
    return json({ ...result, data: result.data.map(row => {
      const { email, ...guest } = row;
      return { ...guest, ...(includeEmail ? { email } : {}) };
    }), event: { eventId: event.eventId }, source: "luma-live", fetchedAt: live.fetchedAt,
      totalGuests: live.guests.length, complete: true, requestId });
  } catch (error) {
    const response = apiError(error);
    return json({ ...await response.json() as object, requestId }, response.status);
  }
}
