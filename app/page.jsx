"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  BadgeCheck,
  CircleCheck,
  CircleX,
  Clock3,
  ExternalLink,
  MailPlus,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Undo2,
  UserX,
  X,
} from "lucide-react";
import { activityRecordStatus } from "./activity-status.mjs";
import { orderAvatarCandidates } from "./avatar-order.mjs";
import { guestStatusDate, guestStatusTimestamp } from "./guest-status-date.mjs";
import { lumaEventManageUrl } from "./luma-event-url.mjs";

const statusLabels = {
  registered: "Registered",
  going: "Going",
  invited: "Invited",
  waitlisted: "Waitlisted",
  checked_in: "Checked in",
  declined: "Declined",
  no_show: "No-show",
};

const activityFilterOptions = [
  { status: "registered", label: "Registered" },
  { status: "checked_in", label: "Checked in" },
  { status: "no_show", label: "No-show" },
  { status: "invited", label: "Invited" },
];

const guestActionIcons = {
  Approve: CircleCheck,
  Waitlist: Clock3,
  Decline: CircleX,
  "Check in": BadgeCheck,
  "No-show": UserX,
  Undo: Undo2,
  Reinvite: MailPlus,
};

const sourceStatusDefaults = ["going", "checked_in"];
const LIVE_WRITE_CONFIRMATION = "CONFIRM_LUMA_WRITE";
const EVENT_PAGE_SIZE = 10;
const EVENT_SCROLL_THRESHOLD = 96;

const initialState = {
  selectedEventId: "",
  selectedPersonId: "",
  selectedGroupId: "",
  filters: {
    event: "upcoming",
    guestStatus: "all",
    guestSearch: "",
    globalSearch: "",
    memberSearch: "",
  },
  invite: {
    targetEventId: "",
    sourceEventId: "",
    sourceStatuses: ["going", "checked_in"],
    includeGroups: [],
    excludeGroups: [],
  },
  groups: [],
  people: [],
  events: [],
};
export default function Home() {
  const [state, setState] = useState(initialState);
  const [apiState, setApiStateValue] = useState({ status: "loading", message: "Checking Luma API" });
  const [toastSequence, setToastSequence] = useState(0);
  const [toastVisible, setToastVisible] = useState(true);
  const [profilePanelOpen, setProfilePanelOpen] = useState(true);
  const [loadingGuestEvents, setLoadingGuestEvents] = useState([]);
  const [eventDraft, setEventDraft] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [universalQuery, setUniversalQuery] = useState("");
  const universalSearchInputRef = useRef(null);
  const guestRequestsRef = useRef(new Set());
  const traceRequestsRef = useRef(new Set());
  const eventListRef = useRef(null);
  const eventEndRef = useRef(null);
  const eventWindowRef = useRef({ start: 0, end: EVENT_PAGE_SIZE });
  const eventPrependSnapshotRef = useRef(null);
  const suppressEventScrollRef = useRef(false);
  const [activityTraces, setActivityTraces] = useState({});
  const [eventWindow, setEventWindow] = useState({ start: 0, end: EVENT_PAGE_SIZE });
  const [newGroup, setNewGroup] = useState({ name: "", color: "#0f766e" });
  const [audienceName, setAudienceName] = useState("");

  const setApiState = (next) => {
    setApiStateValue(next);
    setToastSequence((current) => current + 1);
  };

  useEffect(() => {
    const handleKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setProfilePanelOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (!searchOpen) return;
    window.requestAnimationFrame(() => universalSearchInputRef.current?.focus());
  }, [searchOpen]);

  useEffect(() => {
    if (!apiState.message) return;
    setToastVisible(true);
    if (apiState.status !== "live") return;
    const timeout = window.setTimeout(() => setToastVisible(false), 5000);
    return () => window.clearTimeout(timeout);
  }, [toastSequence, apiState.message, apiState.status]);

  const loadLumaEvents = async ({ cancelled = () => false } = {}) => {
    setApiState({ status: "loading", message: "Checking cached Luma events." });
    try {
      const response = await fetch("/api/luma", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(withRequestId(data.error || "Unable to load Luma data.", data.requestId));
      if (cancelled()) return;
      setState((current) => mergeLumaState(current, data));
      const truncatedText = data.truncated ? " Showing the configured safe event window only." : "";
      const cacheText = data.cached ? "Used cached Luma events." : `Loaded ${data.events.length} Luma events.`;
      const requestText = data.requestId ? ` Request ${data.requestId}.` : "";
      setApiState({ status: "live", message: `${cacheText}${truncatedText}${requestText}` });
    } catch (error) {
      if (cancelled()) return;
      setApiState({ status: "error", message: error.message });
    }
  };

  useEffect(() => {
    let cancelled = false;
    loadLumaEvents({ cancelled: () => cancelled });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedEvent = getEvent(state, state.selectedEventId);
  const selectedEventManageUrl = lumaEventManageUrl(selectedEvent);
  const selectedPerson = getPerson(state, state.selectedPersonId);
  const selectedTrace = selectedPerson ? activityTraces[selectedPerson.id] || { status: "idle", records: [] } : { status: "idle", records: [] };

  const inviteAudience = useMemo(() => computeInviteAudience(state), [state]);
  const filteredEvents = useMemo(() => visibleEvents(state), [state]);
  const eventListKey = `${state.filters.event}:${state.filters.globalSearch.trim().toLowerCase()}`;
  const eventListSignature = filteredEvents.map((event) => `${event.id}:${event.date}`).join("|");
  const eventAnchorId = state.filters.event === "all" ? nearestUpcomingEventId(filteredEvents) : "";
  const renderedEvents = filteredEvents.slice(eventWindow.start, eventWindow.end);
  const visibleGuests = useMemo(() => eventGuests(state, selectedEvent), [state, selectedEvent]);
  const universalResults = useMemo(() => universalSearchResults(state, universalQuery), [state, universalQuery]);
  const universalResultCount = universalResults.events.length + universalResults.people.length + universalResults.groups.length;
  const showGuestGroups = visibleGuests.some(({ person }) => person.groups.length > 0);
  const guestTableColumnCount = 6 + Number(showGuestGroups);
  const hasSelectedProfile = hasProfileContent(state, selectedPerson);
  const showProfilePanel = profilePanelOpen && hasSelectedProfile;
  const inviteTargetEvent = getEvent(state, state.invite.targetEventId);
  const inviteSourceEvent = getEvent(state, state.invite.sourceEventId);
  const selectedEventLoadingGuests = selectedEvent ? loadingGuestEvents.includes(selectedEvent.id) : false;
  const selectedEventNeedsGuestLoad = selectedEvent?.source === "luma" && !selectedEvent.guestsLoaded;
  const inviteSourceLoadingGuests = inviteSourceEvent ? loadingGuestEvents.includes(inviteSourceEvent.id) : false;
  const inviteSourceNeedsGuestLoad = inviteSourceEvent?.source === "luma" && !inviteSourceEvent.guestsLoaded;

  const setEventWindowAndRef = (next) => {
    eventWindowRef.current = next;
    setEventWindow(next);
  };

  const appendEventWindow = () => {
    const current = eventWindowRef.current;
    if (current.end >= filteredEvents.length) return;
    setEventWindowAndRef({ ...current, end: Math.min(filteredEvents.length, current.end + EVENT_PAGE_SIZE) });
  };

  const prependEventWindow = () => {
    if (state.filters.event !== "all") return;
    const current = eventWindowRef.current;
    if (current.start <= 0) return;
    const list = eventListRef.current;
    if (list) {
      const axis = eventListAxis(list);
      eventPrependSnapshotRef.current = {
        axis,
        extent: axis === "horizontal" ? list.scrollWidth : list.scrollHeight,
      };
    }
    setEventWindowAndRef({ ...current, start: Math.max(0, current.start - EVENT_PAGE_SIZE) });
  };

  const handleEventListScroll = (event) => {
    if (suppressEventScrollRef.current) return;
    const list = event.currentTarget;
    const axis = eventListAxis(list);
    const position = axis === "horizontal" ? list.scrollLeft : list.scrollTop;
    const extent = axis === "horizontal" ? list.scrollWidth : list.scrollHeight;
    const viewport = axis === "horizontal" ? list.clientWidth : list.clientHeight;

    if (state.filters.event === "all" && position <= EVENT_SCROLL_THRESHOLD) prependEventWindow();
    if (extent - viewport - position <= EVENT_SCROLL_THRESHOLD) appendEventWindow();
  };

  useLayoutEffect(() => {
    const next = initialEventWindow(filteredEvents, state.filters.event);
    eventPrependSnapshotRef.current = null;
    suppressEventScrollRef.current = true;
    setEventWindowAndRef(next);

    let releaseFrame = 0;
    const positionFrame = window.requestAnimationFrame(() => {
      const list = eventListRef.current;
      if (!list) return;
      const axis = eventListAxis(list);
      if (state.filters.event === "all" && eventAnchorId) {
        const anchor = list.querySelector('[data-event-anchor="true"]');
        if (anchor) centerEventListItem(list, anchor, axis);
      } else if (axis === "horizontal") {
        list.scrollLeft = 0;
      } else {
        list.scrollTop = 0;
      }
      releaseFrame = window.requestAnimationFrame(() => {
        suppressEventScrollRef.current = false;
      });
    });

    return () => {
      window.cancelAnimationFrame(positionFrame);
      window.cancelAnimationFrame(releaseFrame);
      suppressEventScrollRef.current = false;
    };
  }, [eventListKey, eventListSignature, eventAnchorId]);

  useLayoutEffect(() => {
    const snapshot = eventPrependSnapshotRef.current;
    const list = eventListRef.current;
    if (!snapshot || !list) return;
    const nextExtent = snapshot.axis === "horizontal" ? list.scrollWidth : list.scrollHeight;
    const addedExtent = nextExtent - snapshot.extent;
    if (snapshot.axis === "horizontal") list.scrollLeft += addedExtent;
    else list.scrollTop += addedExtent;
    eventPrependSnapshotRef.current = null;
  }, [eventWindow.start]);

  useEffect(() => {
    const root = eventListRef.current;
    const target = eventEndRef.current;
    if (!root || !target || eventWindow.end >= filteredEvents.length) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        const current = eventWindowRef.current;
        if (current.end >= filteredEvents.length) return;
        setEventWindowAndRef({ ...current, end: Math.min(filteredEvents.length, current.end + EVENT_PAGE_SIZE) });
      },
      { root, rootMargin: `${EVENT_SCROLL_THRESHOLD}px` },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [eventListKey, eventListSignature, eventWindow.end]);

  const updateState = (recipe) => {
    setState((current) => {
      const draft = clone(current);
      recipe(draft);
      return normalizeState(draft);
    });
  };

  const openPerson = (personId, eventId) => {
    updateState((draft) => {
      draft.selectedPersonId = personId;
      if (eventId) draft.selectedEventId = eventId;
    });
    setProfilePanelOpen(true);
  };

  const selectEvent = (eventId) => {
    const eventChanged = eventId !== state.selectedEventId;
    updateState((draft) => {
      draft.selectedEventId = eventId;
    });
    if (eventChanged) setProfilePanelOpen(false);
  };

  const setFilter = (key, value) => {
    updateState((draft) => {
      draft.filters[key] = value;
    });
  };

  const setInvite = (key, value) => {
    updateState((draft) => {
      draft.invite[key] = value;
    });
  };

  const loadEventGuests = async (eventId, { force = false } = {}) => {
    const event = getEvent(state, eventId);
    if (!event) {
      setApiState({ status: "error", message: "Could not find event " + eventId + ". Reload the page and try again." });
      return;
    }
    if (event.source !== "luma") {
      setApiState({ status: "error", message: event.title + " is not linked to Luma, so there are no remote guests to load." });
      return;
    }
    if (!force && event.guestsLoaded) {
      return;
    }
    if (guestRequestsRef.current.has(eventId)) return;

    guestRequestsRef.current.add(eventId);
    setLoadingGuestEvents((current) => unique([...current, eventId]));
    try {
      const refresh = force ? "&refresh=1" : "";
      const response = await fetch("/api/luma?event_id=" + encodeURIComponent(eventId) + refresh, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(withRequestId(data.error || (force ? "Unable to sync the Luma event." : "Unable to load Luma guests."), data.requestId));
      setState((current) => mergeLumaGuests(current, data));
      if (force) setActivityTraces({});
      const truncatedText = data.truncated ? " Showing the configured capped guest window only." : "";
      const requestText = data.requestId ? " Request " + data.requestId + "." : "";
      const resultText = force
        ? `Synced ${data.event?.title || event.title} and ${data.guests.length} guests.`
        : `${data.cached ? "Used cached guests for " : "Loaded guests for "}${event.title}.`;
      if (force) setApiState({ status: "live", message: resultText + truncatedText + requestText });
    } catch (error) {
      setApiState({ status: "error", message: error.message });
    } finally {
      guestRequestsRef.current.delete(eventId);
      setLoadingGuestEvents((current) => current.filter((id) => id !== eventId));
    }
  };

  const tracePersonActivity = async (person, { force = false } = {}) => {
    if (!person || traceRequestsRef.current.has(person.id)) return;
    traceRequestsRef.current.add(person.id);
    setActivityTraces((current) => ({
      ...current,
      [person.id]: {
        ...(current[person.id] || {}),
        status: "loading",
        message: force ? "Reconciling activity directly with Luma..." : "Looking up indexed event activity...",
        records: current[person.id]?.records || [],
      },
    }));

    try {
      const params = new URLSearchParams();
      params.set("trace_person_id", person.lumaUserId || person.id);
      if (person.email) params.set("trace_email", person.email);
      if (force) {
        params.set("refresh", "1");
        params.set("trace_scope", "known");
      }
      const response = await fetch("/api/luma?" + params.toString(), { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(withRequestId(data.error || "Unable to trace event activity.", data.requestId));
      const records = data.records || [];
      const truncatedText = data.truncated ? " Scan hit configured limits." : "";
      const requestText = data.requestId ? " Request " + data.requestId + "." : "";
      setActivityTraces((current) => ({
        ...current,
        [person.id]: {
          status: "ready",
          records,
          scanned: data.scanned,
          limits: data.limits,
          truncated: data.truncated,
          requestId: data.requestId,
          loadedAt: data.loadedAt,
          message: `${records.length} records across ${data.scanned?.eventCount || 0} scanned events.${truncatedText}${requestText}`,
        },
      }));
    } catch (error) {
      setActivityTraces((current) => ({
        ...current,
        [person.id]: {
          ...(current[person.id] || {}),
          status: "error",
          message: error.message,
        },
      }));
      setApiState({ status: "error", message: error.message });
    } finally {
      traceRequestsRef.current.delete(person.id);
    }
  };

  useEffect(() => {
    if (selectedEvent?.source !== "luma" || selectedEvent.guestsLoaded) return;
    loadEventGuests(selectedEvent.id);
  }, [selectedEvent?.id, selectedEvent?.source, selectedEvent?.guestsLoaded]);

  useEffect(() => {
    if (selectedPerson?.source !== "luma" || selectedTrace.status !== "idle") return;
    tracePersonActivity(selectedPerson);
  }, [selectedPerson?.id, selectedPerson?.source, selectedTrace.status]);

  const setGuestStatus = async (personId, status) => {
    const event = getEvent(state, state.selectedEventId);
    const guest = event?.guests.find((item) => item.personId === personId);
    const person = getPerson(state, personId);

    if (event?.source === "luma" && guest?.lumaGuestId) {
      try {
        if (status === "invited") {
          await postLumaAction({
            action: "sendInvites",
            confirm: LIVE_WRITE_CONFIRMATION,
            eventId: event.id,
            guests: [{ email: person.email, name: person.name, source: person.source }],
          });
        } else if (["going", "registered", "declined", "waitlisted"].includes(status)) {
          await postLumaAction({
            action: "updateGuestStatus",
            confirm: LIVE_WRITE_CONFIRMATION,
            eventId: event.id,
            guestId: guest.lumaGuestId,
            status,
          });
        } else {
          setApiState({ status: "live", message: `${statusLabels[status]} was not changed because Luma public API does not expose that write.` });
          return;
        }
      } catch (error) {
        setApiState({ status: "error", message: error.message });
        return;
      }
    }

    updateState((draft) => {
      const event = getEvent(draft, draft.selectedEventId);
      const guest = event?.guests.find((item) => item.personId === personId);
      if (!guest) return;
      const changedAt = new Date().toISOString();
      guest.status = status;
      guest.updatedAt = changedAt;
      if (status === "registered" && !guest.registeredAt) guest.registeredAt = changedAt;
      if (status === "going") guest.approvedAt = changedAt;
      if (status === "checked_in") guest.checkedInAt = changedAt;
      if (status === "invited") guest.invitedAt = changedAt;
      draft.selectedPersonId = personId;
    });
  };

  const saveEvent = (event) => {
    event.preventDefault();
    const id = eventDraft.id || `evt-${Date.now()}`;
    updateState((draft) => {
      const existing = getEvent(draft, id);
      const payload = {
        id,
        title: eventDraft.title.trim(),
        date: eventDraft.date,
        location: eventDraft.location.trim(),
        category: eventDraft.category.trim(),
        capacity: Number(eventDraft.capacity),
        lumaUrl: existing?.lumaUrl || `https://lu.ma/${slugify(eventDraft.title)}`,
        guests: existing?.guests || [],
      };
      if (existing) Object.assign(existing, payload);
      else {
        draft.events.push(payload);
        draft.selectedEventId = id;
        draft.invite.targetEventId = id;
      }
    });
    setEventDraft(null);
  };

  const deleteSelectedEvent = () => {
    if (!selectedEvent) return;
    const confirmed = window.confirm(`Delete ${selectedEvent.title}? This only changes the current browser session.`);
    if (!confirmed) return;
    updateState((draft) => {
      draft.events = draft.events.filter((event) => event.id !== selectedEvent.id);
    });
  };

  const sendInvites = async () => {
    const target = getEvent(state, state.invite.targetEventId);
    if (!target) return;
    const guests = inviteAudience.map(({ person }) => ({ email: person.email, name: person.name, source: person.source })).filter((guest) => guest.email);
    const lumaGuests = guests.filter((guest) => guest.source === "luma");
    const guestsToQueue = target.source === "luma" ? lumaGuests : guests;

    if (target.source === "luma") {
      try {
        await postLumaAction({
          action: "sendInvites",
          confirm: LIVE_WRITE_CONFIRMATION,
          eventId: target.id,
          guests: lumaGuests,
        });
      } catch (error) {
        setApiState({ status: "error", message: error.message });
        return;
      }
    }

    updateState((draft) => {
      const nextTarget = getEvent(draft, draft.invite.targetEventId);
      const existing = new Set(nextTarget.guests.map((guest) => guest.personId));
      const queuedEmails = new Set(guestsToQueue.map((guest) => guest.email));
      inviteAudience.forEach(({ person }) => {
        if (!queuedEmails.has(person.email)) return;
        if (!existing.has(person.id)) {
          nextTarget.guests.push({
            personId: person.id,
            status: "invited",
            registeredAt: new Date().toISOString(),
          });
        }
      });
      draft.selectedEventId = nextTarget.id;
    });
    window.alert(`Queued ${guestsToQueue.length} invites for ${target.title}. Existing guests were left unchanged.`);
  };

  const saveAudienceAsGroup = (event) => {
    event.preventDefault();
    const name = audienceName.trim();
    if (!name) return;
    const id = slugify(name);
    updateState((draft) => {
      if (!draft.groups.some((group) => group.id === id)) {
        draft.groups.push({ id, name, color: randomGroupColor(draft.groups.length) });
      }
      inviteAudience.forEach(({ person }) => {
        const target = getPerson(draft, person.id);
        if (target && !target.groups.includes(id)) target.groups.push(id);
      });
      draft.invite.includeGroups = unique([...draft.invite.includeGroups, id]);
      draft.selectedGroupId = id;
    });
    setAudienceName("");
  };

  const addGroup = (event) => {
    event.preventDefault();
    const name = newGroup.name.trim();
    if (!name) return;
    const id = slugify(name);
    updateState((draft) => {
      if (!draft.groups.some((group) => group.id === id)) {
        draft.groups.push({ id, name, color: newGroup.color });
      }
      draft.selectedGroupId = id;
    });
    setNewGroup({ name: "", color: "#0f766e" });
  };

  const toggleMember = (personId, groupId) => {
    updateState((draft) => {
      const person = getPerson(draft, personId);
      if (!person) return;
      if (person.groups.includes(groupId)) person.groups = person.groups.filter((id) => id !== groupId);
      else person.groups.push(groupId);
      draft.selectedPersonId = personId;
    });
  };

  const selectUniversalResult = (result) => {
    const eventChanged = result.type === "event" && result.id !== state.selectedEventId;
    updateState((draft) => {
      if (result.type === "event") {
        draft.selectedEventId = result.id;
        draft.filters.event = "all";
      }
      if (result.type === "person") {
        draft.selectedPersonId = result.id;
        if (result.eventId) {
          draft.selectedEventId = result.eventId;
          draft.filters.event = "all";
        }
      }
      if (result.type === "group") {
        draft.selectedGroupId = result.id;
      }
    });
    if (result.type === "person") setProfilePanelOpen(true);
    if (eventChanged) setProfilePanelOpen(false);
    setSearchOpen(false);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup flex min-w-0 items-center gap-2">
          <img className="brand-mark size-11 shrink-0 object-contain mix-blend-multiply" src="/guestbook-logo.png" alt="" width="44" height="44" />
          <h1 className="text-2xl font-bold tracking-normal">Guestbook</h1>
        </div>
        <button className="command-button" type="button" onClick={() => setSearchOpen(true)}>
          <span className="command-label">
            <Search size={17} aria-hidden="true" />
            <span>Search people, events, groups</span>
          </span>
          <kbd aria-label="Command K"><span aria-hidden="true">⌘</span><span>K</span></kbd>
        </button>
        <div className="topbar-actions">
          <button className="button primary" type="button" onClick={() => setEventDraft(blankEventDraft())}>
            <Plus size={17} aria-hidden="true" />
            New event
          </button>
        </div>
      </header>

      <main className={`workspace ${showProfilePanel ? "" : "workspace-no-profile"}`}>
        <aside className="rail panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Events</p>
              <h2>Calendar</h2>
            </div>
            <span className="count-pill">{filteredEvents.length}</span>
          </div>
          <label className="calendar-search">
            <span>Filter events</span>
            <input
              type="search"
              placeholder="Event name, category, location"
              value={state.filters.globalSearch}
              onChange={(event) => setFilter("globalSearch", event.target.value)}
            />
          </label>
          <div className="segmented" role="tablist" aria-label="Event filter">
            {["upcoming", "past", "all"].map((filter) => (
              <button
                className={`segment ${state.filters.event === filter ? "active" : ""}`}
                type="button"
                key={filter}
                onClick={() => setFilter("event", filter)}
              >
                {titleCase(filter)}
              </button>
            ))}
          </div>
          <div className="event-list" ref={eventListRef} onScroll={handleEventListScroll}>
            {filteredEvents.length ? (
              <>
                {renderedEvents.map((event) => (
                    <button
                      className={`event-card ${event.id === state.selectedEventId ? "active" : ""}`}
                      type="button"
                      key={event.id}
                      data-event-anchor={event.id === eventAnchorId ? "true" : undefined}
                      onClick={() => selectEvent(event.id)}
                    >
                      <EventArtwork event={event} />
                      <div className="event-card-body">
                        <h3>{event.title}</h3>
                        <time className="event-card-date" dateTime={event.date}>{formatDate(event.date)}</time>
                      </div>
                    </button>
                  ))}
                <span className="event-scroll-sentinel" ref={eventEndRef} aria-hidden="true" />
              </>
            ) : (
              <div className="empty-state">No events match this view.</div>
            )}
          </div>
        </aside>

        <section className="main-stack">
          <section className="workbench panel">
            {selectedEvent ? (
              <div className="event-summary">
                <EventArtwork event={selectedEvent} large />
                <div className="event-summary-content">
                  <p className="eyebrow">
                    {selectedEvent.category} - {formatDate(selectedEvent.date)}
                  </p>
                  <h2>{selectedEvent.title}</h2>
                  <div className="event-meta">
                    <span><MapPin size={15} aria-hidden="true" />{selectedEvent.location}</span>
                    <span>{selectedEvent.capacity} capacity</span>
                    {selectedEvent.lumaUrl ? (
                      <a href={selectedEvent.lumaUrl} target="_blank" rel="noreferrer">
                        View on Luma <ExternalLink size={14} aria-hidden="true" />
                      </a>
                    ) : null}
                  </div>
                  <EventStats stats={eventStats(selectedEvent)} />
                </div>
                {selectedEvent.source === "luma" ? (
                  <div className="summary-actions">
                    <button
                      className="button"
                      type="button"
                      disabled={selectedEventLoadingGuests}
                      onClick={() => loadEventGuests(selectedEvent.id, { force: true })}
                    >
                      <RefreshCw className={selectedEventLoadingGuests ? "animate-spin" : ""} size={16} aria-hidden="true" />
                      {selectedEventLoadingGuests ? "Syncing event..." : "Sync event"}
                    </button>
                    {selectedEventManageUrl ? (
                      <a className="button" href={selectedEventManageUrl} target="_blank" rel="noreferrer">
                        <Pencil size={16} aria-hidden="true" />
                        Edit event
                      </a>
                    ) : null}
                  </div>
                ) : (
                  <div className="summary-actions">
                    <button className="button" type="button" onClick={() => setEventDraft(eventToDraft(selectedEvent))}>
                      Edit event
                    </button>
                    <button className="button danger" type="button" onClick={deleteSelectedEvent}>
                      Delete
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="empty-state">Create an event to start managing guests.</div>
            )}

            <div className="workbench-grid">
              <section className="guest-panel">
                <div className="table-toolbar">
                  <div>
                    <p className="eyebrow">Guest queue</p>
                    <h2>Approvals and check-in</h2>
                  </div>
                  <div className="toolbar-controls">
                    <label>
                      <span>Status</span>
                      <select value={state.filters.guestStatus} onChange={(event) => setFilter("guestStatus", event.target.value)}>
                        <option value="all">All</option>
                        {Object.entries(statusLabels).map(([status, label]) => (
                          <option value={status} key={status}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Find</span>
                      <input
                        type="search"
                        placeholder="Name, email, profile"
                        value={state.filters.guestSearch}
                        onChange={(event) => setFilter("guestSearch", event.target.value)}
                      />
                    </label>
                  </div>
                </div>

                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Guest</th>
                        {showGuestGroups ? <th>Groups</th> : null}
                        <th>Status</th>
                        <th className="whitespace-nowrap">Status date</th>
                        <th className="whitespace-nowrap text-center">Events attended</th>
                        <th className="whitespace-nowrap text-center">Events registered</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleGuests.length ? (
                        visibleGuests.map(({ guest, person, history, statusDate }) => {
                          const selectPerson = () => openPerson(person.id);
                          return (
                          <tr
                            className={`guest-row ${state.selectedPersonId === person.id ? "selected" : ""}`}
                            key={person.id}
                            tabIndex={0}
                            aria-label={`View ${person.name}'s profile`}
                            onClick={selectPerson}
                            onKeyDown={(event) => {
                              if (event.target !== event.currentTarget || !["Enter", " "].includes(event.key)) return;
                              event.preventDefault();
                              selectPerson();
                            }}
                          >
                            <td>
                              <PersonButton
                                person={person}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  selectPerson();
                                }}
                              />
                            </td>
                            {showGuestGroups ? (
                              <td>
                                <PersonChips person={person} groups={state.groups} emptyText="-" />
                              </td>
                            ) : null}
                            <td>
                              <StatusPill status={guest.status} />
                            </td>
                            <td>
                              {statusDate ? (
                                <time className="whitespace-nowrap text-xs text-muted" dateTime={statusDate}>
                                  {formatDateTime(statusDate)}
                                </time>
                              ) : (
                                <span className="whitespace-nowrap text-xs text-muted">-</span>
                              )}
                            </td>
                            <td className="text-center text-sm font-semibold tabular-nums">{history.attendedCount}</td>
                            <td className="text-center text-sm font-semibold tabular-nums">{history.registeredCount}</td>
                            <td>
                              <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                                {actionsForStatus(guest.status).map(([label, status]) => {
                                  const ActionIcon = guestActionIcons[label];
                                  return (
                                    <button
                                      className={`guest-action guest-action-${status}`}
                                      type="button"
                                      key={status}
                                      aria-label={`${label} ${person.name}`}
                                      title={label}
                                      onClick={() => setGuestStatus(person.id, status)}
                                    >
                                      <ActionIcon aria-hidden="true" size={14} strokeWidth={2.25} />
                                      <span>{label}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            </td>
                          </tr>
                          );
                        })
                      ) : selectedEventNeedsGuestLoad ? (
                        <tr>
                          <td colSpan={guestTableColumnCount}>
                            <div className="guest-loading-state" role="status" aria-live="polite">
                              <span className="loading-spinner" aria-hidden="true" />
                              <span>{selectedEventLoadingGuests ? "Loading guests" : "Guests unavailable"}</span>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        <tr>
                          <td colSpan={guestTableColumnCount}>
                            <div className="empty-state">No guests match these filters.</div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

            </div>
          </section>

          <details className="accordion invite-shell">
            <summary>
              <span>Invite tooling</span>
              <span>{inviteAudience.length} recipients</span>
            </summary>
            <section className="invite-grid">
            <section className="panel invite-studio">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Invite tooling</p>
                  <h2>Audience builder</h2>
                </div>
                <button className="button primary" type="button" onClick={sendInvites}>
                  Send invites
                </button>
              </div>

              <div className="builder-grid">
                <div className="builder-card">
                  <label className="field-label" htmlFor="inviteTarget">
                    Target event
                  </label>
                  <select id="inviteTarget" value={state.invite.targetEventId} onChange={(event) => setInvite("targetEventId", event.target.value)}>
                    {sortEvents(state.events).map((event) => (
                      <option value={event.id} key={event.id}>
                        {event.title} - {formatDate(event.date)}
                      </option>
                    ))}
                  </select>

                  <label className="field-label" htmlFor="sourceEvent">
                    Pull attendees from event
                  </label>
                  <select id="sourceEvent" value={state.invite.sourceEventId} onChange={(event) => setInvite("sourceEventId", event.target.value)}>
                    {sortEvents(state.events).map((event) => (
                      <option value={event.id} key={event.id}>
                        {event.title} - {formatDate(event.date)}
                      </option>
                    ))}
                  </select>

                  {inviteSourceEvent?.source === "luma" ? (
                    <button
                      className="button"
                      type="button"
                      disabled={inviteSourceLoadingGuests}
                      onClick={() => loadEventGuests(inviteSourceEvent.id, { force: true })}
                    >
                      <RefreshCw className={inviteSourceLoadingGuests ? "animate-spin" : ""} size={16} aria-hidden="true" />
                      {inviteSourceLoadingGuests ? "Syncing source..." : "Sync source event"}
                    </button>
                  ) : null}
                  {inviteSourceNeedsGuestLoad ? <p className="quiet-note">Source event attendees are not loaded yet.</p> : null}

                  <fieldset>
                    <legend>Event statuses</legend>
                    <div className="status-options">
                      {Object.entries(statusLabels).map(([status, label]) => (
                        <label className="check-chip" key={status}>
                          <input
                            type="checkbox"
                            value={status}
                            checked={state.invite.sourceStatuses.includes(status)}
                            onChange={(event) => {
                              const next = toggleValue(state.invite.sourceStatuses, status, event.target.checked);
                              setInvite("sourceStatuses", next.length ? next : sourceStatusDefaults);
                            }}
                          />
                          <span>{label}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </div>

                <GroupChecklist
                  title="Include groups"
                  groups={state.groups}
                  selected={state.invite.includeGroups}
                  onChange={(next) => setInvite("includeGroups", next)}
                />
                <GroupChecklist
                  title="Subtract groups"
                  groups={state.groups}
                  selected={state.invite.excludeGroups}
                  onChange={(next) => setInvite("excludeGroups", next)}
                />
              </div>

              <div className="preview-toolbar">
                <div>
                  <p className="eyebrow">Preview</p>
                  <h3>
                    {inviteAudience.length} recipients for {inviteTargetEvent?.title || "selected event"}
                  </h3>
                </div>
                <form className="inline-form" onSubmit={saveAudienceAsGroup}>
                  <input type="text" placeholder="Save as group" value={audienceName} onChange={(event) => setAudienceName(event.target.value)} />
                  <button className="button" type="submit">
                    Save result
                  </button>
                </form>
              </div>

              <div className="table-wrap preview-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Recipient</th>
                      <th>Why included</th>
                      <th>Last attended</th>
                      <th>Attendance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inviteAudience.length ? (
                      inviteAudience.map(({ person, reasons, history }) => (
                        <tr key={person.id}>
                          <td>
                            <PersonButton person={person} onClick={() => openPerson(person.id)} />
                          </td>
                          <td>{reasons.join(", ")}</td>
                          <td>{history.lastAttended ? formatDate(history.lastAttended.date) : "Never"}</td>
                          <td>
                            {history.attendedCount} / {history.totalInvited} records
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan="4">
                          <div className="empty-state">No one remains after source, group, and subtraction rules.</div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="panel group-manager">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">CRM labels</p>
                  <h2>Groups</h2>
                </div>
              </div>
              <form className="group-form" onSubmit={addGroup}>
                <input
                  type="text"
                  placeholder="New group label"
                  value={newGroup.name}
                  onChange={(event) => setNewGroup((current) => ({ ...current, name: event.target.value }))}
                />
                <input
                  type="color"
                  value={newGroup.color}
                  aria-label="Group color"
                  onChange={(event) => setNewGroup((current) => ({ ...current, color: event.target.value }))}
                />
                <button className="button" type="submit">
                  Add
                </button>
              </form>

              <label className="field-label" htmlFor="manageGroup">
                Manage membership
              </label>
              <select
                id="manageGroup"
                value={state.selectedGroupId}
                onChange={(event) => updateState((draft) => void (draft.selectedGroupId = event.target.value))}
              >
                {state.groups.map((group) => (
                  <option value={group.id} key={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>

              <label className="field-label" htmlFor="memberSearch">
                Find people
              </label>
              <input
                id="memberSearch"
                type="search"
                placeholder="Name or email"
                value={state.filters.memberSearch}
                onChange={(event) => setFilter("memberSearch", event.target.value)}
              />
              <div className="member-list">
                {membersForGroup(state).map((person) => {
                  const isMember = person.groups.includes(state.selectedGroupId);
                  return (
                    <div className="member-row" key={person.id}>
                      <PersonButton person={person} onClick={() => openPerson(person.id)} />
                      <button className="button small" type="button" onClick={() => toggleMember(person.id, state.selectedGroupId)}>
                        {isMember ? "Remove" : "Add"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
            </section>
          </details>
        </section>

        {showProfilePanel ? (
          <ProfilePanel
            state={state}
            person={selectedPerson}
            trace={selectedTrace}
            onTraceActivity={() => tracePersonActivity(selectedPerson, { force: true })}
            onSelectEvent={selectEvent}
            onClose={() => setProfilePanelOpen(false)}
          />
        ) : null}
      </main>

      {apiState.message ? (
        <div
          className={`api-toast toast-${apiState.status} ${toastVisible ? "toast-visible" : "toast-hidden"}`}
          role={apiState.status === "error" ? "alert" : "status"}
          aria-live={apiState.status === "error" ? "assertive" : "polite"}
        >
          <span className="toast-indicator" aria-hidden="true" />
          <span className="toast-content">
            <strong>{apiState.status === "live" ? "Updated" : apiState.status === "loading" ? "Working" : "Needs attention"}</strong>
            <span>{apiState.message}</span>
          </span>
          <button className="toast-close" type="button" aria-label="Dismiss notification" title="Dismiss" onClick={() => setToastVisible(false)}>
            x
          </button>
        </div>
      ) : null}

      {searchOpen ? (
        <UniversalSearchModal
          query={universalQuery}
          results={universalResults}
          resultCount={universalResultCount}
          inputRef={universalSearchInputRef}
          onQueryChange={setUniversalQuery}
          onClose={() => setSearchOpen(false)}
          onSelect={selectUniversalResult}
        />
      ) : null}

      {eventDraft ? (
        <div className="modal-scrim" role="presentation">
          <form className="event-dialog event-form" onSubmit={saveEvent}>
            <div className="dialog-head">
              <div>
                <p className="eyebrow">{eventDraft.id ? "Update" : "Create"}</p>
                <h2>{eventDraft.title || "Event"}</h2>
              </div>
              <button className="icon-button" type="button" aria-label="Close event form" title="Close" onClick={() => setEventDraft(null)}>
                x
              </button>
            </div>
            <div className="form-grid">
              <label>
                <span>Title</span>
                <input value={eventDraft.title} required onChange={(event) => setEventDraft((current) => ({ ...current, title: event.target.value }))} />
              </label>
              <label>
                <span>Date</span>
                <input
                  type="date"
                  value={eventDraft.date}
                  required
                  onChange={(event) => setEventDraft((current) => ({ ...current, date: event.target.value }))}
                />
              </label>
              <label>
                <span>Category</span>
                <input value={eventDraft.category} required onChange={(event) => setEventDraft((current) => ({ ...current, category: event.target.value }))} />
              </label>
              <label>
                <span>Capacity</span>
                <input
                  type="number"
                  min="1"
                  value={eventDraft.capacity}
                  required
                  onChange={(event) => setEventDraft((current) => ({ ...current, capacity: event.target.value }))}
                />
              </label>
              <label className="wide">
                <span>Location</span>
                <input value={eventDraft.location} required onChange={(event) => setEventDraft((current) => ({ ...current, location: event.target.value }))} />
              </label>
            </div>
            <div className="dialog-actions">
              <button className="button ghost" type="button" onClick={() => setEventDraft(null)}>
                Cancel
              </button>
              <button className="button primary" type="submit">
                Save event
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function UniversalSearchModal({ query, results, resultCount, inputRef, onQueryChange, onClose, onSelect }) {
  const hasQuery = query.trim().length > 0;
  return (
    <div className="search-scrim" role="presentation" onMouseDown={onClose}>
      <section className="search-dialog" role="dialog" aria-modal="true" aria-label="Universal search" onMouseDown={(event) => event.stopPropagation()}>
        <div className="search-input-wrap">
          <input
            ref={inputRef}
            type="search"
            placeholder="Search people, events, groups"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <button className="icon-button" type="button" aria-label="Close search" onClick={onClose}>
            x
          </button>
        </div>
        {!hasQuery ? (
          <div className="search-empty">Type a name, email, bio term, event, or group.</div>
        ) : resultCount ? (
          <div className="search-results">
            <SearchSection title="People" results={results.people} onSelect={onSelect} />
            <SearchSection title="Events" results={results.events} onSelect={onSelect} />
            <SearchSection title="Groups" results={results.groups} onSelect={onSelect} />
          </div>
        ) : (
          <div className="search-empty">No results for "{query}".</div>
        )}
      </section>
    </div>
  );
}

function SearchSection({ title, results, onSelect }) {
  if (!results.length) return null;
  return (
    <section className="search-section">
      <p className="eyebrow">{title}</p>
      <div className="search-result-list">
        {results.map((result) => (
          <button className="search-result plain" type="button" key={result.type + "-" + result.id} onClick={() => onSelect(result)}>
            <span className="search-result-kind">{result.kind}</span>
            <span className="search-result-main">
              <strong>{result.title}</strong>
              <span>{result.subtitle}</span>
              {result.detail ? <small>{result.detail}</small> : null}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function EventStats({ stats }) {
  return (
    <div className="summary-stats">
      <div className="summary-stat">
        <strong>{stats.confirmed}</strong>
        <span>Confirmed</span>
      </div>
      <div className="summary-stat">
        <strong>{stats.registered}</strong>
        <span>Registered</span>
      </div>
      <div className="summary-stat">
        <strong>{stats.waitlisted}</strong>
        <span>Waitlist</span>
      </div>
      <div className="summary-stat">
        <strong>{stats.checkedIn}</strong>
        <span>Checked in</span>
      </div>
      <div className="summary-stat">
        <strong>{stats.invited}</strong>
        <span>Invited</span>
      </div>
    </div>
  );
}

function GroupChecklist({ title, groups, selected, onChange }) {
  return (
    <div className="builder-card">
      <div className="builder-subhead">
        <span>{title}</span>
        <span>{selected.length} selected</span>
      </div>
      <div className="chip-grid">
        {groups.map((group) => (
          <label className="check-chip" style={{ "--chip-color": group.color }} key={group.id}>
            <input type="checkbox" checked={selected.includes(group.id)} onChange={(event) => onChange(toggleValue(selected, group.id, event.target.checked))} />
            <span>{group.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function ProfilePanel({ state, person, trace, onTraceActivity, onSelectEvent, onClose }) {
  const [activityFilters, setActivityFilters] = useState(() => activityFilterOptions.map((option) => option.status));

  if (!person || !hasProfileContent(state, person)) return null;

  const history = getPersonHistory(state, person.id);
  const bio = profileBio(person, state);
  const socialLinks = profileSocialLinks(person, state);
  const answerGroups = registrationAnswerGroups(person, state);
  const currentRecord = currentProfileRecord(state, person);
  const currentStatus = currentRecord?.guest.status;
  const loadedActivityRecords = activityRecordsFromHistory(history.records);
  const traceRan = ["loading", "ready", "error"].includes(trace?.status);
  const traceRecords = traceRan ? trace?.records || [] : loadedActivityRecords;
  const filteredTraceRecords = traceRecords.filter((record) => activityFilters.includes(activityRecordStatus(record)));

  const toggleActivityFilter = (status) => {
    setActivityFilters((current) => {
      if (current.includes(status)) return current.length === 1 ? current : current.filter((value) => value !== status);
      return [...current, status];
    });
  };

  return (
    <aside className="profile-panel panel">
      <div className="profile-panel-motion" key={person.id}>
        <div className="profile-head">
          <Avatar person={person} large />
          <div className="profile-identity">
            <h2>{person.name}</h2>
            <p className="person-email">{person.email}</p>
          </div>
          <div className="profile-head-actions">
            {currentStatus ? <StatusPill status={currentStatus} /> : null}
            <button className="profile-close icon-button" type="button" aria-label="Close guest profile" title="Close guest profile" onClick={onClose}>
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        </div>

        {bio ? <p className="profile-bio">{bio}</p> : null}
        <SocialIconLinks links={socialLinks} />
        {currentRecord ? <ProfileContext record={currentRecord} /> : null}

        {answerGroups.length ? (
          <details className="profile-disclosure" open>
            <summary>Registration answers</summary>
            <section className="profile-section">
              {answerGroups.map((group) => (
                <article className="answer-card" key={group.event.id}>
                  <div className="answer-card-head">
                    <strong>{group.event.title}</strong>
                    <span>{formatDate(group.event.date)}</span>
                  </div>
                  <dl className="answer-list">
                    {group.answers.map((answer) => (
                      <div className="answer-row" key={answer.id + answer.label}>
                        <dt>{answer.label}</dt>
                        <dd>{answer.value}</dd>
                      </div>
                    ))}
                  </dl>
                </article>
              ))}
            </section>
          </details>
        ) : null}

        <details className="profile-disclosure" open>
          <summary>Event activity</summary>
          <section className="profile-section">
            <div className="trace-toolbar">
              <button className="button small" type="button" disabled={trace?.status === "loading"} onClick={onTraceActivity}>
                {trace?.status === "loading" ? "Loading activity..." : trace?.status === "ready" ? "Refresh activity" : "Load activity"}
              </button>
            </div>
            {traceRecords.length ? (
              <>
                <fieldset className="trace-filters">
                  <legend>Activity type</legend>
                  <div className="trace-filter-row">
                    <div className="status-options">
                      {activityFilterOptions.map((option) => {
                        const checked = activityFilters.includes(option.status);
                        return (
                          <label className="check-chip" key={option.status}>
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={checked && activityFilters.length === 1}
                              onChange={() => toggleActivityFilter(option.status)}
                            />
                            <span>{option.label}</span>
                          </label>
                        );
                      })}
                    </div>
                    <span className="trace-filter-count">
                      {filteredTraceRecords.length} of {traceRecords.length}
                    </span>
                  </div>
                </fieldset>
                {filteredTraceRecords.length ? (
                  <TraceTimeline records={filteredTraceRecords} traced={traceRan && trace?.records?.length > 0} onSelectEvent={onSelectEvent} />
                ) : (
                  <div className="empty-state">No event activity matches the selected types.</div>
                )}
              </>
            ) : traceRan && trace?.status === "ready" ? (
              <div className="empty-state">No activity found in the scanned event window.</div>
            ) : null}
          </section>
        </details>
      </div>
    </aside>
  );
}

function ProfileContext({ record }) {
  const referrer = referrerLabel(record.guest.referrer);
  return (
    <div className="profile-context">
      {record.guest.registeredAt ? <ProfileFact label="Registration time" value={formatProfileDateTime(record.guest.registeredAt)} tone="registration" /> : null}
      {referrer ? <ProfileFact label="Referrer" value={referrer} tone="referrer" /> : null}
    </div>
  );
}

function ProfileFact({ label, value, tone = "default" }) {
  if (!value) return null;
  return (
    <div className={`profile-fact profile-fact-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SocialIconLinks({ links }) {
  const xLink = links.find((link) => ["x", "twitter"].includes(link.type));
  const linkedinLink = links.find((link) => link.type === "linkedin");
  const iconLinks = [xLink, linkedinLink].filter(Boolean);
  if (!iconLinks.length) return null;

  return (
    <div className="profile-social-links" aria-label="Social profiles">
      {iconLinks.map((link) => (
        <a
          className={`profile-social-link profile-social-${link.type === "linkedin" ? "linkedin" : "x"}`}
          href={link.url}
          target="_blank"
          rel="noreferrer"
          aria-label={link.label || (link.type === "linkedin" ? "LinkedIn" : "X")}
          title={link.display || link.label}
          key={link.type + link.url}
        >
          <img src={link.type === "linkedin" ? "/icons/linkedin.svg" : "/icons/x.svg"} alt="" width="17" height="17" aria-hidden="true" />
        </a>
      ))}
    </div>
  );
}

function TraceTimeline({ records, traced, onSelectEvent }) {
  const orderedRecords = [...records].sort((a, b) => activityRecordSortTime(b) - activityRecordSortTime(a));

  return (
    <div className={`trace-timeline ${traced ? "trace-timeline-live" : ""}`}>
      {orderedRecords.map((record, index) => {
        const meta = activityRecordMeta(record);
        const referrer = referrerLabel(record.referrer);
        const activityStatus = activityRecordStatus(record);
        return (
          <button className="timeline-item plain" type="button" key={record.eventId + "-" + record.lumaGuestId + "-" + record.status + "-" + index} onClick={() => onSelectEvent(record.eventId)}>
            <span className="timeline-marker" />
            <span className="timeline-body">
              <strong>
                {record.eventTitle} <StatusPill status={activityStatus} />
              </strong>
              <span>
                {formatDate(record.eventDate)} - {record.eventCategory}
              </span>
              {meta ? <small>{meta}</small> : null}
              {referrer ? <small>Referrer: {referrer}</small> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function PersonButton({ person, onClick }) {
  return (
    <button className="plain person-cell" type="button" onClick={onClick}>
      <Avatar person={person} />
      <span>
        <span className="person-name">{person.name}</span>
        <span className="person-email">{person.email}</span>
      </span>
    </button>
  );
}

function Avatar({ person, large = false }) {
  const candidates = useMemo(
    () =>
      orderAvatarCandidates(
        ...(person?.avatarCandidates || []),
        person?.avatarUrl,
        person?.id ? `/api/luma/avatar?person_id=${encodeURIComponent(person.id)}` : "",
      ),
    [person?.id, person?.avatarUrl, person?.avatarCandidates],
  );
  const [candidateIndex, setCandidateIndex] = useState(0);
  const avatarUrl = candidates[candidateIndex] || "";

  useEffect(() => setCandidateIndex(0), [person?.id, candidates.join("|")]);

  return (
    <span className={`avatar ${avatarUrl ? "avatar-photo" : ""} ${large ? "avatar-large" : ""}`}>
      <span>{initials(person?.name || "")}</span>
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          loading={large ? "eager" : "lazy"}
          onError={() => setCandidateIndex((current) => current + 1)}
        />
      ) : null}
    </span>
  );
}

function EventArtwork({ event, large = false }) {
  const [imageFailed, setImageFailed] = useState(false);
  const date = new Date(`${event.date}T12:00:00`);
  const month = Number.isNaN(date.getTime()) ? "EVENT" : date.toLocaleDateString("en-US", { month: "short" }).toUpperCase();
  const day = Number.isNaN(date.getTime()) ? "" : date.getDate();

  useEffect(() => setImageFailed(false), [event.id, event.imageUrl]);

  return (
    <span className={`event-artwork ${large ? "event-artwork-large" : ""}`} aria-hidden="true">
      <span className="event-artwork-fallback">
        <strong>{month}</strong>
        <span>{day}</span>
      </span>
      {event.imageUrl && !imageFailed ? <img src={event.imageUrl} alt="" onError={() => setImageFailed(true)} /> : null}
    </span>
  );
}

function PersonChips({ person, groups, emptyText = "" }) {
  const personGroups = groupsForPerson(person, groups);
  if (!personGroups.length) return emptyText ? <span className="person-email">{emptyText}</span> : null;
  return (
    <div className="chips">
      {personGroups.map((group) => (
        <span className="chip" style={{ "--chip-color": group.color }} key={group.id}>
          {group.name}
        </span>
      ))}
    </div>
  );
}

function StatusPill({ status }) {
  return <span className={`status-pill status-${status}`}>{statusLabels[status] || status}</span>;
}

function withRequestId(message, requestId) {
  return requestId ? message + " (request " + requestId + ")" : message;
}

async function postLumaAction(payload) {
  const response = await fetch("/api/luma", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(withRequestId(data.error || data.message || "Luma request failed.", data.requestId));
  return data;
}

function mergeLumaGuests(current, lumaData) {
  const existingPeople = new Map();
  current.people.forEach((person) => {
    existingPeople.set(person.id, person);
    if (person.email) existingPeople.set(person.email.toLowerCase(), person);
  });

  const peopleById = new Map(current.people.map((person) => [person.id, person]));
  lumaData.people.forEach((person) => {
    const existing = existingPeople.get(person.id) || existingPeople.get(person.email?.toLowerCase());
    peopleById.set(person.id, mergePersonRecord(existing, person));
  });

  const people = [...peopleById.values()];
  const events = current.events.map((event) =>
    event.id === lumaData.eventId
      ? {
          ...event,
          ...(lumaData.event || {}),
          guests: lumaData.guests,
          guestsLoaded: true,
          guestLoadTruncated: lumaData.truncated,
        }
      : event,
  );

  return normalizeState({
    ...current,
    events,
    people,
    selectedPersonId: current.selectedPersonId || people[0]?.id || "",
  });
}

function mergeLumaState(current, lumaData) {
  const existingPeople = new Map();
  current.people.forEach((person) => {
    existingPeople.set(person.id, person);
    if (person.email) existingPeople.set(person.email.toLowerCase(), person);
  });

  const people = lumaData.people.map((person) => {
    const existing = existingPeople.get(person.id) || existingPeople.get(person.email?.toLowerCase());
    return mergePersonRecord(existing, person);
  });

  return normalizeState({
    ...current,
    source: "luma",
    loadedAt: lumaData.loadedAt,
    events: lumaData.events,
    people,
    selectedEventId: lumaData.events.some((event) => event.id === current.selectedEventId) ? current.selectedEventId : lumaData.events[0]?.id || "",
    selectedPersonId: people.some((person) => person.id === current.selectedPersonId) ? current.selectedPersonId : people[0]?.id || "",
    invite: {
      ...current.invite,
      targetEventId: lumaData.events.some((event) => event.id === current.invite.targetEventId) ? current.invite.targetEventId : lumaData.events[0]?.id || "",
      sourceEventId: lumaData.events.some((event) => event.id === current.invite.sourceEventId) ? current.invite.sourceEventId : lumaData.events[0]?.id || "",
    },
  });
}

function mergePersonRecord(existing, incoming) {
  const existingNote = existing?.notes && !existing.notes.startsWith("Imported from Luma") ? existing.notes : "";
  const avatarCandidates = orderAvatarCandidates(
    incoming.avatarCandidates || [],
    incoming.avatarUrl,
    existing?.avatarCandidates || [],
    existing?.avatarUrl,
  );
  return {
    ...incoming,
    groups: existing?.groups || incoming.groups || [],
    notes: existingNote || incoming.notes,
    title: existing?.title && existing.title !== "Luma guest" ? existing.title : incoming.title,
    profileDescription: incoming.profileDescription || existing?.profileDescription || "",
    bio: incoming.bio || incoming.profileDescription || existing?.bio || existing?.profileDescription || "",
    avatarUrl: avatarCandidates[0] || "",
    avatarCandidates,
    profileUrl: incoming.profileUrl || existing?.profileUrl || "",
    lumaUserId: incoming.lumaUserId || existing?.lumaUserId || "",
    socialLinks: mergeProfileSocialLinks(existing?.socialLinks || [], incoming.socialLinks || []),
    referrer: incoming.referrer || existing?.referrer || null,
  };
}

function normalizeState(value) {
  const next = {
    ...initialState,
    ...value,
    filters: { ...initialState.filters, ...value?.filters },
    invite: { ...initialState.invite, ...value?.invite },
  };
  if (!next.events.some((event) => event.id === next.selectedEventId)) {
    next.selectedEventId = sortEvents(next.events)[0]?.id || "";
  }
  if (!next.people.some((person) => person.id === next.selectedPersonId)) {
    next.selectedPersonId = next.people[0]?.id || "";
  }
  if (!next.groups.some((group) => group.id === next.selectedGroupId)) {
    next.selectedGroupId = next.groups[0]?.id || "";
  }
  if (!next.events.some((event) => event.id === next.invite.targetEventId)) {
    next.invite.targetEventId = upcomingEvents(next)[0]?.id || next.events[0]?.id || "";
  }
  if (!next.events.some((event) => event.id === next.invite.sourceEventId)) {
    next.invite.sourceEventId = pastEvents(next)[0]?.id || next.events[0]?.id || "";
  }
  return next;
}

function visibleEvents(state) {
  const query = state.filters.globalSearch.trim().toLowerCase();
  const events = sortEvents(state.events)
    .filter((event) => {
      if (state.filters.event === "upcoming") return isUpcoming(event);
      if (state.filters.event === "past") return !isUpcoming(event);
      return true;
    })
    .filter((event) => {
      if (!query) return true;
      return [event.title, event.category, event.location].some((value) => value.toLowerCase().includes(query));
    });
  return state.filters.event === "past" ? events.reverse() : events;
}

function initialEventWindow(events, filter) {
  if (filter !== "all") return { start: 0, end: Math.min(events.length, EVENT_PAGE_SIZE) };
  if (!events.length) return { start: 0, end: 0 };

  const upcomingIndex = events.findIndex(isUpcoming);
  const anchorIndex = upcomingIndex >= 0 ? upcomingIndex : events.length - 1;
  let start = Math.max(0, anchorIndex - 4);
  let end = Math.min(events.length, anchorIndex + 6);
  if (end - start < EVENT_PAGE_SIZE) {
    if (start === 0) end = Math.min(events.length, EVENT_PAGE_SIZE);
    else start = Math.max(0, end - EVENT_PAGE_SIZE);
  }
  return { start, end };
}

function nearestUpcomingEventId(events) {
  return events.find(isUpcoming)?.id || events.at(-1)?.id || "";
}

function eventListAxis(list) {
  return window.matchMedia("(max-width: 820px)").matches && list.scrollWidth > list.clientWidth ? "horizontal" : "vertical";
}

function centerEventListItem(list, item, axis) {
  const listRect = list.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  if (axis === "horizontal") {
    list.scrollLeft += itemRect.left - listRect.left - (list.clientWidth - itemRect.width) / 2;
  } else {
    list.scrollTop += itemRect.top - listRect.top - (list.clientHeight - itemRect.height) / 2;
  }
}

function universalSearchResults(state, query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return { people: [], events: [], groups: [] };

  return {
    people: state.people
      .map((person) => ({ person, text: personSearchText(state, person), eventId: mostRecentPersonEventId(state, person.id) }))
      .filter(({ text }) => text.includes(normalized))
      .slice(0, 8)
      .map(({ person, eventId, text }) => ({
        type: "person",
        kind: "Person",
        id: person.id,
        eventId,
        title: person.name,
        subtitle: person.email || "No email",
        detail: searchSnippet(text, normalized) || personGroupsLabel(state, person),
      })),
    events: sortEvents(state.events)
      .filter((event) => eventSearchText(event).includes(normalized))
      .slice(0, 6)
      .map((event) => ({
        type: "event",
        kind: "Event",
        id: event.id,
        title: event.title,
        subtitle: formatDate(event.date) + " - " + event.location,
        detail: event.category,
      })),
    groups: state.groups
      .filter((group) => groupSearchText(state, group).includes(normalized))
      .slice(0, 6)
      .map((group) => ({
        type: "group",
        kind: "Group",
        id: group.id,
        title: group.name,
        subtitle: groupMemberCount(state, group.id) + " people",
        detail: groupSearchDetail(state, group),
      })),
  };
}

function eventSearchText(event) {
  return [event.title, event.category, event.location, event.lumaUrl].filter(Boolean).join(" ").toLowerCase();
}

function groupSearchText(state, group) {
  const members = state.people.filter((person) => person.groups.includes(group.id));
  return [group.name, ...members.map((person) => personSearchText(state, person))].join(" ").toLowerCase();
}

function groupSearchDetail(state, group) {
  const members = state.people.filter((person) => person.groups.includes(group.id)).slice(0, 3).map((person) => person.name);
  return members.length ? members.join(", ") : "No members yet";
}

function groupMemberCount(state, groupId) {
  return state.people.filter((person) => person.groups.includes(groupId)).length;
}

function personSearchText(state, person) {
  const groups = groupsForPerson(person, state.groups).map((group) => group.name);
  const guestText = personGuestRecords(state, person.id).flatMap(({ event, guest }) => [
    event.title,
    event.category,
    guest.profileDescription,
    guest.searchText,
    registrationAnswerText(guest.registrationAnswers),
    socialLinksText(guest.socialLinks),
    referrerLabel(guest.referrer),
  ]);
  return [
    person.name,
    person.email,
    person.title,
    person.profileDescription,
    person.bio,
    person.notes,
    socialLinksText(person.socialLinks),
    referrerLabel(person.referrer),
    ...groups,
    ...guestText,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function personGroupsLabel(state, person) {
  const groups = groupsForPerson(person, state.groups).map((group) => group.name);
  return groups.length ? groups.join(", ") : "Loaded guest";
}

function personGuestRecords(state, personId) {
  return state.events.flatMap((event) => event.guests.filter((guest) => guest.personId === personId).map((guest) => ({ event, guest })));
}

function mostRecentPersonEventId(state, personId) {
  return personGuestRecords(state, personId).sort((a, b) => new Date(b.event.date) - new Date(a.event.date))[0]?.event.id || "";
}

function searchSnippet(text, query) {
  const index = text.indexOf(query);
  if (index < 0) return "";
  const start = Math.max(0, index - 42);
  const end = Math.min(text.length, index + query.length + 58);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return prefix + text.slice(start, end).trim() + suffix;
}

function eventGuests(state, event) {
  if (!event) return [];
  const query = state.filters.guestSearch.trim().toLowerCase();
  return event.guests
    .map((guest) => ({
      guest,
      person: getPerson(state, guest.personId),
      history: personHistoryForGuest(state, guest),
      statusDate: guestStatusDate(guest, event),
      statusTimestamp: guestStatusTimestamp(guest, event),
    }))
    .filter(({ guest, person }) => {
      if (!person) return false;
      const matchesStatus = state.filters.guestStatus === "all" || guest.status === state.filters.guestStatus;
      const matchesSearch = !query || searchableGuestText(person, guest).includes(query);
      return matchesStatus && matchesSearch;
    })
    .sort(
      (a, b) =>
        b.statusTimestamp - a.statusTimestamp ||
        a.person.name.localeCompare(b.person.name) ||
        a.person.id.localeCompare(b.person.id),
    );
}

function personHistoryForGuest(state, guest) {
  const history = getPersonHistory(state, guest.personId);
  if (!guest.eventCounts) return history;
  return {
    ...history,
    attendedCount: nonnegativeCount(guest.eventCounts.attended, history.attendedCount),
    registeredCount: nonnegativeCount(guest.eventCounts.registered, history.registeredCount),
  };
}

function nonnegativeCount(value, fallback) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : fallback;
}

function searchableGuestText(person, guest = {}) {
  return [
    person.name,
    person.email,
    person.profileDescription,
    person.bio,
    socialLinksText(person.socialLinks),
    referrerLabel(person.referrer),
    guest.profileDescription,
    guest.searchText,
    registrationAnswerText(guest.registrationAnswers),
    socialLinksText(guest.socialLinks),
    referrerLabel(guest.referrer),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function groupsForPerson(person, groups) {
  return (person?.groups || []).map((groupId) => groups.find((group) => group.id === groupId)).filter(Boolean);
}

function profileBio(person, state) {
  return firstPresent(
    person?.bio,
    person?.profileDescription,
    ...personGuestRecords(state, person?.id).map(({ guest }) => guest.profileDescription),
  );
}

function profileSocialLinks(person, state) {
  const guestLinks = personGuestRecords(state, person.id).flatMap(({ guest }) => guest.socialLinks || []);
  return mergeProfileSocialLinks(person.socialLinks || [], guestLinks);
}

function mergeProfileSocialLinks(...groups) {
  const links = new Map();
  groups.flat().filter(Boolean).map(normalizeProfileSocialLink).forEach((link) => {
    const key = (link.type || link.label || "link") + ":" + (link.url || link.display || "").toLowerCase();
    if (!links.has(key)) links.set(key, link);
  });
  return [...links.values()];
}

function normalizeProfileSocialLink(link) {
  if (link.type !== "linkedin") return link;
  const url = String(link.url || "").replace(/\/in\/in%2f/i, "/in/");
  const display = /^@?\/?in\//i.test(link.display || "") ? url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "") : link.display;
  return { ...link, url, display };
}

function registrationAnswerGroups(person, state) {
  return personGuestRecords(state, person.id)
    .map(({ event, guest }) => ({
      event,
      answers: (guest.registrationAnswers || []).filter((answer) => answer.value),
    }))
    .filter((group) => group.answers.length)
    .sort((a, b) => new Date(b.event.date) - new Date(a.event.date));
}

function currentProfileRecord(state, person) {
  const records = personGuestRecords(state, person.id);
  return records.find(({ event }) => event.id === state.selectedEventId) || records[0] || null;
}

function activityRecordsFromHistory(records) {
  return records.map(({ event, guest }) => ({
    eventId: event.id,
    eventTitle: event.title,
    eventDate: event.date,
    eventStartsAt: event.startsAt,
    eventCategory: event.category,
    eventLocation: event.location,
    eventUrl: event.lumaUrl,
    lumaGuestId: guest.lumaGuestId || guest.personId,
    status: guest.status,
    registeredAt: guest.registeredAt,
    invitedAt: guest.invitedAt,
    checkedInAt: guest.checkedInAt,
    approvedAt: guest.approvedAt,
    registrationAnswers: guest.registrationAnswers || [],
    referrer: guest.referrer || null,
    sortAt: guest.checkedInAt || guest.registeredAt || event.startsAt || event.date,
  }));
}

function registrationAnswerText(answers = []) {
  return answers.map((answer) => [answer.label, answer.value].filter(Boolean).join(" ")).filter(Boolean).join(" ");
}

function socialLinksText(links = []) {
  return links.map((link) => [link.label, link.display, link.url].filter(Boolean).join(" ")).join(" ");
}

function referrerLabel(referrer) {
  if (!referrer) return "";
  return [referrer.name, referrer.email, referrer.source, referrer.url].filter(Boolean).join(" - ");
}

function activityRecordMeta(record) {
  const parts = [];
  if (record.registeredAt) parts.push("Registered " + formatDateTime(record.registeredAt));
  if (record.checkedInAt) parts.push("Checked in " + formatDateTime(record.checkedInAt));
  if (record.invitedAt) parts.push("Invited " + formatDateTime(record.invitedAt));
  return parts.join(" - ");
}

function activityRecordSortTime(record) {
  const value = record.eventStartsAt || record.eventDate || record.sortAt || record.checkedInAt || record.registeredAt || record.invitedAt;
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function hasMeaningfulHistory(history) {
  return Boolean(history?.attendedCount || history?.noShowCount || history?.totalInvited > 1);
}

function hasProfileContent(state, person) {
  if (!person) return false;
  const history = getPersonHistory(state, person.id);
  return Boolean(
    person.name ||
      person.email ||
      profileBio(person, state) ||
      profileSocialLinks(person, state).length ||
      registrationAnswerGroups(person, state).length ||
      person.avatarUrl ||
      person.profileUrl ||
      hasMeaningfulHistory(history) ||
      Object.keys(history.categories).length,
  );
}

function computeInviteAudience(state) {
  const sourceEvent = getEvent(state, state.invite.sourceEventId);
  const exclude = new Set();
  state.people.forEach((person) => {
    if (person.groups.some((groupId) => state.invite.excludeGroups.includes(groupId))) exclude.add(person.id);
  });

  const recipients = new Map();
  sourceEvent?.guests.forEach((guest) => {
    if (state.invite.sourceStatuses.includes(guest.status)) {
      addRecipient(recipients, getPerson(state, guest.personId), `${sourceEvent.title}: ${statusLabels[guest.status]}`);
    }
  });

  state.people.forEach((person) => {
    person.groups.forEach((groupId) => {
      if (state.invite.includeGroups.includes(groupId)) {
        const group = getGroup(state, groupId);
        addRecipient(recipients, person, group ? `${group.name} group` : "Selected group");
      }
    });
  });

  return [...recipients.values()]
    .filter(({ person }) => !exclude.has(person.id))
    .map((item) => ({ ...item, history: getPersonHistory(state, item.person.id) }))
    .sort((a, b) => {
      const aLast = a.history.lastAttended ? new Date(a.history.lastAttended.date).getTime() : 0;
      const bLast = b.history.lastAttended ? new Date(b.history.lastAttended.date).getTime() : 0;
      return bLast - aLast || a.person.name.localeCompare(b.person.name);
    });
}

function addRecipient(recipients, person, reason) {
  if (!person) return;
  if (!recipients.has(person.id)) recipients.set(person.id, { person, reasons: [] });
  recipients.get(person.id).reasons.push(reason);
}

function membersForGroup(state) {
  const query = state.filters.memberSearch.trim().toLowerCase();
  return [...state.people]
    .filter((person) => !query || person.name.toLowerCase().includes(query) || person.email.toLowerCase().includes(query))
    .sort((a, b) => Number(b.groups.includes(state.selectedGroupId)) - Number(a.groups.includes(state.selectedGroupId)) || a.name.localeCompare(b.name));
}

function getPersonHistory(state, personId) {
  const records = sortEvents(state.events)
    .flatMap((event) =>
      event.guests
        .filter((guest) => guest.personId === personId)
        .map((guest) => ({
          event,
          guest,
        })),
    )
    .sort((a, b) => new Date(b.event.date) - new Date(a.event.date));

  const attendedRecords = records.filter(({ guest }) => guest.status === "checked_in" || Boolean(guest.checkedInAt));
  const registeredRecords = records.filter(({ guest }) => ["registered", "going", "waitlisted", "checked_in", "declined", "no_show"].includes(guest.status));
  const noShowRecords = records.filter(({ guest }) => guest.status === "no_show");
  const categories = {};
  attendedRecords.forEach(({ event }) => {
    categories[event.category] = (categories[event.category] || 0) + 1;
  });

  const denominator = attendedRecords.length + noShowRecords.length;
  return {
    records,
    attendedCount: attendedRecords.length,
    registeredCount: registeredRecords.length,
    noShowCount: noShowRecords.length,
    totalInvited: records.length,
    firstEvent: records.length ? records[records.length - 1].event : null,
    lastAttended: attendedRecords[0]?.event || null,
    attendanceRate: denominator ? Math.round((attendedRecords.length / denominator) * 100) : 0,
    categories,
  };
}

function eventStats(event) {
  const stats = {
    confirmed: 0,
    registered: 0,
    waitlisted: 0,
    checkedIn: 0,
    invited: 0,
  };
  event.guests.forEach((guest) => {
    if (["going", "checked_in"].includes(guest.status)) stats.confirmed += 1;
    if (guest.status === "registered") stats.registered += 1;
    if (guest.status === "waitlisted") stats.waitlisted += 1;
    if (guest.status === "checked_in") stats.checkedIn += 1;
    if (guest.status === "invited") stats.invited += 1;
  });
  return stats;
}

function actionsForStatus(status) {
  if (status === "registered") return [["Approve", "going"], ["Waitlist", "waitlisted"], ["Decline", "declined"]];
  if (status === "waitlisted") return [["Approve", "going"], ["Decline", "declined"]];
  if (status === "going") return [["Check in", "checked_in"], ["No-show", "no_show"]];
  if (status === "invited") return [["Approve", "going"], ["Decline", "declined"]];
  if (status === "checked_in") return [["Undo", "going"]];
  if (status === "declined") return [["Reinvite", "invited"]];
  if (status === "no_show") return [["Reinvite", "invited"]];
  return [];
}

function getEvent(state, id) {
  return state.events.find((event) => event.id === id);
}

function getPerson(state, id) {
  return state.people.find((person) => person.id === id);
}

function getGroup(state, id) {
  return state.groups.find((group) => group.id === id);
}

function upcomingEvents(state) {
  return sortEvents(state.events).filter(isUpcoming);
}

function pastEvents(state) {
  return sortEvents(state.events).filter((event) => !isUpcoming(event));
}

function sortEvents(events) {
  return [...events].sort((a, b) => new Date(a.date) - new Date(b.date));
}

function isUpcoming(event) {
  const eventDate = String(event.date || "").slice(0, 10);
  return Boolean(eventDate) && eventDate >= localDateKey();
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatProfileDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const includeYear = date.getFullYear() !== new Date().getFullYear();
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function initials(name) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function slugify(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function randomGroupColor(index) {
  const colors = ["#0f766e", "#2563eb", "#7c3aed", "#b45309", "#be123c", "#3f6212"];
  return colors[index % colors.length];
}

function toggleValue(values, value, shouldInclude) {
  return shouldInclude ? unique([...values, value]) : values.filter((item) => item !== value);
}

function unique(values) {
  return [...new Set(values)];
}

function firstPresent(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function blankEventDraft() {
  return {
    id: "",
    title: "",
    date: localDateKey(),
    category: "",
    capacity: 40,
    location: "",
  };
}

function eventToDraft(event) {
  return {
    id: event.id,
    title: event.title,
    date: event.date,
    category: event.category,
    capacity: event.capacity,
    location: event.location,
  };
}
