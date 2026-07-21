"use client";

import type { CSSProperties } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowRight,
  BadgeCheck,
  BarChart3,
  Bold,
  ChevronDown,
  CircleCheck,
  CircleX,
  Clock3,
  Code2,
  Eye,
  ExternalLink,
  FileText,
  Gem,
  Italic,
  Link2,
  List,
  Lock,
  ListFilter,
  MailPlus,
  Mail,
  MapPin,
  MessageSquare,
  Pencil,
  Plus,
  Quote,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Tag,
  Undo2,
  UserMinus,
  UserPlus,
  Users,
  UserX,
  X,
} from "lucide-react";
import { activityRecordStatus } from "./activity-status";
import { orderAvatarCandidates } from "./avatar-order";
import { guestStatusDate, guestStatusTimestamp } from "./guest-status-date";
import { MAX_INVITE_MESSAGE_LENGTH } from "./invite-message";
import { MAX_GUEST_STATUS_MESSAGE_LENGTH } from "./guest-status-notification";
import { lumaEventManageUrl } from "./luma-event-url";
import { buildRegistrationQuestionAnalytics, eventWideAnalyticsCounts, REFERRED_PERSON_TAG } from "./event-analytics";
import {
  EVENT_SWITCH_DIAGNOSTICS_ACTION,
  EVENT_SWITCH_DIAGNOSTICS_PARAM,
} from "./event-switch-diagnostics";
import { buildWorkspaceUrlSearch, parseWorkspaceUrl, type WorkspaceUrlState } from "./workspace-url";

const statusLabels = {
  registered: "Registered",
  going: "Accepted",
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
const acceptedStatuses = ["going", "checked_in", "no_show"];
const registeredStatuses = ["registered", "waitlisted", ...acceptedStatuses];
const registrationStatuses = ["registered", "going", "waitlisted", "checked_in", "declined", "no_show"];
const LIVE_WRITE_CONFIRMATION = "CONFIRM_LUMA_WRITE";
const EVENT_PAGE_SIZE = 10;
const EVENT_SCROLL_THRESHOLD = 96;
const GUEST_PAGE_SIZE = 25;
const GUEST_SEARCH_DEBOUNCE_MS = 250;
const MAX_GUEST_NOTE_LENGTH = 20_000;
const UPCOMING_AUTO_SYNC_MAX_EVENTS = 100;
const UPCOMING_AUTO_SYNC_STALE_MINUTES = 5;
const guestFilterOptions = [
  { value: "all", label: "All guests" },
  { value: "to_decide", label: "To Decide" },
  { value: "checked_in", label: "Checked in" },
  { value: "accepted", label: "Accepted" },
  { value: "registered", label: "Registered" },
  { value: "invited", label: "Invited" },
  { value: "waitlisted", label: "Waitlisted" },
  { value: "first_registers", label: "First Registers" },
  { value: "new_faces", label: "New faces" },
  { value: "declined", label: "Declined" },
  { value: "no_show", label: "No-show" },
];
const eventTabs = [
  { id: "overview", label: "Overview", icon: Users },
  { id: "invite", label: "Invite", icon: Send },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
];
const inviteMessageTemplates = [
  { id: "past-attendee", label: "Past attendee", message: (event) => `We'd love to have you back for ${event?.title || "our next event"}. Hope you can join us.` },
  { id: "builder-community", label: "Builder community", message: (event) => `${event?.title || "This event"} felt relevant to what you're building. We'd be glad to have you there.` },
  { id: "personal-invite", label: "Personal invite", message: (event) => `I'd love for you to join us at ${event?.title || "this event"}. Let me know if you can make it.` },
];
const SESSION_KEY_STORAGE_KEY = "guestbook.sessionKey";
const SESSION_KEY_HEADER = "x-guestbook-session-key";
const SESSION_KEY_COOKIE = "guestbook_session_key";
const TAG_COLOR_PALETTE = ["#0f766e", "#2563eb", "#7c3aed", "#db2777", "#dc2626", "#d97706", "#65a30d", "#475569"];
const AUTOMATIC_TAG_EMOJIS = {
  "superpower user": "🚀",
  "power user": "⚡",
  "festival dweller": "🎪",
  flaker: "👻",
  superflaker: "💀",
};

const initialState = {
  selectedEventId: "",
  selectedPersonId: "",
  selectedGroupId: "",
  filters: {
    event: "upcoming",
    guestStatus: "all",
    guestSearch: "",
    guestTags: [],
    globalSearch: "",
    memberSearch: "",
  },
  invite: {
    targetEventId: "",
    sourceEventId: "",
    sourceStatuses: ["going", "checked_in"],
    includeEventIds: [],
    excludeEventIds: [],
    includeGroups: [],
    excludeGroups: [],
    includePeople: [],
    excludePeople: [],
  },
  groups: [],
  tags: [],
  tagDefinitions: [],
  people: [],
  events: [],
};
export default function Home() {
  const [state, setState] = useState(initialState);
  const [workspaceUrlReady, setWorkspaceUrlReady] = useState(false);
  const [guestPageTarget, setGuestPageTarget] = useState(1);
  const workspaceUrlModeRef = useRef<"push" | "replace">("replace");
  const pendingProfileIdRef = useRef("");
  const [apiState, setApiStateValue] = useState({ status: "loading", message: "Checking Luma API" });
  const [toastSequence, setToastSequence] = useState(0);
  const [toastVisible, setToastVisible] = useState(true);
  const [profilePanelOpen, setProfilePanelOpen] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<{ person: any; url: string } | null>(null);
  const avatarPreviewRef = useRef<{ person: any; url: string } | null>(null);
  const [activeEventTab, setActiveEventTab] = useState("overview");
  const [loadingGuestEvents, setLoadingGuestEvents] = useState([]);
  const [eventDraft, setEventDraft] = useState(null);
  const [guestStatusDraft, setGuestStatusDraft] = useState(null);
  const [guestNoteDraft, setGuestNoteDraft] = useState(null);
  const [openTagPersonId, setOpenTagPersonId] = useState("");
  const [savingTagPersonId, setSavingTagPersonId] = useState("");
  const [tagSettingsOpen, setTagSettingsOpen] = useState(false);
  const [tagSettingsSaving, setTagSettingsSaving] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [universalQuery, setUniversalQuery] = useState("");
  const universalSearchInputRef = useRef(null);
  const guestRequestsRef = useRef(new Set());
  const latestGuestRequestRef = useRef(new Map());
  const analyticsRequestsRef = useRef(new Set());
  const guestHistoryRequestsRef = useRef(new Set());
  // EVENT_SWITCH_DIAGNOSTICS: temporary per-navigation state; remove with the shared diagnostics module.
  const eventSwitchDiagnosticRef = useRef<any>(null);
  const traceRequestsRef = useRef(new Set());
  const upcomingSyncInFlightRef = useRef(false);
  const eventListRef = useRef(null);
  const eventEndRef = useRef(null);
  const eventWindowRef = useRef({ start: 0, end: EVENT_PAGE_SIZE });
  const eventPrependSnapshotRef = useRef(null);
  const suppressEventScrollRef = useRef(false);
  const [activityTraces, setActivityTraces] = useState({});
  const [eventWindow, setEventWindow] = useState({ start: 0, end: EVENT_PAGE_SIZE });
  const [newGroup, setNewGroup] = useState({ name: "", color: "#0f766e" });
  const [audienceName, setAudienceName] = useState("");
  const [inviteMessage, setInviteMessage] = useState("");
  const [inviteTemplateId, setInviteTemplateId] = useState("");
  const [debouncedGuestSearch, setDebouncedGuestSearch] = useState("");
  const [selectedGuestIds, setSelectedGuestIds] = useState(new Set());
  const [bulkSendEmail, setBulkSendEmail] = useState(false);
  const [bulkMessage, setBulkMessage] = useState("");
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [upcomingSyncVersion, setUpcomingSyncVersion] = useState(0);
  const [sessionStatus, setSessionStatus] = useState("checking");
  const [sessionKey, setSessionKey] = useState("");
  const [sessionKeyDraft, setSessionKeyDraft] = useState("");
  const [sessionError, setSessionError] = useState("");

  const setApiState = (next) => {
    setApiStateValue(next);
    setToastSequence((current) => current + 1);
  };

  const applyWorkspaceUrlState = (urlState: WorkspaceUrlState) => {
    workspaceUrlModeRef.current = "replace";
    pendingProfileIdRef.current = urlState.profileId;
    setGuestPageTarget(urlState.guestPage);
    setActiveEventTab(urlState.tab);
    setProfilePanelOpen(Boolean(urlState.profileId));
    setState((current) => ({
      ...current,
      selectedEventId: urlState.eventId || current.selectedEventId,
      selectedPersonId: urlState.profileId || current.selectedPersonId,
      filters: {
        ...current.filters,
        event: urlState.eventView,
        globalSearch: urlState.eventSearch,
        guestStatus: urlState.guestStatus,
        guestSearch: urlState.guestSearch,
        guestTags: urlState.guestTags,
      },
      invite: {
        ...current.invite,
        targetEventId: urlState.eventId || current.invite.targetEventId,
      },
    }));
  };

  useLayoutEffect(() => {
    applyWorkspaceUrlState(parseWorkspaceUrl(window.location.search));
    setWorkspaceUrlReady(true);
    const handlePopState = () => applyWorkspaceUrlState(parseWorkspaceUrl(window.location.search));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    avatarPreviewRef.current = avatarPreview;
  }, [avatarPreview]);

  const lockSession = (message = "") => {
    window.localStorage.removeItem(SESSION_KEY_STORAGE_KEY);
    clearSessionCookie();
    setSessionKey("");
    setSessionStatus("locked");
    setSessionError(message);
    setState(initialState);
    setActivityTraces({});
    setSearchOpen(false);
    setProfilePanelOpen(false);
    setAvatarPreview(null);
  };

  const apiFetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const response = await sessionFetch(sessionKey, input, init);
    if (response.status === 401) lockSession("That session key is no longer valid.");
    return response;
  };

  useEffect(() => {
    let cancelled = false;
    const storedKey = window.localStorage.getItem(SESSION_KEY_STORAGE_KEY) || "";
    setSessionKeyDraft(storedKey);
    if (!storedKey) {
      setSessionStatus("locked");
      return;
    }

    verifySessionKey(storedKey).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        writeSessionCookie(storedKey);
        setSessionKey(storedKey);
        setSessionStatus("ready");
        setSessionError("");
        return;
      }
      if (result.status === 401) {
        window.localStorage.removeItem(SESSION_KEY_STORAGE_KEY);
        clearSessionCookie();
      }
      setSessionStatus("locked");
      setSessionError(result.error);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const submitSessionKey = async (event) => {
    event.preventDefault();
    const nextKey = sessionKeyDraft.trim();
    if (!nextKey) {
      setSessionError("Enter a session key.");
      return;
    }

    setSessionStatus("checking");
    setSessionError("");
    const result = await verifySessionKey(nextKey);
    if (!result.ok) {
      setSessionStatus("locked");
      setSessionError(result.error);
      return;
    }

    window.localStorage.setItem(SESSION_KEY_STORAGE_KEY, nextKey);
    writeSessionCookie(nextKey);
    setSessionKey(nextKey);
    setSessionStatus("ready");
  };

  useEffect(() => {
    const handleKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === "Escape") {
        if (avatarPreviewRef.current) {
          event.preventDefault();
          setAvatarPreview(null);
          return;
        }
        setSearchOpen(false);
        setProfilePanelOpen(false);
        setGuestStatusDraft((current) => current?.submitting ? current : null);
        setGuestNoteDraft((current) => current?.saving ? current : null);
        setOpenTagPersonId("");
        setTagSettingsOpen(false);
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

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedGuestSearch(state.filters.guestSearch.trim()),
      GUEST_SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [state.filters.guestSearch]);

  const syncUpcomingEvents = async (events, { reason = "load" } = {}) => {
    const eventIds = unique(
      (events || [])
        .filter((event) => event.source === "luma" && isUpcoming(event))
        .map((event) => event.id)
        .filter(Boolean),
    ).slice(0, UPCOMING_AUTO_SYNC_MAX_EVENTS);
    if (!eventIds.length || upcomingSyncInFlightRef.current) return null;

    upcomingSyncInFlightRef.current = true;
    try {
      const response = await apiFetch("/api/luma/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "upcoming",
          trigger: reason,
          eventIds,
          maxEvents: eventIds.length,
          staleAfterMinutes: UPCOMING_AUTO_SYNC_STALE_MINUTES,
        }),
      });
      const data: any = await response.json();
      if (!response.ok || (data.ok === false && data.status !== "partial_error")) {
        throw new Error(withRequestId(data.error || "Unable to sync upcoming events.", data.requestId));
      }
      if (data.status === "already_running") return data;

      if (data.refreshedEventCount > 0) {
        setUpcomingSyncVersion((current) => current + 1);
        setActivityTraces({});
        setApiState({
          status: "live",
          message: data.failedEventCount
            ? `Updated ${data.refreshedEventCount} upcoming event${data.refreshedEventCount === 1 ? "" : "s"}; skipped ${data.failedEventCount} unavailable event${data.failedEventCount === 1 ? "" : "s"}.`
            : `Updated ${data.refreshedEventCount} upcoming event${data.refreshedEventCount === 1 ? "" : "s"}.`,
        });
      } else if (data.failedEventCount) {
        setApiState({
          status: "error",
          message: withRequestId(`Skipped ${data.failedEventCount} unavailable upcoming event${data.failedEventCount === 1 ? "" : "s"}.`, data.requestId),
        });
      }
      return data;
    } catch (error) {
      setApiState({ status: "error", message: error.message });
      return null;
    } finally {
      upcomingSyncInFlightRef.current = false;
    }
  };

  const loadLumaEvents = async ({ cancelled = () => false }: { cancelled?: () => boolean } = {}) => {
    setApiState({ status: "loading", message: "Checking cached Luma events." });
    try {
      const response = await apiFetch("/api/luma", { cache: "no-store" });
      const data: any = await response.json();
      if (!response.ok) throw new Error(withRequestId(data.error || "Unable to load Luma data.", data.requestId));
      if (cancelled()) return;
      setState((current) => mergeLumaState(current, data));
      const truncatedText = data.truncated ? " Showing the configured safe event window only." : "";
      const cacheText = data.cached ? "Used cached Luma events." : `Loaded ${data.events.length} Luma events.`;
      const requestText = data.requestId ? ` Request ${data.requestId}.` : "";
      setApiState({ status: "live", message: `${cacheText}${truncatedText}${requestText}` });
      return data;
    } catch (error) {
      if (cancelled()) return;
      setApiState({ status: "error", message: error.message });
      return null;
    }
  };

  const loadAvailableTags = async () => {
    try {
      const response = await apiFetch("/api/tags", { cache: "no-store" });
      const data: any = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to load guest tags.");
      const tagDefinitions = Array.isArray(data.tags) ? data.tags : [];
      setState((current) => normalizeState({
        ...current,
        tags: tagDefinitions.map((tag) => tag.name),
        tagDefinitions,
      }));
    } catch (error) {
      setApiState({ status: "error", message: error.message });
    }
  };

  useEffect(() => {
    if (!workspaceUrlReady || sessionStatus !== "ready" || !sessionKey) return;
    let cancelled: boolean = false;
    loadLumaEvents({ cancelled: () => cancelled }).then((data) => {
      if (!cancelled && data?.events) void syncUpcomingEvents(data.events, { reason: "load" });
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceUrlReady, sessionStatus, sessionKey]);

  useEffect(() => {
    if (sessionStatus !== "ready" || !sessionKey) return;
    void loadAvailableTags();
  }, [sessionStatus, sessionKey]);

  useEffect(() => {
    if (sessionStatus !== "ready" || !sessionKey) return;
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void syncUpcomingEvents(state.events, { reason: "tab_active" });
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [sessionStatus, sessionKey, state.events]);

  const selectedEvent = getEvent(state, state.selectedEventId);
  const selectedEventManageUrl = lumaEventManageUrl(selectedEvent);
  const selectedPerson = getPerson(state, state.selectedPersonId);
  const selectedTrace = selectedPerson ? activityTraces[selectedPerson.id] || { status: "idle", records: [] } : { status: "idle", records: [] };

  const inviteAudience = useMemo(() => computeInviteAudience(state), [state]);
  const selectedEventAnalytics = useMemo(() => buildEventAnalytics(state, selectedEvent), [state, selectedEvent]);
  const filteredEvents = useMemo(() => visibleEvents(state), [state]);
  const eventListKey = `${state.filters.event}:${state.filters.globalSearch.trim().toLowerCase()}`;
  const eventListSignature = filteredEvents.map((event) => `${event.id}:${event.date}`).join("|");
  const eventAnchorId = state.filters.event === "all" ? nearestUpcomingEventId(filteredEvents) : "";
  const renderedEvents = filteredEvents.slice(eventWindow.start, eventWindow.end);
  const visibleGuests = useMemo(() => eventGuests(state, selectedEvent), [state, selectedEvent]);
  const guestTagFilterKey = state.filters.guestTags.join("\u0000");
  const universalResults = useMemo(() => universalSearchResults(state, universalQuery), [state, universalQuery]);
  const universalResultCount = universalResults.events.length + universalResults.people.length + universalResults.groups.length;
  const showGuestGroups = visibleGuests.some(({ person }) => person.groups.length > 0);
  const guestTableColumnCount = 10 + Number(showGuestGroups);
  const hasSelectedProfile = hasProfileContent(state, selectedPerson);
  const showProfilePanel = profilePanelOpen && hasSelectedProfile;
  const inviteTargetEvent = getEvent(state, state.invite.targetEventId);
  const selectedEventLoadingGuests = selectedEvent ? loadingGuestEvents.includes(selectedEvent.id) : false;
  const selectedEventNeedsGuestLoad = selectedEvent?.source === "luma" && !selectedEvent.guestsLoaded;
  const selectedGuestRows = visibleGuests.filter(({ person }) => selectedGuestIds.has(person.id));
  const allVisibleGuestsSelected = visibleGuests.length > 0 && visibleGuests.every(({ person }) => selectedGuestIds.has(person.id));
  const loadedGuestPage = Math.max(1, Math.ceil((selectedEvent?.guests?.length || 0) / GUEST_PAGE_SIZE));

  useEffect(() => {
    const pendingProfileId = pendingProfileIdRef.current;
    if (!workspaceUrlReady || !pendingProfileId) return;
    const pendingPerson = getPerson(state, pendingProfileId);
    if (!pendingPerson) return;
    if (state.selectedPersonId === pendingProfileId) {
      pendingProfileIdRef.current = "";
      return;
    }
    setState((current) => ({ ...current, selectedPersonId: pendingProfileId }));
    setProfilePanelOpen(true);
  }, [workspaceUrlReady, state.people, state.selectedPersonId]);

  useEffect(() => {
    if (!workspaceUrlReady || !state.events.length || !selectedEvent) return;
    const profileId = profilePanelOpen
      ? pendingProfileIdRef.current || selectedPerson?.id || ""
      : "";
    const nextSearch = buildWorkspaceUrlSearch(window.location.search, {
      eventId: selectedEvent.id,
      eventView: state.filters.event as WorkspaceUrlState["eventView"],
      eventSearch: state.filters.globalSearch.trim(),
      tab: activeEventTab as WorkspaceUrlState["tab"],
      guestStatus: state.filters.guestStatus,
      guestSearch: state.filters.guestSearch.trim(),
      guestTags: state.filters.guestTags,
      guestPage: Math.max(guestPageTarget, loadedGuestPage),
      profileId,
    });
    const currentSearch = window.location.search.replace(/^\?/, "");
    const mode = workspaceUrlModeRef.current;
    workspaceUrlModeRef.current = "replace";
    if (nextSearch === currentSearch) return;
    const nextUrl = new URL(window.location.href);
    nextUrl.search = nextSearch;
    window.history[mode === "push" ? "pushState" : "replaceState"]({}, "", nextUrl);
  }, [
    workspaceUrlReady,
    state.events.length,
    selectedEvent?.id,
    activeEventTab,
    profilePanelOpen,
    selectedPerson?.id,
    state.filters.event,
    state.filters.globalSearch,
    state.filters.guestStatus,
    state.filters.guestSearch,
    guestTagFilterKey,
    guestPageTarget,
    loadedGuestPage,
  ]);

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
    const next = initialEventWindow(filteredEvents, state.filters.event, selectedEvent?.id);
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
  }, [eventListKey, eventListSignature, eventAnchorId, selectedEvent?.id]);

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

  // EVENT_SWITCH_DIAGNOSTICS: all browser lifecycle instrumentation is contained in these helpers.
  const beginEventSwitchDiagnostic = (eventId: string) => {
    eventSwitchDiagnosticRef.current = {
      id: `switch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      eventId,
      tab: activeEventTab,
      startedAt: window.performance.now(),
      expiresAt: Date.now() + 5_000,
      timings: { click: 0 },
      completed: false,
      serverRequestId: "",
      cached: false,
      rowCount: 0,
    };
  };

  const eventSwitchDiagnosticForEvent = (eventId: string) => {
    const diagnostic = eventSwitchDiagnosticRef.current;
    return diagnostic && diagnostic.eventId === eventId && Date.now() < diagnostic.expiresAt ? diagnostic : null;
  };

  const activeEventSwitchDiagnostic = (eventId: string) => {
    const diagnostic = eventSwitchDiagnosticForEvent(eventId);
    return diagnostic && !diagnostic.completed ? diagnostic : null;
  };

  const markEventSwitchDiagnostic = (eventId: string, stage: string, details: Record<string, any> = {}) => {
    const diagnostic = activeEventSwitchDiagnostic(eventId);
    if (!diagnostic) return null;
    diagnostic.timings[stage] = Math.round((window.performance.now() - diagnostic.startedAt) * 10) / 10;
    Object.assign(diagnostic, details);
    return diagnostic;
  };

  const completeEventSwitchDiagnostic = (eventId: string, outcome: "rendered" | "error" = "rendered") => {
    const diagnostic = markEventSwitchDiagnostic(eventId, outcome === "rendered" ? "active_tab_painted" : "failed");
    if (!diagnostic) return;
    diagnostic.completed = true;
    void apiFetch("/api/luma", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: EVENT_SWITCH_DIAGNOSTICS_ACTION,
        diagnosticId: diagnostic.id,
        eventId: diagnostic.eventId,
        tab: diagnostic.tab,
        outcome,
        serverRequestId: diagnostic.serverRequestId,
        cached: diagnostic.cached,
        rowCount: diagnostic.rowCount,
        timings: diagnostic.timings,
      }),
      keepalive: true,
    }).catch(() => {});
  };

  const openPerson = (personId: string, eventId = "") => {
    workspaceUrlModeRef.current = "push";
    pendingProfileIdRef.current = "";
    updateState((draft) => {
      draft.selectedPersonId = personId;
      if (eventId) draft.selectedEventId = eventId;
    });
    setProfilePanelOpen(true);
  };

  const selectEvent = (eventId) => {
    const eventChanged = eventId !== state.selectedEventId;
    if (eventChanged) beginEventSwitchDiagnostic(eventId);
    if (eventChanged) workspaceUrlModeRef.current = "push";
    pendingProfileIdRef.current = "";
    setGuestPageTarget(1);
    updateState((draft) => {
      draft.selectedEventId = eventId;
      draft.invite.targetEventId = eventId;
    });
    if (eventChanged) setProfilePanelOpen(false);
  };

  const setFilter = (key, value) => {
    if (["guestStatus", "guestSearch", "guestTags"].includes(key)) setGuestPageTarget(1);
    updateState((draft) => {
      draft.filters[key] = value;
    });
  };

  const setInvite = (key, value) => {
    updateState((draft) => {
      draft.invite[key] = value;
    });
  };

  const loadEventGuests = async (
    eventId: string,
    {
      force = false,
      append = false,
      status = state.filters.guestStatus,
      search = debouncedGuestSearch,
      tags = state.filters.guestTags,
      cursor = "",
      priority = false,
      background = false,
    }: { force?: boolean; append?: boolean; status?: string; search?: string; tags?: string[]; cursor?: string; priority?: boolean; background?: boolean } = {},
  ) => {
    const event = getEvent(state, eventId);
    if (!event) {
      setApiState({ status: "error", message: "Could not find event " + eventId + ". Reload the page and try again." });
      return;
    }
    if (event.source !== "luma") {
      setApiState({ status: "error", message: event.title + " is not linked to Luma, so there are no remote guests to load." });
      return;
    }
    const nextCursor = append ? cursor || event.guestPageInfo?.nextCursor || "" : "";
    if (append && !nextCursor) return;

    const params = new URLSearchParams({
      event_id: eventId,
      guest_status: status,
      guest_limit: String(GUEST_PAGE_SIZE),
    });
    if (search) params.set("guest_search", search);
    if (event.startsAt) params.set("event_starts_at", event.startsAt);
    if (event.date) params.set("event_date", String(event.date).slice(0, 10));
    tags.forEach((tag) => params.append("guest_tag", tag));
    if (nextCursor) params.set("guest_cursor", nextCursor);
    if (!force && event.guestStats) params.set("guest_summary", "0");
    if (priority && !force) params.set("guest_mode", "page");
    if (force) params.set("refresh", "1");
    // EVENT_SWITCH_DIAGNOSTICS: only the active event navigation receives the correlation parameter.
    const eventSwitchDiagnostic = eventSwitchDiagnosticForEvent(eventId);
    const eventSwitchStage = background ? "snapshot" : priority ? "overview" : "guests";
    if (eventSwitchDiagnostic) {
      params.set(EVENT_SWITCH_DIAGNOSTICS_PARAM, eventSwitchDiagnostic.id);
      markEventSwitchDiagnostic(eventId, `${eventSwitchStage}_request_started`);
    }
    const requestKey = params.toString();
    if (guestRequestsRef.current.has(requestKey)) return;

    const requestToken = Symbol(requestKey);
    latestGuestRequestRef.current.set(eventId, requestToken);
    guestRequestsRef.current.add(requestKey);
    if (!append) {
      setState((current) => ({
        ...current,
        events: current.events.map((item) => item.id === eventId ? {
          ...item,
          ...(background ? { guestSnapshotWarming: true } : { guests: [], guestQueryLoading: true }),
        } : item),
      }));
    }

    if (!background) setLoadingGuestEvents((current) => unique([...current, eventId]));
    try {
      const response = await apiFetch("/api/luma?" + params.toString(), { cache: "no-store" });
      const data: any = await response.json();
      if (!response.ok) throw new Error(withRequestId(data.error || (force ? "Unable to sync the Luma event." : "Unable to load Luma guests."), data.requestId));
      markEventSwitchDiagnostic(eventId, `${eventSwitchStage}_response_received`, {
        serverRequestId: data.requestId || "",
        cached: Boolean(data.cached),
        rowCount: Array.isArray(data.guests) ? data.guests.length : 0,
      });
      if (latestGuestRequestRef.current.get(eventId) !== requestToken) return;
      setState((current) => mergeLumaGuests(current, data, { append }));
      if (append) {
        const loadedThrough = (Number.parseInt(nextCursor, 10) || 0) + (Array.isArray(data.guests) ? data.guests.length : 0);
        setGuestPageTarget(Math.max(1, Math.ceil(loadedThrough / GUEST_PAGE_SIZE)));
      }
      markEventSwitchDiagnostic(eventId, `${eventSwitchStage}_state_update_queued`);
      if (force) setActivityTraces({});
      const truncatedText = data.truncated ? " Showing the configured capped guest window only." : "";
      const requestText = data.requestId ? " Request " + data.requestId + "." : "";
      const resultText = force
        ? `Synced ${data.event?.title || event.title} and ${data.pageInfo?.total ?? data.guests.length} matching guests.`
        : `${data.cached ? "Used cached guests for " : "Loaded guests for "}${event.title}.`;
      if (force) setApiState({ status: "live", message: resultText + truncatedText + requestText });
    } catch (error) {
      if (activeEventSwitchDiagnostic(eventId)) completeEventSwitchDiagnostic(eventId, "error");
      if (latestGuestRequestRef.current.get(eventId) === requestToken) {
        setState((current) => ({
          ...current,
          events: current.events.map((item) => item.id === eventId ? { ...item, guestQueryLoading: false, guestSnapshotWarming: false } : item),
        }));
        if (!background) setApiState({ status: "error", message: error.message });
      }
    } finally {
      guestRequestsRef.current.delete(requestKey);
      if (latestGuestRequestRef.current.get(eventId) === requestToken) {
        if (!background) setLoadingGuestEvents((current) => current.filter((id) => id !== eventId));
      }
    }
  };

  const loadEventAnalytics = async (eventId: string) => {
    const event = getEvent(state, eventId);
    if (!event || event.source !== "luma" || analyticsRequestsRef.current.has(eventId)) return;
    analyticsRequestsRef.current.add(eventId);
    setState((current) => ({
      ...current,
      events: current.events.map((item) => item.id === eventId ? { ...item, analyticsLoading: true } : item),
    }));

    try {
      const params = new URLSearchParams({ event_id: eventId, event_analytics: "1" });
      if (event.startsAt) params.set("event_starts_at", event.startsAt);
      if (event.date) params.set("event_date", String(event.date).slice(0, 10));
      const eventSwitchDiagnostic = eventSwitchDiagnosticForEvent(eventId);
      if (eventSwitchDiagnostic) {
        params.set(EVENT_SWITCH_DIAGNOSTICS_PARAM, eventSwitchDiagnostic.id);
        markEventSwitchDiagnostic(eventId, "analytics_request_started");
      }
      const response = await apiFetch("/api/luma?" + params.toString(), { cache: "no-store" });
      const data: any = await response.json();
      if (!response.ok) throw new Error(withRequestId(data.error || "Unable to load event analytics.", data.requestId));
      markEventSwitchDiagnostic(eventId, "analytics_response_received", {
        serverRequestId: data.requestId || "",
        rowCount: Number(data.stats?.registered) || 0,
      });
      setState((current) => ({
        ...current,
        events: current.events.map((item) => item.id === eventId ? {
          ...item,
          guestStats: data.stats || item.guestStats,
          guestAnalyticsQuestions: data.analyticsQuestions || item.guestAnalyticsQuestions || [],
          analyticsLoaded: true,
          analyticsLoading: false,
        } : item),
      }));
      markEventSwitchDiagnostic(eventId, "analytics_state_update_queued");
    } catch (error) {
      if (activeEventSwitchDiagnostic(eventId)) completeEventSwitchDiagnostic(eventId, "error");
      setState((current) => ({
        ...current,
        events: current.events.map((item) => item.id === eventId ? { ...item, analyticsLoading: false } : item),
      }));
      setApiState({ status: "error", message: error.message });
    } finally {
      analyticsRequestsRef.current.delete(eventId);
    }
  };

  const loadEventGuestHistory = async (eventId: string, personIds: string[]) => {
    const boundedPersonIds = [...new Set(personIds.filter(Boolean))].slice(0, GUEST_PAGE_SIZE);
    if (!boundedPersonIds.length) return;
    const requestKey = `${eventId}:${boundedPersonIds.join(",")}`;
    if (guestHistoryRequestsRef.current.has(requestKey)) return;
    guestHistoryRequestsRef.current.add(requestKey);
    setState((current) => ({
      ...current,
      events: current.events.map((item) => item.id === eventId ? { ...item, guestHistoryLoading: true } : item),
    }));

    try {
      const params = new URLSearchParams({ event_id: eventId, guest_history: "1" });
      boundedPersonIds.forEach((personId) => params.append("person_id", personId));
      const eventSwitchDiagnostic = eventSwitchDiagnosticForEvent(eventId);
      if (eventSwitchDiagnostic) params.set(EVENT_SWITCH_DIAGNOSTICS_PARAM, eventSwitchDiagnostic.id);
      const response = await apiFetch("/api/luma?" + params.toString(), { cache: "no-store" });
      const data: any = await response.json();
      if (!response.ok) throw new Error(withRequestId(data.error || "Unable to load guest event history.", data.requestId));
      const countsByPerson = new Map((data.counts || []).map((counts) => [counts.personId, counts]));
      setState((current) => ({
        ...current,
        events: current.events.map((item) => item.id === eventId ? {
          ...item,
          guests: item.guests.map((guest) => {
            const counts: any = countsByPerson.get(guest.personId);
            return counts ? { ...guest, eventCounts: { attended: counts.attended, registered: counts.registered } } : guest;
          }),
          guestHistoryLoaded: true,
          guestHistoryLoading: false,
        } : item),
      }));
    } catch {
      setState((current) => ({
        ...current,
        events: current.events.map((item) => item.id === eventId ? {
          ...item,
          guestHistoryLoaded: true,
          guestHistoryLoading: false,
        } : item),
      }));
    } finally {
      guestHistoryRequestsRef.current.delete(requestKey);
    }
  };

  const tracePersonActivity = async (person: any, { force = false }: { force?: boolean } = {}) => {
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
      const response = await apiFetch("/api/luma?" + params.toString(), { cache: "no-store" });
      const data: any = await response.json();
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
    setSelectedGuestIds(new Set());
  }, [selectedEvent?.id, state.filters.guestStatus, debouncedGuestSearch, guestTagFilterKey]);

  // EVENT_SWITCH_DIAGNOSTICS: records the first React commit containing the newly selected event shell.
  useLayoutEffect(() => {
    if (selectedEvent?.id) markEventSwitchDiagnostic(selectedEvent.id, "event_shell_committed");
  }, [selectedEvent?.id]);

  useEffect(() => {
    if (sessionStatus !== "ready" || selectedEvent?.source !== "luma" || activeEventTab !== "overview") return;
    void loadEventGuests(selectedEvent.id, {
      status: state.filters.guestStatus,
      search: debouncedGuestSearch,
      tags: state.filters.guestTags,
      priority: !selectedEvent.guestsLoaded,
    });
  }, [sessionStatus, selectedEvent?.id, selectedEvent?.source, activeEventTab, state.filters.guestStatus, debouncedGuestSearch, guestTagFilterKey, upcomingSyncVersion]);

  useEffect(() => {
    if (
      sessionStatus !== "ready" ||
      selectedEvent?.source !== "luma" ||
      activeEventTab !== "overview" ||
      !selectedEvent.guestsLoaded ||
      selectedEvent.guestQueryLoading ||
      selectedEvent.guestHistoryLoaded !== false ||
      selectedEvent.guestHistoryLoading
    ) return;
    const personIds = selectedEvent.guests
      .filter((guest) => !guest.eventCounts)
      .map((guest) => guest.personId)
      .slice(0, GUEST_PAGE_SIZE);
    if (!personIds.length) return;
    void loadEventGuestHistory(selectedEvent.id, personIds);
  }, [sessionStatus, selectedEvent?.id, selectedEvent?.source, selectedEvent?.guestsLoaded, selectedEvent?.guestQueryLoading, selectedEvent?.guestHistoryLoaded, selectedEvent?.guestHistoryLoading, activeEventTab]);

  useEffect(() => {
    if (sessionStatus !== "ready" || selectedEvent?.source !== "luma" || selectedEvent.analyticsLoaded || selectedEvent.analyticsLoading) return;
    if (activeEventTab === "analytics") {
      void loadEventAnalytics(selectedEvent.id);
      return;
    }
    if (
      activeEventTab !== "overview" ||
      !selectedEvent.guestsLoaded ||
      selectedEvent.guestQueryLoading ||
      selectedEvent.guestHistoryLoading ||
      selectedEvent.guestHistoryLoaded === false
    ) return;
    const timer = window.setTimeout(() => void loadEventAnalytics(selectedEvent.id), 120);
    return () => window.clearTimeout(timer);
  }, [sessionStatus, selectedEvent?.id, selectedEvent?.source, selectedEvent?.guestsLoaded, selectedEvent?.guestQueryLoading, selectedEvent?.guestHistoryLoaded, selectedEvent?.guestHistoryLoading, selectedEvent?.analyticsLoaded, selectedEvent?.analyticsLoading, activeEventTab]);

  useEffect(() => {
    if (
      sessionStatus !== "ready" ||
      selectedEvent?.source !== "luma" ||
      !selectedEvent.analyticsLoaded ||
      selectedEvent.guestSnapshotReady ||
      selectedEvent.guestSnapshotWarming
    ) return;
    const timer = window.setTimeout(() => {
      void loadEventGuests(selectedEvent.id, {
        status: state.filters.guestStatus,
        search: debouncedGuestSearch,
        tags: state.filters.guestTags,
        background: true,
      });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [sessionStatus, selectedEvent?.id, selectedEvent?.source, selectedEvent?.analyticsLoaded, selectedEvent?.guestSnapshotReady, selectedEvent?.guestSnapshotWarming, state.filters.guestStatus, debouncedGuestSearch, guestTagFilterKey]);

  // EVENT_SWITCH_DIAGNOSTICS: completes after the active tab's data has committed and reached a paint frame.
  useEffect(() => {
    const diagnostic = selectedEvent ? activeEventSwitchDiagnostic(selectedEvent.id) : null;
    if (!diagnostic || diagnostic.tab !== activeEventTab) return;
    const activeTabReady = diagnostic.tab === "invite"
      || (diagnostic.tab === "analytics" && selectedEvent.analyticsLoaded && !selectedEvent.analyticsLoading)
      || (diagnostic.tab === "overview" && selectedEvent.guestsLoaded && !selectedEvent.guestQueryLoading);
    if (!activeTabReady) return;
    const frame = window.requestAnimationFrame(() => completeEventSwitchDiagnostic(selectedEvent.id));
    return () => window.cancelAnimationFrame(frame);
  }, [activeEventTab, selectedEvent?.id, selectedEvent?.guestsLoaded, selectedEvent?.guestQueryLoading, selectedEvent?.analyticsLoaded, selectedEvent?.analyticsLoading]);

  const loadMoreGuests = () => {
    if (!selectedEvent || selectedEvent.source !== "luma" || selectedEventLoadingGuests || !selectedEvent.guestPageInfo?.hasMore) return;
    void loadEventGuests(selectedEvent.id, {
      append: true,
      status: state.filters.guestStatus,
      search: debouncedGuestSearch,
      tags: state.filters.guestTags,
      cursor: selectedEvent.guestPageInfo.nextCursor,
    });
  };

  useEffect(() => {
    if (
      guestPageTarget <= loadedGuestPage ||
      sessionStatus !== "ready" ||
      activeEventTab !== "overview" ||
      selectedEvent?.source !== "luma" ||
      !selectedEvent.guestsLoaded ||
      selectedEvent.guestQueryLoading ||
      selectedEventLoadingGuests ||
      !selectedEvent.guestPageInfo?.hasMore
    ) return;
    loadMoreGuests();
  }, [
    guestPageTarget,
    loadedGuestPage,
    sessionStatus,
    activeEventTab,
    selectedEvent?.id,
    selectedEvent?.source,
    selectedEvent?.guestsLoaded,
    selectedEvent?.guestQueryLoading,
    selectedEvent?.guestPageInfo?.hasMore,
    selectedEventLoadingGuests,
  ]);

  const handleGuestListScroll = (event) => {
    const target = event.currentTarget;
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 180) loadMoreGuests();
  };

  const selectGuestFilter = (filter) => {
    setFilter("guestStatus", filter);
    setActiveEventTab("overview");
  };

  const toggleGuestSelection = (personId, selected) => {
    setSelectedGuestIds((current) => {
      const next = new Set(current);
      if (selected) next.add(personId);
      else next.delete(personId);
      return next;
    });
  };

  const toggleAllVisibleGuests = (selected) => {
    setSelectedGuestIds((current) => {
      const next = new Set(current);
      visibleGuests.forEach(({ person }) => {
        if (selected) next.add(person.id);
        else next.delete(person.id);
      });
      return next;
    });
  };

  const openGuestNote = (person) => {
    setOpenTagPersonId("");
    setGuestNoteDraft({
      personId: person.id,
      notes: person.crmNotes || "",
      updatedAt: person.crmNotesUpdatedAt || null,
      saving: false,
    });
  };

  const closeGuestNote = () => {
    setGuestNoteDraft((current) => current?.saving ? current : null);
  };

  const saveGuestNote = async (event) => {
    event.preventDefault();
    if (!guestNoteDraft || guestNoteDraft.saving) return;
    const personId = guestNoteDraft.personId;
    setGuestNoteDraft((current) => current ? { ...current, saving: true } : current);
    try {
      const response = await apiFetch("/api/notes", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ personId, notes: guestNoteDraft.notes }),
      });
      const data: any = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to save guest notes.");
      setState((current) => ({
        ...current,
        people: current.people.map((person) => person.id === personId ? {
          ...person,
          crmNotes: data.notes || "",
          crmNotesUpdatedAt: data.updatedAt || null,
        } : person),
      }));
      setGuestNoteDraft(null);
    } catch (error) {
      setGuestNoteDraft((current) => current ? { ...current, saving: false } : current);
      setApiState({ status: "error", message: error.message });
    }
  };

  const savePersonTags = async (personId, tags, { lockAlreadyHeld = false } = {}) => {
    if (savingTagPersonId && !lockAlreadyHeld) return false;
    if (!lockAlreadyHeld) setSavingTagPersonId(personId);
    const previousPerson = getPerson(state, personId);
    const optimisticTags = sortedTags(unique(tags));
    const automaticTagNames = new Set(
      (Array.isArray(previousPerson?.automaticTags) ? previousPerson.automaticTags : [])
        .map((tag) => tag.toLocaleLowerCase()),
    );
    const optimisticManualTags = optimisticTags.filter((tag) => !automaticTagNames.has(tag.toLocaleLowerCase()));

    setState((current) => normalizeState({
      ...current,
      tags: sortedTags(unique([...current.tags, ...optimisticTags])),
      people: current.people.map((person) => person.id === personId ? {
        ...person,
        tags: optimisticTags,
        manualTags: optimisticManualTags,
      } : person),
    }));

    try {
      const response = await apiFetch("/api/tags", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ personId, tags: optimisticTags }),
      });
      const data: any = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to update guest tags.");
      const savedTags = Array.isArray(data.tags) ? data.tags : optimisticTags;
      setState((current) => normalizeState({
        ...current,
        tags: sortedTags(unique([...current.tags, ...savedTags])),
        people: current.people.map((person) => person.id === (data.personId || personId) ? {
          ...person,
          tags: savedTags,
          manualTags: Array.isArray(data.manualTags) ? data.manualTags : person.manualTags || [],
          automaticTags: Array.isArray(data.automaticTags) ? data.automaticTags : person.automaticTags || [],
        } : person),
      }));
      setApiState({ status: "live", message: `Updated tags for ${previousPerson?.name || "guest"}.` });
      return true;
    } catch (error) {
      if (previousPerson) {
        setState((current) => normalizeState({
          ...current,
          people: current.people.map((person) => person.id === personId ? {
            ...person,
            tags: previousPerson.tags || [],
            manualTags: previousPerson.manualTags || [],
            automaticTags: previousPerson.automaticTags || [],
          } : person),
        }));
      }
      setApiState({ status: "error", message: error.message });
      return false;
    } finally {
      setSavingTagPersonId("");
    }
  };

  const createAndAssignTag = async (personId, name, personTags) => {
    if (savingTagPersonId) return false;
    setSavingTagPersonId(personId);
    try {
      const response = await apiFetch("/api/tags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color: tagColorForName(name) }),
      });
      const data: any = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to create tag.");
      const definition = data.tag;
      setState((current) => normalizeState({
        ...current,
        tags: sortedTags(unique([...current.tags, definition.name])),
        tagDefinitions: mergeTagDefinition(current.tagDefinitions, definition),
      }));
      return savePersonTags(personId, sortedTags(unique([...personTags, definition.name])), { lockAlreadyHeld: true });
    } catch (error) {
      setApiState({ status: "error", message: error.message });
      setSavingTagPersonId("");
      return false;
    }
  };

  const saveTagSettings = async (drafts) => {
    if (tagSettingsSaving) return;
    setTagSettingsSaving(true);
    try {
      const changed = drafts.filter((draft) => {
        const current = state.tagDefinitions.find((tag) => tag.id === draft.id);
        return current && (current.name !== cleanTagName(draft.name) || current.color !== draft.color);
      });
      const saved: any[] = [];
      for (const draft of changed) {
        const response = await apiFetch("/api/tags", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: draft.id, name: cleanTagName(draft.name), color: draft.color }),
        });
        const data: any = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to update tag settings.");
        saved.push(data.tag);
      }
      setState((current) => normalizeState(applyTagDefinitionUpdates(current, saved)));
      setTagSettingsOpen(false);
      setApiState({ status: "live", message: changed.length ? "Saved tag settings." : "Tag settings are up to date." });
    } catch (error) {
      setApiState({ status: "error", message: error.message });
    } finally {
      setTagSettingsSaving(false);
    }
  };

  useEffect(() => {
    if (!profilePanelOpen || selectedPerson?.source !== "luma" || selectedTrace.status !== "idle") return;
    tracePersonActivity(selectedPerson);
  }, [profilePanelOpen, selectedPerson?.id, selectedPerson?.source, selectedTrace.status]);

  const setGuestStatus = async (personId: string, status: string, { sendEmail = false, message = "" }: { sendEmail?: boolean; message?: string } = {}) => {
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
          }, apiFetch);
        } else if (["going", "registered", "declined", "waitlisted"].includes(status)) {
          await postLumaAction({
            action: "updateGuestStatus",
            confirm: LIVE_WRITE_CONFIRMATION,
            eventId: event.id,
            guestId: guest.lumaGuestId,
            status,
            sendEmail,
            message,
          }, apiFetch);
        } else {
          setApiState({ status: "live", message: `${statusLabels[status]} was not changed because Luma public API does not expose that write.` });
          return false;
        }
      } catch (error) {
        setApiState({ status: "error", message: error.message });
        return false;
      }
    }

    updateState((draft) => {
      const event = getEvent(draft, draft.selectedEventId);
      const guest = event?.guests.find((item) => item.personId === personId);
      if (!guest) return;
      const changedAt = new Date().toISOString();
      guest.status = status;
      guest.operatorDecision = status;
      guest.updatedAt = changedAt;
      if (status === "registered" && !guest.registeredAt) guest.registeredAt = changedAt;
      if (status === "going") guest.approvedAt = changedAt;
      if (status === "checked_in") guest.checkedInAt = changedAt;
      if (status === "invited") guest.invitedAt = changedAt;
      draft.selectedPersonId = personId;
    });
    return true;
  };

  const runBulkGuestStatus = async (status: string, label: string) => {
    const event = getEvent(state, state.selectedEventId);
    const rows = selectedGuestRows.filter(({ guest }) => guest.lumaGuestId);
    if (!event || event.source !== "luma" || !rows.length || bulkSubmitting) return;
    if (!window.confirm(`${label} ${rows.length} selected guest${rows.length === 1 ? "" : "s"}?`)) return;

    setBulkSubmitting(true);
    try {
      const data = await postBulkLumaAction({
        action: "bulkUpdateGuestStatus",
        confirm: LIVE_WRITE_CONFIRMATION,
        eventId: event.id,
        status,
        guests: rows.map(({ guest }) => ({ lumaGuestId: guest.lumaGuestId })),
        sendEmail: bulkSendEmail,
        message: bulkSendEmail ? bulkMessage : "",
      }, apiFetch);
      const updatedGuestIds = new Set(data.updatedGuestIds || []);
      const failedGuestIds = new Set((data.failures || []).map((failure) => failure.guestId));
      const changedAt = new Date().toISOString();

      setState((current) => ({
        ...current,
        events: current.events.map((item) => item.id !== event.id ? item : {
          ...item,
          guests: item.guests.map((guest) => !updatedGuestIds.has(guest.lumaGuestId) ? guest : {
            ...guest,
            status,
            operatorDecision: status,
            updatedAt: changedAt,
            ...(status === "going" ? { approvedAt: changedAt } : {}),
          }),
        }),
      }));
      setSelectedGuestIds(new Set(rows.filter(({ guest }) => failedGuestIds.has(guest.lumaGuestId)).map(({ person }) => person.id)));
      await loadEventGuests(event.id, {
        status: state.filters.guestStatus,
        search: debouncedGuestSearch,
      });

      const notificationText = bulkSendEmail ? " with a message" : "";
      if (data.failed) {
        setApiState({ status: "error", message: `${label} updated ${data.updated} guests${notificationText}; ${data.failed} failed. Request ${data.requestId}.` });
      } else {
        setApiState({ status: "live", message: `${label} updated ${data.updated} guests${notificationText}.` });
        setBulkMessage("");
      }
    } catch (error) {
      setApiState({ status: "error", message: error.message });
    } finally {
      setBulkSubmitting(false);
    }
  };

  const requestGuestStatusChange = (personId, status, label) => {
    const event = getEvent(state, state.selectedEventId);
    if (event?.source !== "luma" || !["Approve", "Waitlist", "Decline"].includes(label)) {
      void setGuestStatus(personId, status);
      return;
    }

    setGuestStatusDraft({
      personId,
      status,
      label,
      sendEmail: true,
      message: "",
      submitting: false,
    });
  };

  const closeGuestStatusDialog = () => {
    setGuestStatusDraft((current) => current?.submitting ? current : null);
  };

  const submitGuestStatusChange = async (event) => {
    event.preventDefault();
    if (!guestStatusDraft || guestStatusDraft.submitting) return;

    const draft = guestStatusDraft;
    setGuestStatusDraft((current) => current ? { ...current, submitting: true } : current);
    const updated = await setGuestStatus(draft.personId, draft.status, {
      sendEmail: draft.sendEmail,
      message: draft.sendEmail ? draft.message : "",
    });
    setGuestStatusDraft((current) => updated ? null : current ? { ...current, submitting: false } : current);
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
    if (!guestsToQueue.length) {
      setApiState({ status: "error", message: "Add at least one recipient before sending invitations." });
      return;
    }
    const confirmed = window.confirm(`Send one invitation message to ${guestsToQueue.length} people for ${target.title}?`);
    if (!confirmed) return;

    if (target.source === "luma") {
      try {
        await postLumaAction({
          action: "sendInvites",
          confirm: LIVE_WRITE_CONFIRMATION,
          eventId: target.id,
          guests: lumaGuests,
          message: inviteMessage.trim(),
        }, apiFetch);
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
            invitedAt: new Date().toISOString(),
          });
        }
      });
      draft.selectedEventId = nextTarget.id;
    });
    setApiState({ status: "live", message: `Sent ${guestsToQueue.length} invitations for ${target.title}.` });
  };

  const applyInviteTemplate = (templateId) => {
    setInviteTemplateId(templateId);
    const template = inviteMessageTemplates.find((item) => item.id === templateId);
    if (!template) return;
    setInviteMessage(template.message(inviteTargetEvent).slice(0, MAX_INVITE_MESSAGE_LENGTH));
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
    if (result.type === "event" || result.type === "person") workspaceUrlModeRef.current = "push";
    if (result.type === "person") pendingProfileIdRef.current = "";
    updateState((draft) => {
      if (result.type === "event") {
        draft.selectedEventId = result.id;
        draft.invite.targetEventId = result.id;
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
    if (eventChanged) {
      setProfilePanelOpen(false);
    }
    setSearchOpen(false);
  };

  if (sessionStatus !== "ready") {
    return (
      <SessionKeyGate
        value={sessionKeyDraft}
        error={sessionError}
        checking={sessionStatus === "checking"}
        onChange={setSessionKeyDraft}
        onSubmit={submitSessionKey}
      />
    );
  }

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
          <button className="button" type="button" onClick={() => setTagSettingsOpen(true)}>
            <Settings2 size={17} aria-hidden="true" />
            Tag settings
          </button>
          <button className="button" type="button" onClick={() => lockSession()}>
            <Lock size={17} aria-hidden="true" />
            Lock
          </button>
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
            <span className="calendar-search-field">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                placeholder="Search events"
                value={state.filters.globalSearch}
                onChange={(event) => setFilter("globalSearch", event.target.value)}
              />
            </span>
          </label>
          <div className="segmented" role="tablist" aria-label="Event filter">
            {["upcoming", "past", "all"].map((filter) => (
              <button
                className={`segment ${state.filters.event === filter ? "active" : ""}`}
                type="button"
                role="tab"
                aria-selected={state.filters.event === filter}
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
              <div className="event-summary" key={selectedEvent.id}>
                <EventArtwork event={selectedEvent} large />
                <div className="event-summary-content">
                  {selectedEvent.source === "luma" ? (
                    <div className="event-header-actions" aria-label="Event actions">
                      {selectedEvent.lumaUrl ? (
                        <a
                          className="icon-button event-action-tooltip"
                          href={selectedEvent.lumaUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label="View event on Luma"
                          data-tooltip="View event on Luma"
                        >
                          <ExternalLink size={18} aria-hidden="true" />
                        </a>
                      ) : null}
                      <button
                        className="icon-button event-action-tooltip"
                        type="button"
                        aria-label={selectedEventLoadingGuests ? "Syncing event" : "Sync event"}
                        data-tooltip={selectedEventLoadingGuests ? "Syncing guest data…" : "Refresh guest data"}
                        disabled={selectedEventLoadingGuests}
                        onClick={() => loadEventGuests(selectedEvent.id, { force: true })}
                      >
                        <RefreshCw
                          className={selectedEventLoadingGuests ? "animate-spin" : ""}
                          size={18}
                          aria-hidden="true"
                        />
                      </button>
                      {selectedEventManageUrl ? (
                        <a
                          className="icon-button event-action-tooltip"
                          href={selectedEventManageUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label="Edit event"
                          data-tooltip="Edit event on Luma"
                        >
                          <Pencil size={18} aria-hidden="true" />
                        </a>
                      ) : null}
                    </div>
                  ) : null}
                  <p className="eyebrow">
                    {selectedEvent.category} - {formatDate(selectedEvent.date)}
                  </p>
                  <h2>{selectedEvent.title}</h2>
                  <div className="event-meta">
                    <span><MapPin size={15} aria-hidden="true" />{selectedEvent.location}</span>
                  </div>
                  <EventStats
                    stats={selectedEvent.guestStats || eventStats(selectedEvent)}
                    upcoming={isUpcoming(selectedEvent)}
                    loading={selectedEvent.source === "luma" && !selectedEvent.analyticsLoaded}
                    activeFilter={state.filters.guestStatus}
                    onFilter={selectGuestFilter}
                  />
                </div>
                {selectedEvent.source !== "luma" ? (
                  <div className="summary-actions">
                    <button className="button" type="button" onClick={() => setEventDraft(eventToDraft(selectedEvent))}>
                      Edit event
                    </button>
                    <button className="button danger" type="button" onClick={deleteSelectedEvent}>
                      Delete
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="empty-state">Create an event to start managing guests.</div>
            )}

            <nav className="event-tabs" aria-label="Event workspace">
              {eventTabs.map((tab) => {
                const TabIcon = tab.icon;
                return (
                  <button
                    className={`event-tab ${activeEventTab === tab.id ? "active" : ""}`}
                    type="button"
                    role="tab"
                    aria-selected={activeEventTab === tab.id}
                    key={tab.id}
                    onClick={() => {
                      if (tab.id !== activeEventTab) workspaceUrlModeRef.current = "push";
                      setActiveEventTab(tab.id);
                      pendingProfileIdRef.current = "";
                      setProfilePanelOpen(false);
                    }}
                  >
                    <TabIcon size={16} aria-hidden="true" />
                    {tab.label}
                  </button>
                );
              })}
            </nav>

            {activeEventTab === "overview" ? (
            <div className="workbench-grid event-tab-panel" role="tabpanel" aria-label="Overview">
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
                        {guestFilterOptions.map(({ value, label }) => (
                          <option value={value} key={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <TagFilter
                      definitions={state.tagDefinitions}
                      selected={state.filters.guestTags}
                      onChange={(tags) => setFilter("guestTags", tags)}
                    />
                    <label>
                      <span>Find</span>
                      <input
                        type="search"
                        placeholder="Name, email, profile"
                        value={state.filters.guestSearch}
                        onChange={(event) => setFilter("guestSearch", event.target.value)}
                      />
                      {state.filters.guestSearch.trim() !== debouncedGuestSearch || selectedEvent?.guestQueryLoading ? (
                        <small className="guest-search-state">Searching...</small>
                      ) : null}
                    </label>
                  </div>
                </div>

                {selectedGuestRows.length ? (
                  <div className="bulk-toolbar" role="region" aria-label="Bulk guest actions">
                    <strong className="bulk-selection-count">{selectedGuestRows.length} selected</strong>
                    <label className="bulk-email-toggle">
                      <input
                        type="checkbox"
                        checked={bulkSendEmail}
                        disabled={bulkSubmitting}
                        onChange={(event) => setBulkSendEmail(event.target.checked)}
                      />
                      <Mail size={15} aria-hidden="true" />
                      <span>Send message</span>
                    </label>
                    <input
                      className="bulk-message"
                      type="text"
                      placeholder="Optional status message"
                      maxLength={MAX_GUEST_STATUS_MESSAGE_LENGTH}
                      value={bulkMessage}
                      disabled={!bulkSendEmail || bulkSubmitting}
                      onChange={(event) => setBulkMessage(event.target.value)}
                    />
                    <div className="bulk-actions">
                      <button className="guest-action guest-action-going" type="button" disabled={bulkSubmitting} onClick={() => runBulkGuestStatus("going", "Approve")}>
                        <CircleCheck size={14} aria-hidden="true" />
                        <span>Approve</span>
                      </button>
                      <button className="guest-action guest-action-waitlisted" type="button" disabled={bulkSubmitting} onClick={() => runBulkGuestStatus("waitlisted", "Waitlist")}>
                        <Clock3 size={14} aria-hidden="true" />
                        <span>Waitlist</span>
                      </button>
                      <button className="guest-action guest-action-declined" type="button" disabled={bulkSubmitting} onClick={() => runBulkGuestStatus("declined", "Decline")}>
                        <CircleX size={14} aria-hidden="true" />
                        <span>Decline</span>
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="table-wrap guest-table-wrap" onScroll={handleGuestListScroll}>
                  <table>
                    <thead>
                      <tr>
                        <th className="select-cell">
                          <input
                            className="guest-select"
                            type="checkbox"
                            aria-label="Select all loaded guests"
                            checked={allVisibleGuestsSelected}
                            onChange={(event) => toggleAllVisibleGuests(event.target.checked)}
                          />
                        </th>
                        <th className="guest-identity-column">Guest</th>
                        {showGuestGroups ? <th>Groups</th> : null}
                        <th className="tag-cell">Tags</th>
                        <th>Status</th>
                        <th className="event-count-heading text-center">
                          <abbr className="table-header-abbr" data-tooltip="Events attended" aria-label="Events attended" tabIndex={0}>EA</abbr>
                        </th>
                        <th className="event-count-heading text-center">
                          <abbr className="table-header-abbr" data-tooltip="Events registered" aria-label="Events registered" tabIndex={0}>ER</abbr>
                        </th>
                        <th>Actions</th>
                        <th className="note-cell">Notes</th>
                        <th className="whitespace-nowrap">Status date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleGuests.length ? (
                        visibleGuests.map(({ guest, person, history, statusDate }) => {
                          const selectPerson = () => openPerson(person.id);
                          return (
                          <tr
                            className={`guest-row ${state.selectedPersonId === person.id ? "selected" : ""} ${selectedGuestIds.has(person.id) ? "bulk-selected" : ""}`}
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
                            <td className="select-cell" onClick={(event) => event.stopPropagation()}>
                              <input
                                className="guest-select"
                                type="checkbox"
                                aria-label={`Select ${person.name}`}
                                checked={selectedGuestIds.has(person.id)}
                                onChange={(event) => toggleGuestSelection(person.id, event.target.checked)}
                              />
                            </td>
                            <td className="guest-identity-column">
                              <PersonButton
                                person={person}
                                onAvatarClick={setAvatarPreview}
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
                            <td className="tag-cell" onClick={(event) => event.stopPropagation()}>
                              <PersonTags
                                person={person}
                                definitions={state.tagDefinitions}
                                open={openTagPersonId === person.id}
                                saving={savingTagPersonId === person.id}
                                onOpen={() => setOpenTagPersonId(person.id)}
                                onClose={() => setOpenTagPersonId("")}
                                onChange={(tags) => savePersonTags(person.id, tags)}
                                onCreate={(name, tags) => createAndAssignTag(person.id, name, tags)}
                              />
                            </td>
                            <td>
                              <StatusPill status={guest.status} />
                            </td>
                            <td className="event-count-cell text-center text-sm font-semibold tabular-nums">
                              {history.countsLoaded ? history.attendedCount : <span aria-label="Loading events attended">&hellip;</span>}
                            </td>
                            <td className="event-count-cell text-center text-sm font-semibold tabular-nums">
                              {history.countsLoaded ? history.registeredCount : <span aria-label="Loading events registered">&hellip;</span>}
                            </td>
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
                                      onClick={() => requestGuestStatusChange(person.id, status, label)}
                                    >
                                      <ActionIcon aria-hidden="true" size={14} strokeWidth={2.25} />
                                      <span>{label}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            </td>
                            <td className="note-cell" onClick={(event) => event.stopPropagation()}>
                              <button
                                className={`guest-note-trigger ${person.crmNotes ? "has-note" : ""}`}
                                type="button"
                                aria-label={`${person.crmNotes ? "Open notes" : "Add a note"} for ${person.name}`}
                                title={person.crmNotes ? "Open notes" : "Add note"}
                                onClick={() => openGuestNote(person)}
                              >
                                <FileText size={15} aria-hidden="true" />
                                <span>{guestNoteSummary(person.crmNotes)}</span>
                              </button>
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
                          </tr>
                          );
                        })
                      ) : selectedEventNeedsGuestLoad || selectedEvent?.guestQueryLoading ? (
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
                      {visibleGuests.length && selectedEventLoadingGuests && selectedEvent?.guestPageInfo?.hasMore ? (
                        <tr>
                          <td colSpan={guestTableColumnCount}>
                            <div className="guest-loading-state compact" role="status">
                              <span className="loading-spinner" aria-hidden="true" />
                              <span>Loading more guests</span>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
                {selectedEvent?.guestPageInfo ? (
                  <p className="guest-list-progress">
                    Showing {visibleGuests.length} of {selectedEvent.guestPageInfo.total} matching guests
                  </p>
                ) : null}
              </section>

            </div>
            ) : null}
          </section>

          {activeEventTab === "invite" ? (
            <InviteTab
              state={state}
              audience={inviteAudience}
              targetEvent={inviteTargetEvent}
              loadingGuestEvents={loadingGuestEvents}
              message={inviteMessage}
              templateId={inviteTemplateId}
              audienceName={audienceName}
              onSetInvite={setInvite}
              onLoadEvent={loadEventGuests}
              onMessageChange={(value) => {
                setInviteMessage(value);
                setInviteTemplateId("");
              }}
              onTemplateChange={applyInviteTemplate}
              onAudienceNameChange={setAudienceName}
              onSaveAudience={saveAudienceAsGroup}
              onOpenPerson={openPerson}
              onAvatarClick={setAvatarPreview}
              onSend={sendInvites}
              newGroup={newGroup}
              onNewGroupChange={setNewGroup}
              onAddGroup={addGroup}
              selectedGroupId={state.selectedGroupId}
              onSelectedGroupChange={(groupId) => updateState((draft) => void (draft.selectedGroupId = groupId))}
              memberSearch={state.filters.memberSearch}
              onMemberSearchChange={(value) => setFilter("memberSearch", value)}
              groupMembers={membersForGroup(state)}
              onToggleMember={toggleMember}
            />
          ) : activeEventTab === "analytics" ? (
            <AnalyticsTab
              event={selectedEvent}
              analytics={selectedEventAnalytics}
              loading={selectedEvent?.source === "luma" && !selectedEvent.analyticsLoaded}
            />
          ) : null}
        </section>

        {showProfilePanel ? (
          <ProfilePanel
            state={state}
            person={selectedPerson}
            trace={selectedTrace}
            onTraceActivity={() => tracePersonActivity(selectedPerson, { force: true })}
            onSelectEvent={selectEvent}
            onAvatarClick={setAvatarPreview}
            onClose={() => {
              workspaceUrlModeRef.current = "push";
              pendingProfileIdRef.current = "";
              setProfilePanelOpen(false);
            }}
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

      {avatarPreview ? (
        <AvatarPhotoViewer preview={avatarPreview} onClose={() => setAvatarPreview(null)} />
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

      {guestStatusDraft ? (
        <GuestStatusDialog
          draft={guestStatusDraft}
          event={selectedEvent}
          guest={selectedEvent?.guests.find((guest) => guest.personId === guestStatusDraft.personId)}
          person={getPerson(state, guestStatusDraft.personId)}
          onChange={setGuestStatusDraft}
          onClose={closeGuestStatusDialog}
          onSubmit={submitGuestStatusChange}
        />
      ) : null}

      {guestNoteDraft ? (
        <GuestNoteDialog
          draft={guestNoteDraft}
          person={getPerson(state, guestNoteDraft.personId)}
          onChange={setGuestNoteDraft}
          onClose={closeGuestNote}
          onSubmit={saveGuestNote}
        />
      ) : null}

      {tagSettingsOpen ? (
        <TagSettingsDialog
          definitions={state.tagDefinitions}
          saving={tagSettingsSaving}
          onClose={() => setTagSettingsOpen(false)}
          onSave={saveTagSettings}
        />
      ) : null}
    </div>
  );
}

function SessionKeyGate({ value, error, checking, onChange, onSubmit }) {
  return (
    <main className="session-shell">
      <section className="session-panel" aria-labelledby="session-title">
        <div className="session-brand">
          <img className="brand-mark" src="/guestbook-logo.png" alt="" width="52" height="52" />
          <div>
            <p className="eyebrow">Private workspace</p>
            <h1 id="session-title">Guestbook</h1>
          </div>
        </div>
        <form className="session-form" onSubmit={onSubmit}>
          <label>
            <span>Session key</span>
            <input
              type="password"
              autoComplete="current-password"
              autoFocus
              value={value}
              disabled={checking}
              onChange={(event) => onChange(event.target.value)}
            />
          </label>
          {error ? <p className="session-error" role="alert">{error}</p> : null}
          <button className="button primary" type="submit" disabled={checking}>
            <Lock size={17} aria-hidden="true" />
            {checking ? "Checking..." : "Unlock Guestbook"}
          </button>
        </form>
      </section>
    </main>
  );
}

function AvatarPhotoViewer({ preview, onClose }) {
  const [imageFailed, setImageFailed] = useState(false);
  const closeButtonRef = useRef(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  return (
    <div className="photo-viewer-scrim" role="presentation" onMouseDown={onClose}>
      <section
        className="photo-viewer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="photo-viewer-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          event.preventDefault();
          closeButtonRef.current?.focus();
        }}
      >
        <button ref={closeButtonRef} className="photo-viewer-close" type="button" aria-label="Close profile photo" title="Close" onClick={onClose}>
          <X size={22} aria-hidden="true" />
        </button>
        <div className="photo-viewer-frame">
          {imageFailed ? (
            <span className="photo-viewer-fallback" aria-hidden="true">{initials(preview.person?.name || "")}</span>
          ) : (
            <img
              className="photo-viewer-image"
              src={preview.url}
              alt={`${preview.person?.name || "Guest"}'s profile photo`}
              onError={() => setImageFailed(true)}
            />
          )}
        </div>
        <h2 id="photo-viewer-title" className="photo-viewer-name">{preview.person?.name || "Guest"}</h2>
      </section>
    </div>
  );
}

function GuestStatusDialog({ draft, event, guest, person, onChange, onClose, onSubmit }) {
  if (!event || !guest || !person) return null;
  const ActionIcon = guestActionIcons[draft.label] || CircleCheck;

  return (
    <div className="modal-scrim" role="presentation" onMouseDown={onClose}>
      <form
        className="event-dialog status-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guest-status-dialog-title"
        onSubmit={onSubmit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <div>
            <p className="eyebrow">{event.title}</p>
            <h2 id="guest-status-dialog-title">{draft.label} {person.name}</h2>
          </div>
          <button className="icon-button" type="button" disabled={draft.submitting} aria-label="Close status dialog" title="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="status-transition" aria-label={`Change status from ${statusLabels[guest.status] || guest.status} to ${statusLabels[draft.status] || draft.status}`}>
          <StatusPill status={guest.status} />
          <ArrowRight size={16} aria-hidden="true" />
          <StatusPill status={draft.status} />
        </div>

        <label className="status-notify">
          <input
            type="checkbox"
            checked={draft.sendEmail}
            disabled={draft.submitting}
            onChange={(event) => onChange((current) => ({
              ...current,
              sendEmail: event.target.checked,
              message: event.target.checked ? current.message : "",
            }))}
          />
          <span className="status-notify-icon"><Mail size={17} aria-hidden="true" /></span>
          <span>
            <strong>Notify by email</strong>
            <small>{person.email || "Luma guest"}</small>
          </span>
        </label>

        <label className="status-message">
          <span className="status-message-head">
            <strong>Message <span>(optional)</span></strong>
            <small>{draft.message.length}/{MAX_GUEST_STATUS_MESSAGE_LENGTH}</small>
          </span>
          <textarea
            autoFocus
            rows={4}
            maxLength={MAX_GUEST_STATUS_MESSAGE_LENGTH}
            value={draft.message}
            disabled={!draft.sendEmail || draft.submitting}
            placeholder="Add a personal note"
            onChange={(event) => onChange((current) => ({ ...current, message: event.target.value }))}
          />
        </label>

        <div className="dialog-actions">
          <button className="button ghost" type="button" disabled={draft.submitting} onClick={onClose}>Cancel</button>
          <button className={`button status-submit status-submit-${draft.status}`} type="submit" disabled={draft.submitting}>
            {draft.submitting ? <RefreshCw className="animate-spin" size={16} aria-hidden="true" /> : <ActionIcon size={16} aria-hidden="true" />}
            {draft.submitting ? "Updating..." : draft.label}
          </button>
        </div>
      </form>
    </div>
  );
}

function GuestNoteDialog({ draft, person, onChange, onClose, onSubmit }) {
  const [mode, setMode] = useState("write");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  if (!person) return null;

  const updateNotes = (notes) => onChange((current) => current ? { ...current, notes } : current);
  const formatSelection = ({ before = "", after = "", placeholder = "text", linePrefix = "" }) => {
    const textarea = textareaRef.current;
    if (!textarea || draft.saving) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = draft.notes.slice(start, end) || placeholder;
    const formatted = linePrefix
      ? selected.split("\n").map((line) => `${linePrefix}${line}`).join("\n")
      : `${before}${selected}${after}`;
    const nextNotes = `${draft.notes.slice(0, start)}${formatted}${draft.notes.slice(end)}`.slice(0, MAX_GUEST_NOTE_LENGTH);
    updateNotes(nextNotes);
    window.requestAnimationFrame(() => {
      textarea.focus();
      const selectionStart = start + (linePrefix ? linePrefix.length : before.length);
      textarea.setSelectionRange(selectionStart, Math.min(start + formatted.length - after.length, nextNotes.length));
    });
  };

  const markdownActions = [
    { label: "Bold", icon: Bold, format: { before: "**", after: "**", placeholder: "bold text" } },
    { label: "Italic", icon: Italic, format: { before: "_", after: "_", placeholder: "italic text" } },
    { label: "Link", icon: Link2, format: { before: "[", after: "](https://)", placeholder: "link text" } },
    { label: "Bulleted list", icon: List, format: { linePrefix: "- ", placeholder: "list item" } },
    { label: "Quote", icon: Quote, format: { linePrefix: "> ", placeholder: "quote" } },
    { label: "Inline code", icon: Code2, format: { before: "`", after: "`", placeholder: "code" } },
  ];

  return (
    <div className="modal-scrim" role="presentation" onMouseDown={onClose}>
      <form
        className="event-dialog guest-note-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guest-note-dialog-title"
        onSubmit={onSubmit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-head guest-note-head">
          <div className="guest-note-person">
            <Avatar person={person} />
            <div>
              <p className="eyebrow">Guest notes</p>
              <h2 id="guest-note-dialog-title">{person.name}</h2>
              <p>{person.email}</p>
            </div>
          </div>
          <button className="icon-button" type="button" disabled={draft.saving} aria-label="Close guest notes" title="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="guest-note-tabs" role="tablist" aria-label="Guest note view">
          <button className={mode === "write" ? "active" : ""} type="button" role="tab" aria-selected={mode === "write"} onClick={() => setMode("write")}>
            <Pencil size={15} aria-hidden="true" />
            Write
          </button>
          <button className={mode === "preview" ? "active" : ""} type="button" role="tab" aria-selected={mode === "preview"} onClick={() => setMode("preview")}>
            <Eye size={15} aria-hidden="true" />
            Preview
          </button>
        </div>

        {mode === "write" ? (
          <div className="guest-note-editor" role="tabpanel" aria-label="Write note">
            <div className="markdown-toolbar" aria-label="Markdown formatting">
              {markdownActions.map(({ label, icon: FormatIcon, format }) => (
                <button type="button" title={label} aria-label={label} disabled={draft.saving} key={label} onClick={() => formatSelection(format)}>
                  <FormatIcon size={15} aria-hidden="true" />
                </button>
              ))}
              <span>Markdown</span>
            </div>
            <textarea
              ref={textareaRef}
              autoFocus
              rows={14}
              maxLength={MAX_GUEST_NOTE_LENGTH}
              value={draft.notes}
              disabled={draft.saving}
              placeholder="Add context, follow-ups, links, or anything useful about this guest..."
              aria-label={`Notes for ${person.name}`}
              onChange={(event) => updateNotes(event.target.value)}
            />
          </div>
        ) : (
          <div className={`markdown-preview ${draft.notes.trim() ? "" : "empty"}`} role="tabpanel" aria-label="Note preview">
            {draft.notes.trim() ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
                }}
              >
                {draft.notes}
              </ReactMarkdown>
            ) : <p>No notes yet.</p>}
          </div>
        )}

        <div className="guest-note-footer">
          <span>{draft.notes.length.toLocaleString()}/{MAX_GUEST_NOTE_LENGTH.toLocaleString()}</span>
          {draft.updatedAt ? <span>Last saved {formatDateTime(draft.updatedAt)}</span> : <span>Not saved yet</span>}
        </div>
        <div className="dialog-actions">
          <button className="button ghost" type="button" disabled={draft.saving} onClick={onClose}>Cancel</button>
          <button className="button primary" type="submit" disabled={draft.saving}>
            {draft.saving ? <RefreshCw className="animate-spin" size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
            {draft.saving ? "Saving..." : "Save note"}
          </button>
        </div>
      </form>
    </div>
  );
}

function TagSettingsDialog({ definitions, saving, onClose, onSave }) {
  const [drafts, setDrafts] = useState(() => definitions.map((tag) => ({ ...tag })));
  const hasInvalidName = drafts.some((tag) => !cleanTagName(tag.name));
  return (
    <div className="modal-scrim" role="presentation" onMouseDown={onClose}>
      <form
        className="event-dialog tag-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tag-settings-title"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(drafts);
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <div>
            <p className="eyebrow">Settings</p>
            <h2 id="tag-settings-title">Tags</h2>
            <p className="dialog-description">Names and colors update everywhere a tag is used.</p>
          </div>
          <button className="icon-button" type="button" disabled={saving} aria-label="Close tag settings" title="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        {drafts.length ? (
          <div className="tag-settings-list">
            {drafts.map((tag, index) => (
              <div className={`tag-settings-row ${tag.managed ? "managed" : ""}`} key={tag.id}>
                <span className="tag-color-preview" style={{ backgroundColor: tag.color }} aria-hidden="true" />
                <label className="tag-settings-name">
                  <span className="sr-only">Tag name</span>
                  {tag.managed ? <Lock size={15} aria-label="Automatically managed tag" /> : null}
                  <input
                    type="text"
                    maxLength={40}
                    value={tag.name}
                    disabled={saving || tag.managed}
                    aria-label={`Name for ${tag.name}`}
                    onChange={(event) => setDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))}
                  />
                </label>
                <div className="tag-color-options" aria-label={`Color for ${tag.name}`}>
                  <label
                    className="tag-custom-color"
                    style={{ "--tag-color": tag.color } as CSSProperties}
                    title={tag.managed ? "Automatically managed color" : "Choose a custom color"}
                  >
                    <input
                      type="color"
                      value={tag.color}
                      disabled={saving || tag.managed}
                      aria-label={`Choose a custom color for ${tag.name}`}
                      onChange={(event) => {
                        const color = event.target.value;
                        setDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, color } : item));
                      }}
                    />
                  </label>
                </div>
              </div>
            ))}
          </div>
        ) : <div className="empty-state compact">Create your first tag from any guest’s Tags cell.</div>}
        <div className="dialog-actions">
          <button className="button ghost" type="button" disabled={saving} onClick={onClose}>Cancel</button>
          <button className="button primary" type="submit" disabled={saving || hasInvalidName}>
            {saving ? <RefreshCw className="animate-spin" size={16} aria-hidden="true" /> : <Settings2 size={16} aria-hidden="true" />}
            {saving ? "Saving..." : "Save changes"}
          </button>
        </div>
      </form>
    </div>
  );
}

function TagFilter({ definitions, selected, onChange }) {
  const tags = definitions.map((tag) => tag.name);
  const selectedTags = Array.isArray(selected) ? selected : [];
  const selectedSet = new Set(selectedTags);
  const label = selectedTags.length ? `${selectedTags.length} selected` : "All tags";

  return (
    <div className="tag-filter-control">
      <span>Tags</span>
      <details className="tag-filter-menu">
        <summary>
          <Tag size={14} aria-hidden="true" />
          <span>{label}</span>
        </summary>
        <div className="tag-filter-popover">
          <div className="tag-filter-head">
            <strong>Match any tag</strong>
            {selectedTags.length ? <button type="button" onClick={() => onChange([])}>Clear</button> : null}
          </div>
          {tags.length ? tags.map((tag) => (
            <label className="tag-filter-option" key={tag}>
              <input
                type="checkbox"
                checked={selectedSet.has(tag)}
                onChange={(event) => onChange(event.target.checked
                  ? sortedTags(unique([...selectedTags, tag]))
                  : selectedTags.filter((item) => item !== tag))}
              />
              <span className="tag-filter-dot" style={{ backgroundColor: tagDefinitionForName(definitions, tag).color }} aria-hidden="true" />
              <span>{tagDisplayName(tag)}</span>
            </label>
          )) : <span className="tag-filter-empty">No tags yet</span>}
        </div>
      </details>
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

function EventStats({ stats, upcoming = false, loading = false, activeFilter, onFilter }) {
  const items = [
    ...(upcoming
      ? [{ value: "to_decide", label: "To Decide", count: stats.toDecide ?? 0 }]
      : [
          { value: "new_faces", label: "New Faces", count: stats.newFaces ?? 0 },
          { value: "checked_in", label: "Check-ins", count: stats.checkedIn },
        ]),
    { value: "first_registers", label: "First Registers", count: stats.firstRegisters ?? 0 },
    { value: "accepted", label: "Accepted", count: stats.accepted ?? stats.confirmed ?? 0 },
    { value: "registered", label: "Registered", count: stats.registered },
    { value: "invited", label: "Invited", count: stats.invited },
    { value: "waitlisted", label: "Waitlist", count: stats.waitlisted },
  ];
  return (
    <div className="summary-stats" aria-label="Guest status filters" aria-busy={loading}>
      {items.map((item) => (
        <button
          className={`summary-stat ${activeFilter === item.value ? "active" : ""}`}
          type="button"
          aria-pressed={activeFilter === item.value}
          key={item.value}
          onClick={() => onFilter(item.value)}
        >
          <strong>{loading ? "..." : item.count || 0}</strong>
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

function InviteTab({
  state,
  audience,
  targetEvent,
  loadingGuestEvents,
  message,
  templateId,
  audienceName,
  onSetInvite,
  onLoadEvent,
  onMessageChange,
  onTemplateChange,
  onAudienceNameChange,
  onSaveAudience,
  onOpenPerson,
  onAvatarClick,
  onSend,
  newGroup,
  onNewGroupChange,
  onAddGroup,
  selectedGroupId,
  onSelectedGroupChange,
  memberSearch,
  onMemberSearchChange,
  groupMembers,
  onToggleMember,
}) {
  const eventOptions = sortEvents(state.events).map((event) => ({
    id: event.id,
    label: `${event.title} - ${formatDate(event.date)}`,
    meta: event.guestsLoaded ? `${event.guests.length} guests` : "Not loaded",
  }));
  const personOptions = [...state.people]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((person) => ({ id: person.id, label: person.name, meta: person.email }));
  const addEventRule = (key, eventId) => {
    const next = unique([...(state.invite[key] || []), eventId]);
    onSetInvite(key, next);
    const event = getEvent(state, eventId);
    if (event?.source === "luma" && !event.guestsLoaded && !loadingGuestEvents.includes(eventId)) {
      void onLoadEvent(eventId);
    }
  };

  return (
    <section className="invite-tab panel" role="tabpanel" aria-label="Invite">
      <header className="event-tab-heading">
        <div>
          <p className="eyebrow">Invite audience</p>
          <h2>{targetEvent?.title || "Select an event"}</h2>
        </div>
        <div className="invite-send-summary">
          <span><strong>{audience.length}</strong> recipients</span>
          <button className="button primary" type="button" disabled={!audience.length} onClick={onSend}>
            <Send size={16} aria-hidden="true" />
            Send invites
          </button>
        </div>
      </header>

      <div className="invite-status-rule">
        <div>
          <strong>Event guest states</strong>
          <span>Applied to every included and subtracted event.</span>
        </div>
        <div className="status-options">
          {Object.entries(statusLabels).map(([status, label]) => (
            <label className="check-chip" key={status}>
              <input
                type="checkbox"
                checked={state.invite.sourceStatuses.includes(status)}
                onChange={(event) => {
                  const next = toggleValue(state.invite.sourceStatuses, status, event.target.checked);
                  onSetInvite("sourceStatuses", next.length ? next : sourceStatusDefaults);
                }}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="invite-compose-grid">
        <AudienceRuleColumn
          tone="include"
          icon={UserPlus}
          title="Add to audience"
          groups={state.groups}
          selectedGroups={state.invite.includeGroups}
          onGroupsChange={(next) => onSetInvite("includeGroups", next)}
          eventOptions={eventOptions}
          selectedEvents={state.invite.includeEventIds}
          onEventAdd={(id) => addEventRule("includeEventIds", id)}
          onEventsChange={(next) => onSetInvite("includeEventIds", next)}
          personOptions={personOptions}
          selectedPeople={state.invite.includePeople}
          onPersonAdd={(id) => onSetInvite("includePeople", unique([...state.invite.includePeople, id]))}
          onPeopleChange={(next) => onSetInvite("includePeople", next)}
        />

        <AudienceRuleColumn
          tone="exclude"
          icon={UserMinus}
          title="Subtract from audience"
          groups={state.groups}
          selectedGroups={state.invite.excludeGroups}
          onGroupsChange={(next) => onSetInvite("excludeGroups", next)}
          eventOptions={eventOptions}
          selectedEvents={state.invite.excludeEventIds}
          onEventAdd={(id) => addEventRule("excludeEventIds", id)}
          onEventsChange={(next) => onSetInvite("excludeEventIds", next)}
          personOptions={personOptions}
          selectedPeople={state.invite.excludePeople}
          onPersonAdd={(id) => onSetInvite("excludePeople", unique([...state.invite.excludePeople, id]))}
          onPeopleChange={(next) => onSetInvite("excludePeople", next)}
        />

        <section className="message-composer">
          <div className="audience-column-head">
            <span className="audience-column-icon"><MessageSquare size={17} aria-hidden="true" /></span>
            <div>
              <h3>Message</h3>
              <p>One message for the full audience.</p>
            </div>
          </div>
          <label className="field-label" htmlFor="inviteTemplate">
            Template
          </label>
          <select id="inviteTemplate" value={templateId} onChange={(event) => onTemplateChange(event.target.value)}>
            <option value="">Custom message</option>
            {inviteMessageTemplates.map((template) => (
              <option value={template.id} key={template.id}>{template.label}</option>
            ))}
          </select>
          <label className="message-field" htmlFor="inviteMessage">
            <span><strong>Invite message</strong><small>{message.length}/{MAX_INVITE_MESSAGE_LENGTH}</small></span>
            <textarea
              id="inviteMessage"
              maxLength={MAX_INVITE_MESSAGE_LENGTH}
              placeholder="Add a short note to the invitation"
              value={message}
              onChange={(event) => onMessageChange(event.target.value)}
            />
          </label>
          <div className="delivery-channels">
            <span><Mail size={15} aria-hidden="true" /> Email</span>
            <span><MessageSquare size={15} aria-hidden="true" /> Linked messaging channels</span>
          </div>
        </section>
      </div>

      <div className="preview-toolbar">
        <div>
          <p className="eyebrow">Audience result</p>
          <h3>{audience.length} people after subtraction</h3>
        </div>
        <form className="inline-form" onSubmit={onSaveAudience}>
          <input type="text" placeholder="Save result as group" value={audienceName} onChange={(event) => onAudienceNameChange(event.target.value)} />
          <button className="button" type="submit">Save group</button>
        </form>
      </div>

      <div className="table-wrap preview-wrap">
        <table className="invite-preview-table">
          <thead>
            <tr>
              <th>Recipient</th>
              <th>Why included</th>
              <th>Last attended</th>
              <th>Events attended</th>
            </tr>
          </thead>
          <tbody>
            {audience.length ? audience.map(({ person, reasons, history }) => (
              <tr key={person.id}>
                <td><PersonButton person={person} onAvatarClick={onAvatarClick} onClick={() => onOpenPerson(person.id)} /></td>
                <td className="text-xs text-muted">{reasons.join(", ")}</td>
                <td className="whitespace-nowrap text-xs">{history.lastAttended ? formatDate(history.lastAttended.date) : "Never"}</td>
                <td className="text-center font-semibold tabular-nums">{history.attendedCount}</td>
              </tr>
            )) : (
              <tr><td colSpan={4}><div className="empty-state">Add a person, group, or event cohort to build an audience.</div></td></tr>
            )}
          </tbody>
        </table>
      </div>

      <details className="group-tools">
        <summary>
          <span>Manage groups</span>
          <span>{state.groups.length} groups</span>
        </summary>
        <div className="group-tools-grid">
          <form className="group-form" onSubmit={onAddGroup}>
            <input type="text" placeholder="New group label" value={newGroup.name} onChange={(event) => onNewGroupChange((current) => ({ ...current, name: event.target.value }))} />
            <input type="color" value={newGroup.color} aria-label="Group color" onChange={(event) => onNewGroupChange((current) => ({ ...current, color: event.target.value }))} />
            <button className="button" type="submit">Add group</button>
          </form>
          <div className="group-member-controls">
            <select aria-label="Group to manage" value={selectedGroupId} onChange={(event) => onSelectedGroupChange(event.target.value)}>
              {state.groups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}
            </select>
            <input type="search" aria-label="Find group members" placeholder="Find people" value={memberSearch} onChange={(event) => onMemberSearchChange(event.target.value)} />
          </div>
        </div>
        {selectedGroupId ? (
          <div className="member-list">
            {groupMembers.map((person) => {
              const isMember = person.groups.includes(selectedGroupId);
              return (
                <div className="member-row" key={person.id}>
                  <PersonButton person={person} onAvatarClick={onAvatarClick} onClick={() => onOpenPerson(person.id)} />
                  <button className="button small" type="button" onClick={() => onToggleMember(person.id, selectedGroupId)}>{isMember ? "Remove" : "Add"}</button>
                </div>
              );
            })}
          </div>
        ) : <div className="empty-state">Create a group to manage membership.</div>}
      </details>
    </section>
  );
}

function AudienceRuleColumn({
  tone,
  icon: Icon,
  title,
  groups,
  selectedGroups,
  onGroupsChange,
  eventOptions,
  selectedEvents,
  onEventAdd,
  onEventsChange,
  personOptions,
  selectedPeople,
  onPersonAdd,
  onPeopleChange,
}) {
  return (
    <section className={`audience-column audience-column-${tone}`}>
      <div className="audience-column-head">
        <span className="audience-column-icon"><Icon size={17} aria-hidden="true" /></span>
        <div><h3>{title}</h3><p>{tone === "include" ? "Union these sources." : "Remove anyone matching these sources."}</p></div>
      </div>
      <GroupChecklist title="Groups" groups={groups} selected={selectedGroups} onChange={onGroupsChange} />
      <RulePicker label="Events" options={eventOptions} selected={selectedEvents} onAdd={onEventAdd} onChange={onEventsChange} />
      <RulePicker label="People" options={personOptions} selected={selectedPeople} onAdd={onPersonAdd} onChange={onPeopleChange} />
    </section>
  );
}

function RulePicker({ label, options, selected, onAdd, onChange }) {
  const available = options.filter((option) => !selected.includes(option.id));
  return (
    <div className="rule-block">
      <div className="builder-subhead"><span>{label}</span><span>{selected.length}</span></div>
      <select value="" aria-label={`Add ${label.toLowerCase()}`} onChange={(event) => event.target.value && onAdd(event.target.value)}>
        <option value="">Add {label.toLowerCase()}</option>
        {available.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
      </select>
      {selected.length ? (
        <div className="rule-list">
          {selected.map((id) => {
            const option = options.find((item) => item.id === id);
            if (!option) return null;
            return (
              <div className="rule-item" key={id}>
                <span><strong>{option.label}</strong>{option.meta ? <small>{option.meta}</small> : null}</span>
                <button className="icon-button" type="button" aria-label={`Remove ${option.label}`} title="Remove" onClick={() => onChange(selected.filter((value) => value !== id))}>
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function AnalyticsTab({ event, analytics, loading = false }) {
  if (!event) return <section className="analytics-tab panel"><div className="empty-state">Select an event to view analytics.</div></section>;
  if (loading) {
    return (
      <section className="analytics-tab panel" role="tabpanel" aria-label="Analytics" aria-busy="true">
        <div className="guest-loading-state" role="status">
          <span className="loading-spinner" aria-hidden="true" />
          <span>Loading analytics</span>
        </div>
      </section>
    );
  }
  const totalAccepted = analytics.returningAccepted + analytics.firstRegisters;
  const hasReferrals = analytics.referredRegistrations > 0;
  return (
    <section className="analytics-tab panel" role="tabpanel" aria-label="Analytics">
      <header className="event-tab-heading">
        <div><p className="eyebrow">Event analytics</p><h2>{event.title}</h2></div>
        <span className="analytics-sample">{analytics.registrations} registrations</span>
      </header>

      <div className="analytics-overview-grid">
        <article className="analytics-card returner-card">
          <div className="chart-heading"><div><p className="eyebrow">Accepted mix</p><h3>First registers and returning</h3></div><Users size={19} aria-hidden="true" /></div>
          <div className="stacked-chart" aria-label={`${analytics.returningAccepted} returning, including ${analytics.referredReturning} referred; ${analytics.firstRegisters} first registers, including ${analytics.referredFirstRegisters} referred`}>
            {totalAccepted ? (
              <>
                <span className="stacked-returning" style={{ width: `${(analytics.returningAccepted / totalAccepted) * 100}%` }}>
                  {analytics.referredReturning ? <i className="stacked-referral" style={{ width: `${(analytics.referredReturning / analytics.returningAccepted) * 100}%` }} /> : null}
                </span>
                <span className="stacked-new" style={{ width: `${(analytics.firstRegisters / totalAccepted) * 100}%` }}>
                  {analytics.referredFirstRegisters ? <i className="stacked-referral" style={{ width: `${(analytics.referredFirstRegisters / analytics.firstRegisters) * 100}%` }} /> : null}
                </span>
              </>
            ) : null}
          </div>
          <div className="chart-legend">
            <span><i className="legend-returning" /><strong>{analytics.returningAccepted}</strong> Returning</span>
            <span><i className="legend-new" /><strong>{analytics.firstRegisters}</strong> First registers</span>
          </div>
          {hasReferrals ? (
            <div className="referral-mix" aria-label={`${analytics.referredAccepted} referred accepted guests: ${analytics.referredReturning} returning and ${analytics.referredFirstRegisters} first registers`}>
              <Gem size={15} aria-hidden="true" />
              <strong>{analytics.referredAccepted}</strong>
              <span>Referred accepted</span>
              <small>{analytics.referredReturning} returning</small>
              <small>{analytics.referredFirstRegisters} first registers</small>
            </div>
          ) : null}
        </article>

        <article className="analytics-card funnel-card">
          <div className="chart-heading"><div><p className="eyebrow">Conversion</p><h3>Registration funnel</h3></div><BarChart3 size={19} aria-hidden="true" /></div>
          <ol className="funnel-chart">
            {analytics.funnel.map((stage) => (
              <li key={stage.id} aria-label={`${stage.label}: ${stage.value}${stage.overlay ? `; ${stage.overlay.label}: ${stage.overlay.value}` : ""}`}>
                <span className="funnel-bar" style={{ width: `${stage.width}%` }}>
                  <span className="funnel-stage-main"><strong>{stage.value}</strong><small>{stage.label}</small></span>
                  {stage.overlay && stage.value > 0 ? (
                    <span
                      className={`funnel-overlay ${stage.overlay.value ? "" : "zero"}`}
                      style={{ width: stage.overlay.value ? `${stage.overlay.width}%` : "auto" }}
                    >
                      <strong>{stage.overlay.value}</strong>
                      <small>{stage.overlay.label}</small>
                    </span>
                  ) : null}
                </span>
                <em>{stage.rate}%</em>
              </li>
            ))}
          </ol>
          {hasReferrals ? (
            <div className="referral-funnel" aria-label={`${analytics.referredRegistrations} referred registrations, ${analytics.referredAccepted} accepted, ${analytics.referredCheckedIn} checked in`}>
              <span className="referral-funnel-label"><Gem size={15} aria-hidden="true" /> Referred</span>
              <span><strong>{analytics.referredRegistrations}</strong><small>Registered</small></span>
              <ArrowRight size={14} aria-hidden="true" />
              <span><strong>{analytics.referredAccepted}</strong><small>Accepted</small></span>
              <ArrowRight size={14} aria-hidden="true" />
              <span><strong>{analytics.referredCheckedIn}</strong><small>Checked in</small></span>
            </div>
          ) : null}
        </article>
      </div>

      <section className="answer-analytics">
        <div className="event-tab-heading compact">
          <div><p className="eyebrow">First Registers</p><h2>Registration answers</h2></div>
          <span className="analytics-sample">{analytics.firstRegisters} first registers</span>
        </div>
        {analytics.questions.length ? (
          <div className="question-grid">
            {analytics.questions.map((question) => (
              <article className="question-chart" key={question.id}>
                <div className="question-chart-head"><h3>{question.label}</h3><span>{question.responseCount} responses</span></div>
                {question.kind === "categorical" ? (
                  <div className="bar-chart">
                    {question.options.map((option) => (
                      <div className="bar-row" key={option.label}>
                        <span title={option.label}>{option.label}</span>
                        <div><i style={{ width: `${option.percent}%` }} /></div>
                        <strong>{option.count}</strong>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-response-list">
                    {question.responses.map((response) => <blockquote key={response.id}>{response.value}</blockquote>)}
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : <div className="empty-state">No registration answers from first registers are available for this event.</div>}
      </section>
    </section>
  );
}

function GroupChecklist({ title, groups, selected, onChange }) {
  return (
    <div className="rule-block">
      <div className="builder-subhead">
        <span>{title}</span>
        <span>{selected.length} selected</span>
      </div>
      <div className="chip-grid">
        {groups.map((group) => (
          <label className="check-chip" style={{ "--chip-color": group.color } as CSSProperties} key={group.id}>
            <input type="checkbox" checked={selected.includes(group.id)} onChange={(event) => onChange(toggleValue(selected, group.id, event.target.checked))} />
            <span>{group.name}</span>
          </label>
        ))}
        {!groups.length ? <span className="quiet-note">No saved groups</span> : null}
      </div>
    </div>
  );
}

function ProfilePanel({ state, person, trace, onTraceActivity, onSelectEvent, onAvatarClick, onClose }) {
  const [activityFilters, setActivityFilters] = useState(() => activityFilterOptions.map((option) => option.status));
  const activityMenuRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const closeActivityMenu = (event: PointerEvent) => {
      if (!activityMenuRef.current?.contains(event.target as Node)) {
        activityMenuRef.current?.removeAttribute("open");
      }
    };

    document.addEventListener("pointerdown", closeActivityMenu, true);
    return () => document.removeEventListener("pointerdown", closeActivityMenu, true);
  }, []);

  if (!person || !hasProfileContent(state, person)) return null;

  const history = getPersonHistory(state, person.id);
  const bio = profileBio(person, state);
  const socialLinks = profileSocialLinks(person, state);
  const currentRecord = currentProfileRecord(state, person);
  const currentStatus = currentRecord?.guest.status;
  const loadedActivityRecords = activityRecordsFromHistory(history.records);
  const traceRan = ["loading", "ready", "error"].includes(trace?.status);
  const traceRecords = traceRan ? trace?.records || [] : loadedActivityRecords;
  const answerGroups = registrationAnswerGroups(person, state, trace?.records || []);
  const answerGroupsLoading = person.source === "luma" && ["idle", "loading"].includes(trace?.status);
  const filteredTraceRecords = traceRecords.filter((record) => activityFilters.includes(activityRecordStatus(record)));
  const activityFilterLabel = activityFilters.length === activityFilterOptions.length
    ? "All activity"
    : activityFilters.length === 1
      ? activityFilterOptions.find((option) => option.status === activityFilters[0])?.label || "Activity"
      : `${activityFilters.length} activity types`;

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
          <Avatar person={person} large onPreview={onAvatarClick} />
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

        <ProfileTags person={person} definitions={state.tagDefinitions} />
        {bio ? <p className="profile-bio">{bio}</p> : null}
        <SocialIconLinks links={socialLinks} />
        {currentRecord ? <ProfileContext record={currentRecord} /> : null}

        {answerGroups.length || answerGroupsLoading ? (
          <details className="profile-disclosure" open>
            <summary>Registration answers</summary>
            <section className="profile-section">
              {answerGroups.length ? answerGroups.map((group) => (
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
                )) : (
                  <div className="guest-loading-state compact" role="status" aria-label="Loading registration answers">
                    <span className="loading-spinner" aria-hidden="true" />
                  </div>
                )}
            </section>
          </details>
        ) : null}

        <details className="profile-disclosure" open>
          <summary>Event activity</summary>
          <section className="profile-section">
            <div className="trace-toolbar">
              {traceRecords.length ? (
                <details
                  className="activity-filter-menu"
                  ref={activityMenuRef}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    event.currentTarget.removeAttribute("open");
                    event.currentTarget.querySelector("summary")?.focus();
                  }}
                >
                  <summary>
                    <ListFilter size={15} aria-hidden="true" />
                    <span>{activityFilterLabel}</span>
                    <span className="activity-filter-count">
                      {filteredTraceRecords.length}/{traceRecords.length}
                    </span>
                    <ChevronDown className="activity-filter-chevron" size={15} aria-hidden="true" />
                  </summary>
                  <div className="activity-filter-popover">
                    <div className="activity-filter-head">
                      <strong>Activity types</strong>
                      <span>{activityFilters.length} selected</span>
                    </div>
                    {activityFilterOptions.map((option) => {
                      const checked = activityFilters.includes(option.status);
                      return (
                        <label className="activity-filter-option" key={option.status}>
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
                </details>
              ) : <span className="activity-filter-placeholder">Activity</span>}
              <button
                className="icon-button activity-refresh"
                type="button"
                aria-label={trace?.status === "loading" ? "Loading activity" : trace?.status === "ready" ? "Refresh activity" : "Load activity"}
                title={trace?.status === "loading" ? "Loading activity" : trace?.status === "ready" ? "Refresh activity" : "Load activity"}
                disabled={trace?.status === "loading"}
                onClick={onTraceActivity}
              >
                <RefreshCw className={trace?.status === "loading" ? "animate-spin" : ""} size={16} aria-hidden="true" />
              </button>
            </div>
            {traceRecords.length ? (
              <>
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

function PersonButton({ person, onClick, onAvatarClick }) {
  return (
    <div className="person-cell">
      <Avatar person={person} onPreview={onAvatarClick} />
      <button className="plain person-details" type="button" onClick={onClick}>
        <span className="person-name">{person.name}</span>
        <span className="person-email">{person.email}</span>
      </button>
    </div>
  );
}

function guestNoteSummary(notes) {
  if (!notes?.trim()) return "Add note";
  const firstLine = notes
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^#{1,6}\s+/, "")
    .replace(/\[(.*?)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`>[\]]/g, "")
    .trim() || "Open note";
  return firstLine.length > 42 ? `${firstLine.slice(0, 41).trimEnd()}...` : firstLine;
}

function Avatar({ person, large = false, onPreview = null }) {
  const candidates = useMemo(
    () =>
      orderAvatarCandidates(
        ...(person?.avatarCandidates || []),
        person?.avatarUrl,
        large && person?.id ? `/api/luma/avatar?person_id=${encodeURIComponent(person.id)}` : "",
      ),
    [large, person?.id, person?.avatarUrl, person?.avatarCandidates],
  );
  const [candidateIndex, setCandidateIndex] = useState(0);
  const avatarUrl = candidates[candidateIndex] || "";

  useEffect(() => setCandidateIndex(0), [person?.id, candidates.join("|")]);

  const className = `avatar ${avatarUrl ? "avatar-photo" : ""} ${large ? "avatar-large" : ""} ${avatarUrl && onPreview ? "avatar-button" : ""}`;
  const contents = (
    <>
      <span>{initials(person?.name || "")}</span>
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          loading={large ? "eager" : "lazy"}
          onError={() => setCandidateIndex((current) => current + 1)}
        />
      ) : null}
    </>
  );

  if (avatarUrl && onPreview) {
    return (
      <button
        className={className}
        type="button"
        aria-label={`View ${person?.name || "guest"}'s profile photo`}
        aria-haspopup="dialog"
        title="View profile photo"
        onClick={(event) => {
          event.stopPropagation();
          onPreview({ person, url: avatarUrl });
        }}
      >
        {contents}
      </button>
    );
  }

  return <span className={className}>{contents}</span>;
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
        <span className="chip" style={{ "--chip-color": group.color } as CSSProperties} key={group.id}>
          {group.name}
        </span>
      ))}
    </div>
  );
}

function ProfileTags({ person, definitions }) {
  const tags = Array.isArray(person.tags) ? person.tags : [];
  const automaticTags = new Set((Array.isArray(person.automaticTags) ? person.automaticTags : []).map((tag) => tag.toLocaleLowerCase()));
  if (!tags.length) return null;

  return (
    <div className="profile-tags" aria-label="Guest tags">
      {tags.map((tag) => {
        const definition = tagDefinitionForName(definitions, tag);
        const automatic = automaticTags.has(tag.toLocaleLowerCase());
        return (
          <span className={`tag-chip ${automatic ? "tag-chip-automatic" : ""}`} style={tagChipStyle(definition.color)} title={automatic ? "Automatically assigned" : undefined} key={tag}>
            {automatic ? <Lock size={9} aria-hidden="true" /> : null}
            {tagDisplayName(tag)}
          </span>
        );
      })}
    </div>
  );
}

function PersonTags({ person, definitions, open, saving, onOpen, onClose, onChange, onCreate }) {
  const tags = Array.isArray(person.tags) ? person.tags : [];
  const automaticTags = new Set((Array.isArray(person.automaticTags) ? person.automaticTags : []).map((tag) => tag.toLocaleLowerCase()));
  const visibleTags = tags.slice(0, 2);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [pickerPosition, setPickerPosition] = useState({ left: 0, top: 0 });
  const triggerRef = useRef(null);
  const pickerRef = useRef(null);
  const inputRef = useRef(null);
  const normalizedQuery = cleanTagName(query).toLocaleLowerCase();
  const matchingDefinitions = definitions.filter((tag) => tag.name.toLocaleLowerCase().includes(normalizedQuery));
  const exactMatch = definitions.some((tag) => tag.name.toLocaleLowerCase() === normalizedQuery);
  const canCreate = Boolean(normalizedQuery) && !exactMatch;
  const options = [
    ...matchingDefinitions.map((tag) => ({ type: "tag", tag })),
    ...(canCreate ? [{ type: "create", name: cleanTagName(query) }] : []),
  ];

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
    const closeOnOutsideClick = (event) => {
      if (!pickerRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) onClose();
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const placePicker = () => {
      const trigger = triggerRef.current.getBoundingClientRect();
      const width = 288;
      const height = pickerRef.current?.offsetHeight || 220;
      const below = window.innerHeight - trigger.bottom;
      setPickerPosition({
        left: Math.max(8, Math.min(trigger.left, window.innerWidth - width - 8)),
        top: below >= height + 14 ? trigger.bottom + 6 : Math.max(8, trigger.top - height - 6),
      });
    };
    placePicker();
    requestAnimationFrame(placePicker);
    window.addEventListener("resize", placePicker);
    return () => window.removeEventListener("resize", placePicker);
  }, [open, options.length]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, options.length - 1)));
  }, [query, options.length]);

  const resetTagSearch = () => {
    setQuery("");
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  const activateOption = async (option) => {
    if (!option || saving) return;
    if (option.type === "create") {
      const saved = await onCreate(option.name, tags);
      if (saved) resetTagSearch();
      return;
    }
    if (automaticTags.has(option.tag.name.toLocaleLowerCase())) return;
    const selected = tags.some((tag) => tag.toLocaleLowerCase() === option.tag.name.toLocaleLowerCase());
    const nextTags = selected
      ? tags.filter((tag) => tag.toLocaleLowerCase() !== option.tag.name.toLocaleLowerCase())
      : sortedTags(unique([...tags, option.tag.name]));
    const saved = await onChange(nextTags);
    if (saved) resetTagSearch();
  };

  return (
    <>
      <button
        className={`person-tags ${open ? "picker-open" : ""}`}
        ref={triggerRef}
        type="button"
        aria-label={`${tags.length ? "Edit tags" : "Add tag"} for ${person.name}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={tags.length ? "Edit tags" : "Add tag"}
        onClick={onOpen}
      >
        <span className="tag-chip-list">
          {visibleTags.map((tag) => {
            const definition = tagDefinitionForName(definitions, tag);
            const automatic = automaticTags.has(tag.toLocaleLowerCase());
            return (
              <span className={`tag-chip ${automatic ? "tag-chip-automatic" : ""}`} style={tagChipStyle(definition.color)} title={automatic ? "Automatically assigned" : undefined} key={tag}>
                {automatic ? <Lock size={9} aria-hidden="true" /> : null}
                {tagDisplayName(tag)}
              </span>
            );
          })}
          {tags.length > visibleTags.length ? <span className="tag-chip tag-chip-more">+{tags.length - visibleTags.length}</span> : null}
          {!tags.length ? <span className="tag-cell-placeholder">+ Add Tag</span> : null}
        </span>
      </button>
      {open ? createPortal(
        <div className="tag-picker" ref={pickerRef} style={pickerPosition} onClick={(event) => event.stopPropagation()}>
          <div className="tag-picker-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={inputRef}
              role="combobox"
              aria-label={`Search tags for ${person.name}`}
              aria-controls={`tag-options-${person.id}`}
              aria-expanded="true"
              aria-activedescendant={options[activeIndex] ? `tag-option-${person.id}-${activeIndex}` : undefined}
              autoComplete="off"
              type="search"
              placeholder="Search tags…"
              value={query}
              disabled={saving}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveIndex((current) => options.length ? (current + 1) % options.length : 0);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex((current) => options.length ? (current - 1 + options.length) % options.length : 0);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  void activateOption(options[activeIndex]);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  onClose();
                }
              }}
            />
            {saving ? <RefreshCw className="animate-spin" size={15} aria-label="Saving tags" /> : null}
          </div>
          <div className="tag-picker-options" id={`tag-options-${person.id}`} role="listbox" aria-multiselectable="true">
            {options.map((option, index) => {
              if (option.type === "tag") {
                const automatic = automaticTags.has(option.tag.name.toLocaleLowerCase());
                const selected = tags.some((tag) => tag.toLocaleLowerCase() === option.tag.name.toLocaleLowerCase());
                return (
                  <button
                    className={`tag-picker-option ${automatic ? "automatic" : ""} ${index === activeIndex ? "active" : ""}`}
                    id={`tag-option-${person.id}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    key={option.tag.id}
                    disabled={saving || automatic}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => void activateOption(option)}
                  >
                    <span className="tag-option-color" style={{ backgroundColor: option.tag.color }} aria-hidden="true" />
                    <span>{tagDisplayName(option.tag.name)}</span>
                    {automatic ? <Lock size={14} aria-label="Automatically assigned" /> : selected ? <CircleCheck size={16} aria-hidden="true" /> : null}
                  </button>
                );
              }
              return (
                <button
                  className={`tag-picker-option tag-picker-create ${index === activeIndex ? "active" : ""}`}
                  id={`tag-option-${person.id}-${index}`}
                  type="button"
                  role="option"
                  aria-selected="false"
                  key={`create-${option.name}`}
                  disabled={saving}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => void activateOption(option)}
                >
                  <Plus size={16} aria-hidden="true" />
                  <span>Add “{option.name}”</span>
                </button>
              );
            })}
            {!options.length ? <div className="tag-picker-empty">Type to create a tag</div> : null}
          </div>
          <div className="tag-picker-hint"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> select</span></div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function StatusPill({ status }) {
  return <span className={`status-pill status-${status}`}>{statusLabels[status] || status}</span>;
}

function withRequestId(message, requestId) {
  return requestId ? message + " (request " + requestId + ")" : message;
}

async function postLumaAction(payload, apiFetch) {
  const response = await apiFetch("/api/luma", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data: any = await response.json();
  if (!response.ok || data.ok === false) throw new Error(withRequestId(data.error || data.message || "Luma request failed.", data.requestId));
  return data;
}

async function postBulkLumaAction(payload, apiFetch) {
  const response = await apiFetch("/api/luma", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data: any = await response.json();
  if ((!response.ok && response.status !== 207) || !Array.isArray(data.updatedGuestIds)) {
    throw new Error(withRequestId(data.error || data.message || "Bulk Luma request failed.", data.requestId));
  }
  return data;
}

async function verifySessionKey(sessionKey: string) {
  try {
    const response = await sessionFetch(sessionKey, "/api/session", { cache: "no-store" });
    const data: any = await response.json();
    return {
      ok: response.ok && data.ok !== false,
      status: response.status,
      error: data.error || "Unable to validate the session key.",
    };
  } catch {
    return { ok: false, status: 0, error: "Unable to reach Guestbook. Try again." };
  }
}

function sessionFetch(sessionKey: string, input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set(SESSION_KEY_HEADER, sessionKey);
  return fetch(input, { ...init, headers });
}

function writeSessionCookie(sessionKey: string) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${SESSION_KEY_COOKIE}=${encodeURIComponent(sessionKey)}; path=/; max-age=31536000; SameSite=Lax${secure}`;
}

function clearSessionCookie() {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${SESSION_KEY_COOKIE}=; path=/; max-age=0; SameSite=Lax${secure}`;
}

function mergeLumaGuests(current, lumaData, { append = false } = {}) {
  const existingPeople = new Map();
  current.people.forEach((person) => {
    existingPeople.set(person.id, person);
    if (person.email) existingPeople.set(person.email.toLowerCase(), person);
  });

  const peopleById = new Map(current.people.map((person) => [person.id, person]));
  (lumaData.people || []).forEach((person) => {
    const existing = existingPeople.get(person.id) || existingPeople.get(person.email?.toLowerCase());
    peopleById.set(person.id, mergePersonRecord(existing, person));
  });

  const people = [...peopleById.values()];
  const events = current.events.map((event) => {
    if (event.id !== lumaData.eventId) return event;
    const guestsByPersonId = new Map((append ? event.guests : []).map((guest) => [guest.personId, guest]));
    (lumaData.guests || []).forEach((guest) => guestsByPersonId.set(guest.personId, guest));
    const guests = [...guestsByPersonId.values()];
    return {
          ...event,
          ...(lumaData.event || {}),
          guests,
          guestsLoaded: true,
          guestLoadTruncated: lumaData.truncated,
          guestStats: lumaData.stats || event.guestStats,
          guestAnalyticsQuestions: lumaData.analyticsQuestions || event.guestAnalyticsQuestions || [],
          guestSnapshotReady: lumaData.snapshotReady ?? event.guestSnapshotReady ?? false,
          guestSnapshotWarming: false,
          guestHistoryLoaded: guests.every((guest: any) => Boolean(guest.eventCounts)),
          guestHistoryLoading: false,
          guestPageInfo: lumaData.pageInfo || null,
          guestQuery: lumaData.query || null,
          guestQueryLoading: false,
        };
  });

  return normalizeState({
    ...current,
    events,
    people,
    selectedPersonId: current.selectedPersonId || (people as any[])[0]?.id || "",
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

  const firstUpcomingEventId = upcomingEvents({ events: lumaData.events })[0]?.id || sortEvents(lumaData.events).at(-1)?.id || "";

  return normalizeState({
    ...current,
    source: "luma",
    loadedAt: lumaData.loadedAt,
    events: lumaData.events,
    people,
    selectedEventId: lumaData.events.some((event) => event.id === current.selectedEventId) ? current.selectedEventId : firstUpcomingEventId,
    selectedPersonId: people.some((person) => person.id === current.selectedPersonId) ? current.selectedPersonId : people[0]?.id || "",
    invite: {
      ...current.invite,
      targetEventId: lumaData.events.some((event) => event.id === current.invite.targetEventId) ? current.invite.targetEventId : firstUpcomingEventId,
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
    tags: Array.isArray(incoming.tags) ? incoming.tags : existing?.tags || [],
    manualTags: Array.isArray(incoming.manualTags) ? incoming.manualTags : existing?.manualTags || [],
    automaticTags: Array.isArray(incoming.automaticTags) ? incoming.automaticTags : existing?.automaticTags || [],
    crmNotes: incoming.crmNotes ?? existing?.crmNotes ?? "",
    crmNotesUpdatedAt: incoming.crmNotesUpdatedAt ?? existing?.crmNotesUpdatedAt ?? null,
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
  next.people = next.people.map((person) => ({
    ...person,
    tags: Array.isArray(person.tags) ? person.tags : [],
    manualTags: Array.isArray(person.manualTags) ? person.manualTags : [],
    automaticTags: Array.isArray(person.automaticTags) ? person.automaticTags : [],
    crmNotes: typeof person.crmNotes === "string" ? person.crmNotes : "",
    crmNotesUpdatedAt: person.crmNotesUpdatedAt || null,
  }));
  next.tags = sortedTags(unique([
    ...(Array.isArray(next.tags) ? next.tags : []),
    ...next.people.flatMap((person) => person.tags),
  ]));
  next.tagDefinitions = next.tags.map((name) => tagDefinitionForName(
    Array.isArray(next.tagDefinitions) ? next.tagDefinitions : [],
    name,
  ));
  next.filters.guestTags = sortedTags(unique(Array.isArray(next.filters.guestTags) ? next.filters.guestTags : []));
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

function initialEventWindow(events, filter, selectedEventId = "") {
  const selectedIndex = selectedEventId ? events.findIndex((event) => event.id === selectedEventId) : -1;
  if (selectedIndex >= 0) {
    const start = Math.max(0, Math.min(selectedIndex - 4, events.length - EVENT_PAGE_SIZE));
    return { start, end: Math.min(events.length, start + EVENT_PAGE_SIZE) };
  }
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
    person.crmNotes,
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
  return personGuestRecords(state, personId).sort((a, b) => new Date(b.event.date).getTime() - new Date(a.event.date).getTime())[0]?.event.id || "";
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
  const serverManaged = event.source === "luma" && event.guestQuery;
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
      if (serverManaged) return true;
      const selectedStatus = state.filters.guestStatus;
      const matchesStatus = selectedStatus === "all"
        || (selectedStatus === "to_decide" && (guest.status === "registered" || (guest.status === "waitlisted" && guest.operatorDecision !== "waitlisted")))
        || (selectedStatus === "accepted" && acceptedStatuses.includes(guest.status))
        || (selectedStatus === "registered" && registeredStatuses.includes(guest.status))
        || (selectedStatus === "first_registers" && isFirstRegister(guest))
        || (selectedStatus === "new_faces" && guest.status === "checked_in" && isFirstRegistration(guest))
        || guest.status === selectedStatus;
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
  if (!guest.eventCounts) {
    return {
      ...history,
      countsLoaded: guest.source !== "luma" && guest.dataSource !== "luma-index",
    };
  }
  return {
    ...history,
    countsLoaded: true,
    attendedCount: nonnegativeCount(guest.eventCounts.attended, history.attendedCount),
    registeredCount: nonnegativeCount(guest.eventCounts.registered, history.registeredCount),
  };
}

function nonnegativeCount(value, fallback) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : fallback;
}

function searchableGuestText(person: any, guest: any = {}) {
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

function registrationAnswerGroups(person, state, activityRecords = []) {
  const groupsByEvent = new Map();
  const addGroup = (event, answers) => {
    const usableAnswers = (Array.isArray(answers) ? answers : []).filter((answer) => answer?.value !== undefined && answer?.value !== null && String(answer.value).trim());
    if (!event?.id || !usableAnswers.length) return;
    groupsByEvent.set(event.id, { event, answers: usableAnswers });
  };

  personGuestRecords(state, person.id).forEach(({ event, guest }) => {
    addGroup(event, guest.registrationAnswers);
  });
  activityRecords.forEach((record) => {
    addGroup({
      id: record.eventId,
      title: record.eventTitle || "Untitled event",
      date: record.eventDate || record.eventStartsAt || record.sortAt,
      startsAt: record.eventStartsAt || null,
    }, record.registrationAnswers);
  });

  return [...groupsByEvent.values()]
    .sort((a, b) => new Date(b.event.startsAt || b.event.date).getTime() - new Date(a.event.startsAt || a.event.date).getTime());
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

function buildEventAnalytics(state, event) {
  const empty = {
    registrations: 0,
    returningAccepted: 0,
    firstRegisters: 0,
    newFaces: 0,
    referredRegistrations: 0,
    referredAccepted: 0,
    referredCheckedIn: 0,
    referredReturning: 0,
    referredFirstRegisters: 0,
    funnel: [
      { id: "registered", label: "Total registrations", value: 0, rate: 0, width: 100 },
      { id: "accepted", label: "Accepted", value: 0, rate: 0, width: 0, overlay: { label: "First Registers", value: 0, width: 0 } },
      { id: "checked-in", label: "Checked in", value: 0, rate: 0, width: 0, overlay: { label: "New Faces", value: 0, width: 0 } },
    ],
    questions: [],
  };
  if (!event) return empty;

  const registrationRows = event.guests
    .filter((guest) => registeredStatuses.includes(guest.status))
    .map((guest) => ({
      guest,
      person: getPerson(state, guest.personId),
      history: personHistoryForGuest(state, guest),
    }))
    .filter((row) => row.person);
  const acceptedRows = registrationRows.filter(({ guest }) => acceptedStatuses.includes(guest.status));
  const firstRegisterRows = acceptedRows.filter(({ guest }) => isFirstRegistrationAtEvent(state, guest, event));
  const referredRows = registrationRows.filter(({ person }) => personHasExactTag(person, REFERRED_PERSON_TAG));
  const referredAcceptedRows = referredRows.filter(({ guest }) => acceptedStatuses.includes(guest.status));
  const referredFirstRegisterRows = referredAcceptedRows.filter(({ guest }) => isFirstRegistrationAtEvent(state, guest, event));
  const returningAccepted = acceptedRows.length - firstRegisterRows.length;
  const accepted = acceptedRows.length;
  const checkedIn = registrationRows.filter(({ guest }) => guest.status === "checked_in").length;
  const newFaces = registrationRows.filter(({ guest }) => guest.status === "checked_in" && isFirstRegistrationAtEvent(state, guest, event)).length;
  const loadedCounts = {
    registrations: registrationRows.length,
    returningAccepted,
    firstRegisters: firstRegisterRows.length,
    accepted,
    checkedIn,
    newFaces,
    referredRegistrations: referredRows.length,
    referredAccepted: referredAcceptedRows.length,
    referredCheckedIn: referredRows.filter(({ guest }) => guest.status === "checked_in").length,
    referredReturning: referredAcceptedRows.length - referredFirstRegisterRows.length,
    referredFirstRegisters: referredFirstRegisterRows.length,
  };
  const counts = eventWideAnalyticsCounts(event.guestStats, loadedCounts);
  const registrations = counts.registrations;
  const rate = (value) => registrations ? Math.round((value / registrations) * 100) : 0;
  const width = (value) => registrations ? Math.max(value ? 18 : 0, Math.round((value / registrations) * 100)) : 0;
  const subsetWidth = (value, parent) => parent ? Math.min(100, Math.max(value ? 24 : 0, Math.round((value / parent) * 100))) : 0;

  const questions = Array.isArray(event.guestAnalyticsQuestions)
    ? event.guestAnalyticsQuestions
    : buildRegistrationQuestionAnalytics(firstRegisterRows.map(({ guest, person }) => ({
        personId: person.id,
        registrationAnswers: guest.registrationAnswers,
      })));

  return {
    registrations,
    returningAccepted: counts.returningAccepted,
    firstRegisters: counts.firstRegisters,
    newFaces: counts.newFaces,
    referredRegistrations: counts.referredRegistrations,
    referredAccepted: counts.referredAccepted,
    referredCheckedIn: counts.referredCheckedIn,
    referredReturning: counts.referredReturning,
    referredFirstRegisters: counts.referredFirstRegisters,
    funnel: [
      { id: "registered", label: "Total registrations", value: registrations, rate: registrations ? 100 : 0, width: registrations ? 100 : 0 },
      {
        id: "accepted",
        label: "Accepted",
        value: counts.accepted,
        rate: rate(counts.accepted),
        width: width(counts.accepted),
        overlay: { label: "First Registers", value: counts.firstRegisters, width: subsetWidth(counts.firstRegisters, counts.accepted) },
      },
      {
        id: "checked-in",
        label: "Checked in",
        value: counts.checkedIn,
        rate: rate(counts.checkedIn),
        width: width(counts.checkedIn),
        overlay: { label: "New Faces", value: counts.newFaces, width: subsetWidth(counts.newFaces, counts.checkedIn) },
      },
    ],
    questions,
  };
}

function personHasExactTag(person, tagName) {
  return Array.isArray(person?.tags) && person.tags.some((tag) => tag === tagName);
}

function computeInviteAudience(state) {
  const statuses = state.invite.sourceStatuses || sourceStatusDefaults;
  const exclude = new Set(state.invite.excludePeople || []);
  state.people.forEach((person) => {
    if (person.groups.some((groupId) => state.invite.excludeGroups.includes(groupId))) exclude.add(person.id);
  });
  (state.invite.excludeEventIds || []).forEach((eventId) => {
    const event = getEvent(state, eventId);
    event?.guests.forEach((guest) => {
      if (statuses.includes(guest.status)) exclude.add(guest.personId);
    });
  });

  const recipients = new Map();
  (state.invite.includePeople || []).forEach((personId) => {
    addRecipient(recipients, getPerson(state, personId), "Selected person");
  });
  (state.invite.includeEventIds || []).forEach((eventId) => {
    const event = getEvent(state, eventId);
    event?.guests.forEach((guest) => {
      if (statuses.includes(guest.status)) {
        addRecipient(recipients, getPerson(state, guest.personId), `${event.title}: ${statusLabels[guest.status]}`);
      }
    });
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
  const reasons = recipients.get(person.id).reasons;
  if (!reasons.includes(reason)) reasons.push(reason);
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
    .sort((a, b) => new Date(b.event.date).getTime() - new Date(a.event.date).getTime());

  const attendedRecords = records.filter(({ guest }) => guest.status === "checked_in" || Boolean(guest.checkedInAt));
  const registeredRecords = records.filter(({ guest }) => registeredStatuses.includes(guest.status));
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
    accepted: 0,
    registered: 0,
    waitlisted: 0,
    checkedIn: 0,
    invited: 0,
    toDecide: 0,
    firstRegisters: 0,
    newFaces: 0,
  };
  event.guests.forEach((guest) => {
    if (["going", "checked_in"].includes(guest.status)) stats.confirmed += 1;
    if (acceptedStatuses.includes(guest.status)) stats.accepted += 1;
    if (registeredStatuses.includes(guest.status)) stats.registered += 1;
    if (guest.status === "waitlisted") stats.waitlisted += 1;
    if (guest.status === "checked_in") stats.checkedIn += 1;
    if (guest.status === "invited") stats.invited += 1;
    if (guest.status === "registered" || (guest.status === "waitlisted" && guest.operatorDecision !== "waitlisted")) stats.toDecide += 1;
    if (isFirstRegister(guest)) stats.firstRegisters += 1;
    if (guest.status === "checked_in" && isFirstRegistration(guest)) stats.newFaces += 1;
  });
  return stats;
}

function isFirstRegister(guest) {
  return acceptedStatuses.includes(guest.status) && isFirstRegistration(guest);
}

function isFirstRegistration(guest) {
  return registrationStatuses.includes(guest.status)
    && (guest.isFirstRegistration === true || guest.isNewFace === true);
}

function isFirstRegistrationAtEvent(state, guest, event) {
  if (typeof guest.isFirstRegistration === "boolean" || typeof guest.isNewFace === "boolean") {
    return isFirstRegistration(guest);
  }
  if (!registrationStatuses.includes(guest.status)) return false;
  return !state.events.some((candidate) =>
    candidate.id !== event.id
    && eventOccursBefore(candidate, event)
    && candidate.guests.some((candidateGuest) => candidateGuest.personId === guest.personId),
  );
}

function eventOccursBefore(candidate, event) {
  if (candidate.startsAt && event.startsAt) {
    const candidateStart = new Date(candidate.startsAt).getTime();
    const eventStart = new Date(event.startsAt).getTime();
    if (Number.isFinite(candidateStart) && Number.isFinite(eventStart)) return candidateStart < eventStart;
  }
  const candidateDate = String(candidate.date || "").slice(0, 10);
  const eventDate = String(event.date || "").slice(0, 10);
  return Boolean(candidateDate && eventDate && candidateDate < eventDate);
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
  return [...events].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
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

function cleanTagName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 40);
}

function sortedTags(tags) {
  return [...tags].sort((left, right) => left.localeCompare(right));
}

function tagDefinitionForName(definitions, name) {
  return definitions.find((tag) => tag.name.toLocaleLowerCase() === String(name).toLocaleLowerCase()) || {
    id: `legacy-${String(name).toLocaleLowerCase()}`,
    name,
    color: "#0f766e",
  };
}

function tagDisplayName(name) {
  const value = String(name);
  const bareName = value.replace(/^(?:🚀|⚡|🎪|👻|💀)\s+/u, "");
  const emoji = AUTOMATIC_TAG_EMOJIS[bareName.toLocaleLowerCase()];
  return emoji ? `${emoji} ${bareName}` : value;
}

function mergeTagDefinition(definitions, definition) {
  const filtered = definitions.filter((tag) => tag.id !== definition.id && tag.name.toLocaleLowerCase() !== definition.name.toLocaleLowerCase());
  return [...filtered, definition].sort((left, right) => left.name.localeCompare(right.name));
}

function tagChipStyle(color) {
  return { "--tag-color": color } as CSSProperties;
}

function tagColorForName(name) {
  const hash = [...String(name)].reduce((total, character) => total + character.charCodeAt(0), 0);
  return TAG_COLOR_PALETTE[hash % TAG_COLOR_PALETTE.length];
}

function applyTagDefinitionUpdates(state, updates) {
  const next = { ...state, people: state.people.map((person) => ({ ...person, tags: [...person.tags] })) };
  updates.forEach((update) => {
    next.tagDefinitions = mergeTagDefinition(next.tagDefinitions, update);
    const previousName = update.previousName || update.name;
    const rename = (tags) => sortedTags(unique(tags.map((tag) => tag.toLocaleLowerCase() === previousName.toLocaleLowerCase() ? update.name : tag)));
    next.people = next.people.map((person) => ({ ...person, tags: rename(person.tags || []) }));
    next.filters = { ...next.filters, guestTags: rename(next.filters.guestTags || []) };
    next.tags = rename(next.tags || []);
  });
  return next;
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
