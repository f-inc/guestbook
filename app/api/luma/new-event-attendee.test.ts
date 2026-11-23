import assert from "node:assert/strict";
import { test } from "node:test";
import { isNewEventAttendee } from "./new-event-attendee";
import { guestFilterRequiresIndex, parseGuestListQuery } from "./guest-query";
const at = (day: number) => new Date(`2026-11-${String(day).padStart(2,"0")}T12:00:00Z`);
const row = (eventId: string, checkedInAt: Date | null, status = "registered") => ({ eventId, personId:"person", emailLower:"person@example.test", registeredAt:at(1), approvedAt:null, checkedInAt, status });
const events = new Map([1,10,15].map(day => [String(day), {eventId:String(day), title:"Event", startsAt:at(day), endsAt:at(day), category:null, location:null}]));
test("New ignores earlier registration and no-shows, but excludes actual earlier attendance", () => {
 const current=row("10",at(10),"checked_in");
 for (const status of ["invited","registered","going","no_show"]) assert.equal(isNewEventAttendee(current,[row("1",null,status),current],events),true);
 assert.equal(isNewEventAttendee(current,[row("1",at(1)),current],events),false);
 assert.equal(isNewEventAttendee(current,[row("1",null,"checked_in"),current],events),false);
 assert.equal(isNewEventAttendee(current,[current,row("15",at(15),"checked_in")],events),true);
});
test("registration and acceptance use event date; repeated visits only make the first visit new", () => {
 const first=row("10",at(10),"checked_in"), second=row("15",at(15),"checked_in");
 assert.equal(isNewEventAttendee(first,[first,second],events),true);
 assert.equal(isNewEventAttendee(second,[first,second],events),false);
 assert.equal(isNewEventAttendee(row("10",null),[row("1",at(1)),row("10",null)],events),false);
 assert.equal(isNewEventAttendee(row("10",null),[row("1",null),row("10",null)],events),true);
});
test("new attendance drilldown filters survive parsing and require indexed history", () => {
 for(const filter of ["new_attendee_registered","new_attendee_accepted","new_attendee_checked_in"]){
 assert.equal(parseGuestListQuery(new URLSearchParams({guest_status:filter})).filter,filter);
 assert.equal(guestFilterRequiresIndex(filter as any),true);
 }
});
