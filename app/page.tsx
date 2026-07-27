"use client";

import type { CSSProperties } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowRight,
  ArrowDown,
  ArrowUp,
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
  Layers3,
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
  X,
} from "lucide-react";
import { activityRecordStatus } from "./activity-status";
import { orderAvatarCandidates } from "./avatar-order";
import { guestStatusDate, guestStatusTimestamp } from "./guest-status-date";
import { updateGuestSelection } from "./guest-selection";
import { MAX_INVITE_MESSAGE_LENGTH } from "./invite-message";
import { MAX_GUEST_STATUS_MESSAGE_LENGTH } from "./guest-status-notification";
import { lumaEventManageUrl } from "./luma-event-url";
import { buildRegistrationQuestionAnalytics, eventWideAnalyticsCounts, invitationOutcomeCounts, REFERRED_PERSON_TAG, sortRegistrationQuestionOptions } from "./event-analytics";
import {
  EVENT_SWITCH_DIAGNOSTICS_ACTION,
  EVENT_SWITCH_DIAGNOSTICS_PARAM,
} from "./event-switch-diagnostics";
import { buildWorkspaceUrlSearch, parseWorkspaceUrl, type WorkspaceUrlState } from "./workspace-url";
import { changedLiveEventCountKeys, type LiveEventCounts } from "./event-count-reconciliation";

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
const QUESTION_RESPONSE_BATCH_SIZE = 10;
const MAX_GUEST_NOTE_LENGTH = 20_000;
const EVENT_CATALOG_REFRESH_COOLDOWN_MS = 5 * 60_000;
const ACTIVE_EVENT_COUNT_POLL_MS = 30_000;
const guestFilterOptions = [
  { value: "all", label: "All guests", color: "#706f69" },
  { value: "to_decide", label: "To Decide", color: "#9a6418" },
  { value: "checked_in", label: "Checked in", color: "#1d4f47" },
  { value: "accepted", label: "Accepted", color: "#047857" },
  { value: "registered", label: "Registered", color: "#316c86" },
  { value: "invited", label: "Invited", color: "#9a6418" },
  { value: "waitlisted", label: "Waitlisted", color: "#9a6418" },
  { value: "first_registers", label: "First Registers", color: "#316c86" },
  { value: "new_faces", label: "New faces", color: "#1d4f47" },
  { value: "referrals", label: "Referrals", color: "#316c86" },
  { value: "new_referrals", label: "New referrals", color: "#316c86" },
  { value: "invited_no_response", label: "Invitation: no response", color: "#9a6418" },
  { value: "invited_accepted", label: "Invitation: accepted", color: "#047857" },
  { value: "invited_checked_in", label: "Invitation: checked in", color: "#1d4f47" },
  { value: "invited_no_show", label: "Invitation: no-show", color: "#9d3d38" },
  { value: "invited_declined", label: "Invitation: declined", color: "#9d3d38" },
  { value: "invited_referrals", label: "Invitation referrals", color: "#316c86" },
  { value: "invited_referral_no_response", label: "Referral invitations: no response", color: "#316c86" },
  { value: "invited_referral_accepted", label: "Referral invitations: accepted", color: "#316c86" },
  { value: "invited_referral_declined", label: "Referral invitations: declined", color: "#316c86" },
  { value: "declined", label: "Declined", color: "#9d3d38" },
  { value: "no_show", label: "No-show", color: "#9d3d38" },
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
const LUMA_SESSION_TOKEN_STORAGE_KEY = "guestbook.lumaAuthSession";
const SESSION_KEY_HEADER = "x-guestbook-session-key";
const SESSION_KEY_COOKIE = "guestbook_session_key";
const UNIVERSAL_PEOPLE_SEARCH_DEBOUNCE_MS = 180;
const INVITE_METADATA_CLIENT_CACHE_MS = 120_000;
const TAG_COLOR_PALETTE = ["#0f766e", "#2563eb", "#7c3aed", "#db2777", "#dc2626", "#d97706", "#65a30d", "#475569"];
const AUTOMATIC_TAG_EMOJIS = {
  "superpower user": "🚀",
  "power user": "⚡",
  "festival dweller": "🎪",
  consistent: "🤞",
  reliable: "🙏",
  flaker: "👻",
  superflaker: "💀",
};

const automaticTagDescriptions = {
  new_guest: "Registered 1–3 times and has never checked in.",
  superpower_user: "Checked in to each of the last 5 public events.",
  power_user: "Checked in to each of the last 3 public events.",
  festival_dweller: "Their latest check-in was for a festival event.",
  consistent: "Checked in at least twice and attended 75%+ of registrations.",
  reliable: "Attended 90%+ of at least 2 registrations.",
  flaker: "Missed their last 3 approved registrations.",
  superflaker: "Missed their last 6 approved registrations.",
};

function emptyInviteMetadata() {
  return {
    tagGroups: [],
    superTagGroups: [],
    eventCounts: {},
    tagsStatus: "idle",
    eventsStatus: "idle",
    tagsError: "",
    eventsError: "",
    tagsLoadedAt: 0,
    eventsLoadedAt: 0,
  };
}

const initialState = {
  selectedEventId: "",
  selectedEventIds: [],
  selectedPersonId: "",
  selectedGroupId: "",
  filters: {
    event: "upcoming",
    guestStatus: "all",
    guestSearch: "",
    guestTags: [],
    guestHasNotes: false,
    guestAttendedGreaterThan: "",
    globalSearch: "",
    memberSearch: "",
  },
  invite: {
    targetEventId: "",
    sourceEventId: "",
    sourceStatuses: ["going", "checked_in"],
    includeEventIds: [],
    excludeEventIds: [],
    includeEventCohorts: {},
    excludeEventCohorts: {},
    includeGroups: [],
    excludeGroups: [],
    includeTags: [],
    excludeTags: [],
    includeSuperTags: [],
    excludeSuperTags: [],
    excludeTagPeople: {},
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
  const [guestDateSortDirection, setGuestDateSortDirection] = useState<"asc" | "desc">("desc");
  const [commandPressed, setCommandPressed] = useState(false);
  const [loadingGuestEvents, setLoadingGuestEvents] = useState([]);
  const [eventDraft, setEventDraft] = useState(null);
  const [guestStatusDraft, setGuestStatusDraft] = useState(null);
  const [bulkTagConfirmation, setBulkTagConfirmation] = useState(null);
  const [lumaSessionPrompt, setLumaSessionPrompt] = useState(null);
  const [lumaCheckInGuestKey, setLumaCheckInGuestKey] = useState("");
  const [reinvitingGuestKey, setReinvitingGuestKey] = useState("");
  const [guestNoteDraft, setGuestNoteDraft] = useState(null);
  const [analyticsRespondentDialog, setAnalyticsRespondentDialog] = useState(null);
  const [openTagPersonId, setOpenTagPersonId] = useState("");
  const [savingTagPersonId, setSavingTagPersonId] = useState("");
  const [tagSettingsOpen, setTagSettingsOpen] = useState(false);
  const [tagSettingsSaving, setTagSettingsSaving] = useState(false);
  const [superTags, setSuperTags] = useState<any[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [universalQuery, setUniversalQuery] = useState("");
  const [universalPeopleSearch, setUniversalPeopleSearch] = useState({ query: "", status: "idle", results: [], error: "" });
  const universalSearchInputRef = useRef(null);
  const guestRequestsRef = useRef(new Set());
  const latestGuestRequestRef = useRef(new Map());
  const analyticsRequestsRef = useRef(new Set());
  const multiEventStatsRequestsRef = useRef(new Set());
  const multiEventGuestAbortRef = useRef<AbortController | null>(null);
  const multiEventGuestRequestKeyRef = useRef("");
  const guestHistoryRequestsRef = useRef(new Set());
  const referrerRequestsRef = useRef(new Set());
  // EVENT_SWITCH_DIAGNOSTICS: temporary per-navigation state; remove with the shared diagnostics module.
  const eventSwitchDiagnosticRef = useRef<any>(null);
  const traceRequestsRef = useRef(new Set());
  const eventCatalogRefreshInFlightRef = useRef(false);
  const lastEventCatalogRefreshAtRef = useRef(0);
  const activeEventCountCheckInFlightRef = useRef(false);
  const reconcileActiveEventCountsRef = useRef<() => void>(() => {});
  const eventListRef = useRef(null);
  const eventStartRef = useRef(null);
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
  const [inviteMetadata, setInviteMetadata] = useState(() => emptyInviteMetadata());
  const inviteMetadataRef = useRef(inviteMetadata);
  const inviteMetadataRequestsRef = useRef<Record<string, Promise<any> | null>>({ tags: null, events: null });
  const [debouncedGuestSearch, setDebouncedGuestSearch] = useState("");
  const [selectedGuestIds, setSelectedGuestIds] = useState<Set<string>>(new Set());
  const [allMatchingGuestsSelected, setAllMatchingGuestsSelected] = useState(false);
  const lastSelectedGuestIdRef = useRef("");
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [lifecycleNow, setLifecycleNow] = useState(() => Date.now());
  const [multiEventStatsByKey, setMultiEventStatsByKey] = useState<Record<string, any>>({});
  const [multiEventGuestState, setMultiEventGuestState] = useState<{ key: string; loading: boolean; pageInfo: any }>({ key: "", loading: false, pageInfo: null });
  const [sessionStatus, setSessionStatus] = useState("checking");
  const [sessionKey, setSessionKey] = useState("");
  const [sessionKeyDraft, setSessionKeyDraft] = useState("");
  const [sessionError, setSessionError] = useState("");

  const setApiState = (next) => {
    setApiStateValue(next);
    setToastSequence((current) => current + 1);
  };

  const invalidateMultiEventStats = () => setMultiEventStatsByKey({});

  const applyWorkspaceUrlState = (urlState: WorkspaceUrlState) => {
    workspaceUrlModeRef.current = "replace";
    pendingProfileIdRef.current = urlState.profileId;
    setGuestPageTarget(urlState.guestPage);
    setActiveEventTab(urlState.tab);
    setProfilePanelOpen(Boolean(urlState.profileId));
    setState((current) => ({
      ...current,
      selectedEventId: urlState.eventId || current.selectedEventId,
      selectedEventIds: urlState.eventIds.length ? urlState.eventIds : current.selectedEventIds,
      selectedPersonId: urlState.profileId || current.selectedPersonId,
      filters: {
        ...current.filters,
        event: urlState.eventView,
        globalSearch: urlState.eventSearch,
        guestStatus: urlState.guestStatus,
        guestSearch: urlState.guestSearch,
        guestTags: urlState.guestTags,
        guestHasNotes: Boolean(urlState.guestHasNotes),
        guestAttendedGreaterThan: urlState.guestAttendedGreaterThan == null ? "" : String(urlState.guestAttendedGreaterThan),
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

  useEffect(() => {
    const updateCommandState = (event: KeyboardEvent) => setCommandPressed(event.metaKey);
    const clearCommandState = () => setCommandPressed(false);
    window.addEventListener("keydown", updateCommandState);
    window.addEventListener("keyup", updateCommandState);
    window.addEventListener("blur", clearCommandState);
    return () => {
      window.removeEventListener("keydown", updateCommandState);
      window.removeEventListener("keyup", updateCommandState);
      window.removeEventListener("blur", clearCommandState);
    };
  }, []);

  const lockSession = (message = "") => {
    window.localStorage.removeItem(SESSION_KEY_STORAGE_KEY);
    clearSessionCookie();
    setSessionKey("");
    setSessionStatus("locked");
    setSessionError(message);
    setState(initialState);
    const clearedInviteMetadata = emptyInviteMetadata();
    inviteMetadataRef.current = clearedInviteMetadata;
    inviteMetadataRequestsRef.current = { tags: null, events: null };
    setInviteMetadata(clearedInviteMetadata);
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

  const updateInviteMetadata = (updater) => {
    setInviteMetadata((current) => {
      const next = updater(current);
      inviteMetadataRef.current = next;
      return next;
    });
  };

  const loadInviteMetadata = async (section: "tags" | "events", { force = false } = {}) => {
    const statusKey = section === "tags" ? "tagsStatus" : "eventsStatus";
    const errorKey = section === "tags" ? "tagsError" : "eventsError";
    const loadedAtKey = section === "tags" ? "tagsLoadedAt" : "eventsLoadedAt";
    const cached = inviteMetadataRef.current;
    if (!force && cached[statusKey] === "ready" && Date.now() - cached[loadedAtKey] < INVITE_METADATA_CLIENT_CACHE_MS) {
      return section === "tags" ? cached.tagGroups : cached.eventCounts;
    }
    const existingRequest = inviteMetadataRequestsRef.current[section];
    if (existingRequest) return existingRequest;

    const hasCachedData = section === "tags" ? cached.tagGroups.length > 0 : Object.keys(cached.eventCounts).length > 0;
    updateInviteMetadata((current) => ({ ...current, [statusKey]: hasCachedData ? "refreshing" : "loading", [errorKey]: "" }));
    const request = (async () => {
      const response = await apiFetch(`/api/audience/bootstrap?include=${section}`, { cache: "no-store" });
      const data: any = await response.json();
      if (!response.ok) throw new Error(data.error || `Unable to load invite ${section}.`);
      if (section === "tags") {
        const tagGroups = Array.isArray(data.tags) ? data.tags : [];
        const superTagGroups = Array.isArray(data.superTags) ? data.superTags : [];
        updateInviteMetadata((current) => ({ ...current, tagGroups, superTagGroups, tagsStatus: "ready", tagsError: "", tagsLoadedAt: Date.now() }));
        return tagGroups;
      }
      const eventCounts = Object.fromEntries((Array.isArray(data.counts) ? data.counts : []).map((item) => [item.eventId, item]));
      updateInviteMetadata((current) => ({ ...current, eventCounts, eventsStatus: "ready", eventsError: "", eventsLoadedAt: Date.now() }));
      return eventCounts;
    })().catch((error) => {
      updateInviteMetadata((current) => ({ ...current, [statusKey]: "error", [errorKey]: error.message || `Unable to load invite ${section}.` }));
      throw error;
    }).finally(() => {
      inviteMetadataRequestsRef.current[section] = null;
    });
    inviteMetadataRequestsRef.current[section] = request;
    return request;
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
        const openToolbarFilter = document.querySelector<HTMLDetailsElement>(".toolbar-filter-menu[open]");
        if (openToolbarFilter) {
          event.preventDefault();
          openToolbarFilter.open = false;
          openToolbarFilter.querySelector("summary")?.focus();
          return;
        }
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
    const query = universalQuery.trim().toLocaleLowerCase();
    if (!searchOpen || !query) {
      setUniversalPeopleSearch({ query: "", status: "idle", results: [], error: "" });
      return;
    }

    const controller = new AbortController();
    setUniversalPeopleSearch({ query, status: "loading", results: [], error: "" });
    const timeout = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: universalQuery.trim(), limit: "8" });
        const response = await apiFetch(`/api/search/people?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const data: any = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to search people.");
        if (!controller.signal.aborted) {
          setUniversalPeopleSearch({ query, status: "ready", results: Array.isArray(data.people) ? data.people : [], error: "" });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setUniversalPeopleSearch({ query, status: "error", results: [], error: error.message || "Unable to search people." });
      }
    }, UNIVERSAL_PEOPLE_SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [searchOpen, universalQuery, sessionKey]);

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

  useEffect(() => {
    const interval = window.setInterval(() => setLifecycleNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const refreshLumaEventCatalog = async ({ reason = "load", force = false } = {}) => {
    if (eventCatalogRefreshInFlightRef.current) return null;
    if (!force && Date.now() - lastEventCatalogRefreshAtRef.current < EVENT_CATALOG_REFRESH_COOLDOWN_MS) return null;

    eventCatalogRefreshInFlightRef.current = true;
    try {
      const params = new URLSearchParams({ refresh_events: "1", trigger: reason });
      const response = await apiFetch(`/api/luma?${params.toString()}`, { cache: "no-store" });
      const data: any = await response.json();
      if (!response.ok) throw new Error(withRequestId(data.error || "Unable to refresh the Luma event catalog.", data.requestId));
      setState((current) => mergeLumaEventCatalogState(current, data));
      lastEventCatalogRefreshAtRef.current = Date.now();
      return data;
    } catch (error) {
      if (reason === "load") setApiState({ status: "error", message: error.message });
      return null;
    } finally {
      eventCatalogRefreshInFlightRef.current = false;
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
    loadLumaEvents({ cancelled: () => cancelled }).then(() => {
      if (!cancelled) void refreshLumaEventCatalog({ reason: "load" });
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceUrlReady, sessionStatus, sessionKey]);

  useEffect(() => {
    if (sessionStatus !== "ready" || !sessionKey) return;
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") void refreshLumaEventCatalog({ reason: "tab_active" });
    };
    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("focus", refreshIfVisible);
    return () => {
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("focus", refreshIfVisible);
    };
  }, [sessionStatus, sessionKey]);

  useEffect(() => {
    if (sessionStatus !== "ready" || !sessionKey) return;
    void loadAvailableTags();
  }, [sessionStatus, sessionKey]);

  useEffect(() => {
    if (sessionStatus !== "ready" || !sessionKey) return;
    const timeout = window.setTimeout(() => void loadInviteMetadata("tags").catch(() => {}), 250);
    return () => window.clearTimeout(timeout);
  }, [sessionStatus, sessionKey]);

  const selectedEvent = getEvent(state, state.selectedEventId);
  const selectedEvents = selectedWorkspaceEvents(state);
  const selectedEventIdsKey = selectedEvents.map((event) => event.id).join("\u0000");
  const multiEventStatsKey = [...selectedEvents].map((event) => event.id).sort().join("\u0000");
  const multiEventMode = selectedEvents.length > 1;
  const uniqueWorkspaceStats = multiEventMode ? multiEventStatsByKey[multiEventStatsKey] || null : null;
  const selectedEventManageUrl = lumaEventManageUrl(selectedEvent);
  const selectedPerson = getPerson(state, state.selectedPersonId);
  const selectedTrace = selectedPerson ? activityTraces[selectedPerson.id] || { status: "idle", records: [] } : { status: "idle", records: [] };
  const selectedProfileRecord = selectedPerson ? currentProfileRecord(state, selectedPerson) : null;

  const inviteAudience = useMemo(() => computeInviteAudience(state), [state]);
  const selectedEventAnalytics = useMemo(() => buildWorkspaceAnalytics(state, selectedEvents, uniqueWorkspaceStats), [state, selectedEventIdsKey, uniqueWorkspaceStats]);
  const filteredEvents = useMemo(() => visibleEvents(state, lifecycleNow), [state, lifecycleNow]);
  const eventListKey = `${state.filters.event}:${state.filters.globalSearch.trim().toLowerCase()}`;
  const eventListSignature = filteredEvents.map((event) => `${event.id}:${event.date}`).join("|");
  const eventAnchorId = state.filters.event === "all" ? nearestUpcomingEventId(filteredEvents) : "";
  const renderedEvents = filteredEvents.slice(eventWindow.start, eventWindow.end);
  const visibleGuests = useMemo(
    () => workspaceEventGuests(state, selectedEvents, guestDateSortDirection),
    [state, selectedEventIdsKey, guestDateSortDirection],
  );
  const guestTagFilterKey = state.filters.guestTags.join("\u0000");
  const multiEventGuestQueryKey = `${multiEventStatsKey}:${state.filters.guestStatus}:${debouncedGuestSearch}:${guestTagFilterKey}:${state.filters.guestHasNotes ? 1 : 0}:${state.filters.guestAttendedGreaterThan}:${guestDateSortDirection}`;
  const normalizedUniversalQuery = universalQuery.trim().toLocaleLowerCase();
  const activeUniversalPeopleSearch = universalPeopleSearch.query === normalizedUniversalQuery ? universalPeopleSearch : null;
  const universalResults = useMemo(
    () => universalSearchResults(state, universalQuery, activeUniversalPeopleSearch?.status === "ready" ? activeUniversalPeopleSearch.results : null),
    [state, universalQuery, activeUniversalPeopleSearch],
  );
  const universalResultCount = universalResults.events.length + universalResults.people.length + universalResults.groups.length;
  const showGuestGroups = visibleGuests.some(({ person }) => person.groups.length > 0);
  const hasSelectedProfile = hasProfileContent(state, selectedPerson);
  const showProfilePanel = profilePanelOpen && hasSelectedProfile;
  const showGuestReferrer = !showProfilePanel;
  const guestTableColumnCount = 9 + Number(showGuestGroups) + Number(showGuestReferrer);
  const hasActiveGuestFilters = state.filters.guestStatus !== "all"
    || state.filters.guestTags.length > 0
    || state.filters.guestHasNotes
    || state.filters.guestAttendedGreaterThan !== ""
    || Boolean(state.filters.guestSearch.trim());
  const inviteTargetEvent = getEvent(state, state.invite.targetEventId);
  const inviteTargetEvents = selectedEvents.length ? selectedEvents : inviteTargetEvent ? [inviteTargetEvent] : [];
  const selectedEventLoadingGuests = selectedEvents.some((event) => loadingGuestEvents.includes(event.id))
    || (multiEventMode && multiEventGuestState.key === multiEventGuestQueryKey && multiEventGuestState.loading);
  const selectedEventNeedsGuestLoad = selectedEvents.some((event) => event.source === "luma" && !event.guestsLoaded);
  const selectedGuestRows = visibleGuests.filter(({ person }) => selectedGuestIds.has(person.id));
  const activeMultiEventGuestPageInfo = multiEventMode && multiEventGuestState.key === multiEventGuestQueryKey ? multiEventGuestState.pageInfo : null;
  const workspaceGuestSelectionTotal = Math.max(
    visibleGuests.length,
    Number(activeMultiEventGuestPageInfo?.total)
      || selectedEvents.reduce((total, event) => total + (event.guestPageInfo?.total || 0), 0),
  );
  const bulkSelectionCount = allMatchingGuestsSelected ? workspaceGuestSelectionTotal : selectedGuestRows.length;
  const allVisibleGuestsSelected = allMatchingGuestsSelected
    || (visibleGuests.length > 0 && visibleGuests.every(({ person }) => selectedGuestIds.has(person.id)));
  const loadedGuestPage = activeMultiEventGuestPageInfo
    ? Math.max(1, Math.ceil((activeMultiEventGuestPageInfo.loaded || 0) / GUEST_PAGE_SIZE))
    : Math.max(1, ...selectedEvents.map((event) => Math.ceil((event.guests?.length || 0) / GUEST_PAGE_SIZE)));
  const workspaceGuestTotal = activeMultiEventGuestPageInfo?.matchingRegistrations
    ?? selectedEvents.reduce((total, event) => total + (event.guestPageInfo?.total || 0), 0);
  const workspaceGuestHasMore = activeMultiEventGuestPageInfo?.hasMore
    ?? selectedEvents.some((event) => event.guestPageInfo?.hasMore);
  const workspaceStats = uniqueWorkspaceStats || aggregateEventStats(selectedEvents);
  const workspaceStatsLoading = multiEventMode && !uniqueWorkspaceStats;

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
      eventIds: selectedEvents.map((event) => event.id),
      eventView: state.filters.event as WorkspaceUrlState["eventView"],
      eventSearch: state.filters.globalSearch.trim(),
      tab: activeEventTab as WorkspaceUrlState["tab"],
      guestStatus: state.filters.guestStatus,
      guestSearch: state.filters.guestSearch.trim(),
      guestTags: state.filters.guestTags,
      guestHasNotes: state.filters.guestHasNotes,
      guestAttendedGreaterThan: state.filters.guestAttendedGreaterThan === ""
        ? null
        : Number(state.filters.guestAttendedGreaterThan),
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
    selectedEventIdsKey,
    activeEventTab,
    profilePanelOpen,
    selectedPerson?.id,
    state.filters.event,
    state.filters.globalSearch,
    state.filters.guestStatus,
    state.filters.guestSearch,
    guestTagFilterKey,
    state.filters.guestHasNotes,
    state.filters.guestAttendedGreaterThan,
    guestPageTarget,
    loadedGuestPage,
  ]);

  useEffect(() => {
    if (sessionStatus !== "ready" || !multiEventMode || !multiEventStatsKey || multiEventStatsByKey[multiEventStatsKey] || multiEventStatsRequestsRef.current.has(multiEventStatsKey)) return;
    multiEventStatsRequestsRef.current.add(multiEventStatsKey);
    const params = new URLSearchParams({ multi_event_stats: "1" });
    selectedEvents.forEach((event) => params.append("event_id", event.id));
    void apiFetch(`/api/luma?${params.toString()}`, { cache: "no-store" })
      .then(async (response) => {
        const data: any = await response.json();
        if (!response.ok) throw new Error(withRequestId(data.error || "Unable to load unique multi-event statistics.", data.requestId));
        setMultiEventStatsByKey((current) => ({ ...current, [multiEventStatsKey]: data.stats || {} }));
      })
      .catch((error) => setApiState({ status: "error", message: error.message }))
      .finally(() => multiEventStatsRequestsRef.current.delete(multiEventStatsKey));
  }, [sessionStatus, multiEventMode, multiEventStatsKey, multiEventStatsByKey]);

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

    if (position <= EVENT_SCROLL_THRESHOLD) prependEventWindow();
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
    const target = eventStartRef.current;
    if (!root || !target || eventWindow.start <= 0) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        prependEventWindow();
      },
      { root, rootMargin: `${EVENT_SCROLL_THRESHOLD}px` },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [eventListKey, eventListSignature, eventWindow.start]);

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
      if (eventId) {
        draft.selectedEventId = eventId;
        draft.selectedEventIds = [eventId];
      }
    });
    setProfilePanelOpen(true);
  };

  const openAnalyticsResponsePerson = async (personId: string) => {
    if (!personId) return;
    if (getPerson(state, personId)) {
      openPerson(personId);
      return;
    }

    try {
      const params = new URLSearchParams({ trace_person_id: personId });
      const response = await apiFetch("/api/luma?" + params.toString(), { cache: "no-store" });
      const data: any = await response.json();
      if (!response.ok || !data.person) {
        throw new Error(withRequestId(data.error || "Unable to load this respondent.", data.requestId));
      }
      setActivityTraces((current) => ({
        ...current,
        [personId]: {
          status: "ready",
          records: data.records || [],
          scanned: data.scanned,
          limits: data.limits,
          requestId: data.requestId,
          loadedAt: data.loadedAt,
          message: `${(data.records || []).length} indexed activity records.`,
        },
      }));
      workspaceUrlModeRef.current = "push";
      setState((current) => normalizeState({
        ...current,
        people: [
          ...current.people.filter((person) => person.id !== personId),
          mergePersonRecord(getPerson(current, personId), data.person),
        ],
        selectedPersonId: personId,
      }));
      setProfilePanelOpen(true);
    } catch (error: any) {
      setApiState({ status: "error", message: error.message });
    }
  };

  const loadAnalyticsRespondents = async (draft, { append = false } = {}) => {
    if (!draft || draft.loading) return;
    const cursor = append ? draft.pageInfo?.nextCursor || String(draft.respondents.length) : "0";
    setAnalyticsRespondentDialog((current) => current?.key === draft.key
      ? { ...current, loading: true, error: "" }
      : current);

    try {
      const params = new URLSearchParams({
        analytics_respondents: "1",
        question: draft.question.label,
        respondent_cursor: cursor,
      });
      draft.eventIds.forEach((eventId) => params.append("event_id", eventId));
      if (draft.answer) params.set("answer", draft.answer);
      const response = await apiFetch(`/api/luma?${params.toString()}`, { cache: "no-store" });
      const data: any = await response.json();
      if (!response.ok) throw new Error(withRequestId(data.error || "Unable to load respondents.", data.requestId));
      setAnalyticsRespondentDialog((current) => {
        if (!current || current.key !== draft.key) return current;
        const respondents = append
          ? [...new Map([...current.respondents, ...(data.respondents || [])].map((row) => [row.person.id, row])).values()]
          : data.respondents || [];
        return {
          ...current,
          respondents,
          pageInfo: data.pageInfo || null,
          loading: false,
          error: "",
        };
      });
    } catch (error: any) {
      setAnalyticsRespondentDialog((current) => current?.key === draft.key
        ? { ...current, loading: false, error: error.message }
        : current);
    }
  };

  const openAnalyticsRespondents = (question, option = null) => {
    const eventIds = selectedEvents.map((event) => event.id);
    const answer = option?.label || "";
    const draft = {
      key: `${eventIds.join("\u0000")}\u0000${question.id}\u0000${answer}`,
      eventIds,
      question: { id: question.id, label: question.label, responseCount: question.responseCount },
      answer,
      expectedCount: Number(option?.count ?? question.responseCount) || 0,
      respondents: [],
      pageInfo: null,
      loading: false,
      error: "",
    };
    setAnalyticsRespondentDialog(draft);
    void loadAnalyticsRespondents(draft);
  };

  const selectEvent = (eventId, { additive = false, preserveProfile = false }: { additive?: boolean; preserveProfile?: boolean } = {}) => {
    const currentIds = selectedWorkspaceEvents(state).map((event) => event.id);
    const alreadySelected = currentIds.includes(eventId);
    let nextIds = [eventId];
    if (additive) {
      nextIds = alreadySelected
        ? currentIds.length > 1 ? currentIds.filter((id) => id !== eventId) : currentIds
        : [...currentIds, eventId];
    }
    const nextPrimaryId = nextIds.includes(eventId) ? eventId : nextIds.at(-1) || eventId;
    const eventChanged = nextPrimaryId !== state.selectedEventId || nextIds.join("\u0000") !== currentIds.join("\u0000");
    if (eventChanged) beginEventSwitchDiagnostic(nextPrimaryId);
    if (eventChanged) workspaceUrlModeRef.current = "push";
    pendingProfileIdRef.current = "";
    setGuestPageTarget(1);
    if (eventChanged) {
      setDebouncedGuestSearch("");
      setGuestDateSortDirection("desc");
      setAllMatchingGuestsSelected(false);
      setSelectedGuestIds(new Set());
      lastSelectedGuestIdRef.current = "";
      setOpenTagPersonId("");
    }
    updateState((draft) => {
      draft.selectedEventId = nextPrimaryId;
      draft.selectedEventIds = nextIds;
      draft.invite.targetEventId = nextPrimaryId;
      if (eventChanged) {
        draft.filters.guestStatus = "all";
        draft.filters.guestSearch = "";
        draft.filters.guestTags = [];
        draft.filters.guestHasNotes = false;
        draft.filters.guestAttendedGreaterThan = "";
      }
    });
    if (eventChanged && !preserveProfile) setProfilePanelOpen(false);
  };

  const clearMultiEventSelection = () => {
    const firstSelectedEvent = selectedWorkspaceEvents(state)[0];
    if (firstSelectedEvent) selectEvent(firstSelectedEvent.id);
  };

  const setFilter = (key, value) => {
    if (["guestStatus", "guestSearch", "guestTags"].includes(key)) {
      setGuestPageTarget(1);
      setAllMatchingGuestsSelected(false);
      setSelectedGuestIds(new Set());
      lastSelectedGuestIdRef.current = "";
    }
    updateState((draft) => {
      draft.filters[key] = value;
    });
  };

  const clearGuestFilters = () => {
    setGuestPageTarget(1);
    setDebouncedGuestSearch("");
    setAllMatchingGuestsSelected(false);
    setSelectedGuestIds(new Set());
    lastSelectedGuestIdRef.current = "";
    updateState((draft) => {
      draft.filters.guestStatus = "all";
      draft.filters.guestTags = [];
      draft.filters.guestSearch = "";
      draft.filters.guestHasNotes = false;
      draft.filters.guestAttendedGreaterThan = "";
    });
  };

  const setInvite = (key, value) => {
    const updates = typeof key === "object" && key ? key : { [key]: value };
    setState((current) => ({
      ...current,
      invite: { ...current.invite, ...updates },
    }));
  };

  const loadEventGuests = async (
    eventId: string,
    {
      force = false,
      append = false,
      status = state.filters.guestStatus,
      search = debouncedGuestSearch,
      tags = state.filters.guestTags,
      hasNotes = state.filters.guestHasNotes,
      attendedGreaterThan = state.filters.guestAttendedGreaterThan,
      cursor = "",
      priority = false,
      background = false,
    }: { force?: boolean; append?: boolean; status?: string; search?: string; tags?: string[]; hasNotes?: boolean; attendedGreaterThan?: string; cursor?: string; priority?: boolean; background?: boolean } = {},
  ) => {
    const event = getEvent(state, eventId);
    if (!event) {
      setApiState({ status: "error", message: "Could not find event " + eventId + ". Reload the page and try again." });
      return false;
    }
    if (event.source !== "luma") {
      setApiState({ status: "error", message: event.title + " is not linked to Luma, so there are no remote guests to load." });
      return false;
    }
    const nextCursor = append ? cursor || event.guestPageInfo?.nextCursor || "" : "";
    if (append && !nextCursor) return false;

    const params = new URLSearchParams({
      event_id: eventId,
      guest_status: status,
      guest_limit: String(GUEST_PAGE_SIZE),
      guest_sort: guestDateSortDirection,
    });
    if (search) params.set("guest_search", search);
    if (hasNotes) params.set("guest_has_notes", "1");
    if (attendedGreaterThan !== "") params.set("guest_attended_gt", attendedGreaterThan);
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
    if (guestRequestsRef.current.has(requestKey)) return false;

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
      if (force) {
        setActivityTraces({});
        invalidateMultiEventStats();
      }
      const truncatedText = data.truncated ? " Showing the configured capped guest window only." : "";
      const requestText = data.requestId ? " Request " + data.requestId + "." : "";
      const resultText = force
        ? `Synced ${data.event?.title || event.title} and ${data.pageInfo?.total ?? data.guests.length} matching guests.`
        : `${data.cached ? "Used cached guests for " : "Loaded guests for "}${event.title}.`;
      if (force) setApiState({ status: "live", message: resultText + truncatedText + requestText });
      return true;
    } catch (error) {
      if (activeEventSwitchDiagnostic(eventId)) completeEventSwitchDiagnostic(eventId, "error");
      if (latestGuestRequestRef.current.get(eventId) === requestToken) {
        setState((current) => ({
          ...current,
          events: current.events.map((item) => item.id === eventId ? { ...item, guestQueryLoading: false, guestSnapshotWarming: false } : item),
        }));
        if (!background) setApiState({ status: "error", message: error.message });
      }
      return false;
    } finally {
      guestRequestsRef.current.delete(requestKey);
      if (latestGuestRequestRef.current.get(eventId) === requestToken) {
        if (!background) setLoadingGuestEvents((current) => current.filter((id) => id !== eventId));
      }
    }
  };

  const reconcileActiveEventCounts = async () => {
    if (
      document.visibilityState !== "visible"
      || activeEventCountCheckInFlightRef.current
    ) return;
    const events = selectedWorkspaceEvents(state)
      .filter((event) => event.source === "luma" && eventHeaderStatsReady(event))
      .slice(0, 50);
    if (!events.length) return;

    activeEventCountCheckInFlightRef.current = true;
    try {
      const params = new URLSearchParams({ live_event_counts: "1" });
      events.forEach((event) => params.append("event_id", event.id));
      const response = await apiFetch(`/api/luma?${params.toString()}`, { cache: "no-store" });
      const data: any = await response.json();
      if (!response.ok) throw new Error(withRequestId(data.error || "Unable to check live event counts.", data.requestId));
      const liveCounts = new Map<string, LiveEventCounts>(
        (Array.isArray(data.counts) ? data.counts : []).map((counts: LiveEventCounts) => [counts.eventId, counts]),
      );
      const changedEvents = events.filter((event) => {
        const counts = liveCounts.get(event.id);
        return counts && changedLiveEventCountKeys(event.guestStats, counts).length > 0;
      });
      for (const event of changedEvents) {
        await loadEventGuests(event.id, { force: true, priority: true, background: true });
      }
    } catch {
      // This passive freshness check should not interrupt the workspace. The
      // server records a redacted request-scoped error for diagnostics.
    } finally {
      activeEventCountCheckInFlightRef.current = false;
    }
  };
  reconcileActiveEventCountsRef.current = () => void reconcileActiveEventCounts();

  useEffect(() => {
    if (sessionStatus !== "ready" || !sessionKey || !selectedEventIdsKey) return;
    const checkIfVisible = () => {
      if (document.visibilityState === "visible") reconcileActiveEventCountsRef.current();
    };
    checkIfVisible();
    const interval = window.setInterval(checkIfVisible, ACTIVE_EVENT_COUNT_POLL_MS);
    document.addEventListener("visibilitychange", checkIfVisible);
    window.addEventListener("focus", checkIfVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", checkIfVisible);
      window.removeEventListener("focus", checkIfVisible);
    };
  }, [sessionStatus, sessionKey, selectedEventIdsKey]);

  const performSelectedEventSync = async (eventIds, token = "") => {
    const normalizedToken = normalizeLumaSessionTokenInput(token);
    let scannedReferrers = 0;
    let updatedReferrers = 0;
    let failedReferrers = 0;
    let referrersTruncated = false;
    try {
      for (const eventId of eventIds) {
        await loadEventGuests(eventId, { force: true });
        if (!normalizedToken) continue;
        const result = await postLumaAction({
          action: "syncGuestReferrers",
          eventId,
          lumaSessionToken: normalizedToken,
        }, apiFetch);
        scannedReferrers += result.scanned || 0;
        updatedReferrers += result.updated || 0;
        failedReferrers += result.failed || 0;
        referrersTruncated ||= Boolean(result.truncated);
        await loadEventGuests(eventId);
      }
      if (normalizedToken) {
        const failureText = failedReferrers ? ` ${failedReferrers} detail request${failedReferrers === 1 ? "" : "s"} failed.` : "";
        const limitText = referrersTruncated ? " The configured referrer limit was reached." : "";
        setApiState({
          status: failedReferrers ? "error" : "live",
          message: `Synced ${eventIds.length} event${eventIds.length === 1 ? "" : "s"}; checked ${scannedReferrers} missing referrer${scannedReferrers === 1 ? "" : "s"} and filled ${updatedReferrers}.${failureText}${limitText}`,
        });
      }
      return true;
    } catch (error: any) {
      if (error.code === "LUMA_SESSION_INVALID") {
        window.localStorage.removeItem(LUMA_SESSION_TOKEN_STORAGE_KEY);
        setLumaSessionPrompt({
          pending: { kind: "sync_referrers", eventIds },
          token: "",
          error: error.message,
          submitting: false,
        });
        return false;
      }
      setApiState({ status: "error", message: error.message });
      return false;
    }
  };

  const requestSelectedEventSync = () => {
    const eventIds = selectedWorkspaceEvents(state)
      .filter((event) => event.source === "luma")
      .map((event) => event.id);
    if (!eventIds.length) return;
    const storedToken = window.localStorage.getItem(LUMA_SESSION_TOKEN_STORAGE_KEY) || "";
    if (!storedToken) {
      setLumaSessionPrompt({
        pending: { kind: "sync_referrers", eventIds },
        token: "",
        error: "",
        submitting: false,
      });
      return;
    }
    void performSelectedEventSync(eventIds, storedToken);
  };

  const loadMultiEventGuests = async (
    {
      append = false,
      status = state.filters.guestStatus,
      search = debouncedGuestSearch,
      tags = state.filters.guestTags,
      hasNotes = state.filters.guestHasNotes,
      attendedGreaterThan = state.filters.guestAttendedGreaterThan,
      cursor = "",
    }: { append?: boolean; status?: string; search?: string; tags?: string[]; hasNotes?: boolean; attendedGreaterThan?: string; cursor?: string } = {},
  ) => {
    const eventIds = selectedWorkspaceEvents(state)
      .filter((event) => event.source === "luma")
      .map((event) => event.id);
    if (eventIds.length < 2) return;

    const queryKey = `${[...eventIds].sort().join("\u0000")}:${status}:${search}:${tags.join("\u0000")}:${hasNotes ? 1 : 0}:${attendedGreaterThan}`;
    if (append && (multiEventGuestState.loading || !cursor || (multiEventGuestAbortRef.current && !multiEventGuestAbortRef.current.signal.aborted))) return;
    multiEventGuestAbortRef.current?.abort();
    const controller = new AbortController();
    multiEventGuestAbortRef.current = controller;
    multiEventGuestRequestKeyRef.current = queryKey;

    const params = new URLSearchParams({
      multi_event_guests: "1",
      guest_status: status,
      guest_limit: String(GUEST_PAGE_SIZE),
      guest_summary: "0",
      guest_sort: guestDateSortDirection,
    });
    eventIds.forEach((eventId) => params.append("event_id", eventId));
    if (search) params.set("guest_search", search);
    if (hasNotes) params.set("guest_has_notes", "1");
    if (attendedGreaterThan !== "") params.set("guest_attended_gt", attendedGreaterThan);
    tags.forEach((tag) => params.append("guest_tag", tag));
    if (cursor) params.set("guest_cursor", cursor);

    setMultiEventGuestState((current) => ({
      key: queryKey,
      loading: true,
      pageInfo: append && current.key === queryKey ? current.pageInfo : null,
    }));
    if (!append) {
      const selectedIds = new Set(eventIds);
      setState((current) => ({
        ...current,
        events: current.events.map((event) => selectedIds.has(event.id)
          ? { ...event, guests: [], guestQueryLoading: true }
          : event),
      }));
    }

    try {
      const response = await apiFetch(`/api/luma?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const data: any = await response.json();
      if (!response.ok) throw new Error(withRequestId(data.error || "Unable to load combined guests.", data.requestId));
      if (controller.signal.aborted || multiEventGuestRequestKeyRef.current !== queryKey) return;
      setState((current) => mergeLumaMultiEventGuests(current, data, { append }));
      setMultiEventGuestState({ key: queryKey, loading: false, pageInfo: data.pageInfo || null });
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") return;
      if (multiEventGuestRequestKeyRef.current !== queryKey) return;
      setState((current) => ({
        ...current,
        events: current.events.map((event) => eventIds.includes(event.id)
          ? { ...event, guestQueryLoading: false }
          : event),
      }));
      setMultiEventGuestState((current) => current.key === queryKey ? { ...current, loading: false } : current);
      setApiState({ status: "error", message: error.message });
    } finally {
      if (multiEventGuestAbortRef.current === controller) multiEventGuestAbortRef.current = null;
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
    setAllMatchingGuestsSelected(false);
    lastSelectedGuestIdRef.current = "";
  }, [selectedEventIdsKey, state.filters.guestStatus, debouncedGuestSearch, guestTagFilterKey, state.filters.guestHasNotes, state.filters.guestAttendedGreaterThan]);

  // EVENT_SWITCH_DIAGNOSTICS: records the first React commit containing the newly selected event shell.
  useLayoutEffect(() => {
    if (selectedEvent?.id) markEventSwitchDiagnostic(selectedEvent.id, "event_shell_committed");
  }, [selectedEvent?.id]);

  useEffect(() => {
    if (sessionStatus !== "ready" || activeEventTab !== "overview") return;
    if (multiEventMode) {
      void loadMultiEventGuests({
        status: state.filters.guestStatus,
        search: debouncedGuestSearch,
        tags: state.filters.guestTags,
      });
      return () => multiEventGuestAbortRef.current?.abort();
    }
    selectedEvents.filter((event) => event.source === "luma").forEach((event) => {
      void loadEventGuests(event.id, {
        status: state.filters.guestStatus,
        search: debouncedGuestSearch,
        tags: state.filters.guestTags,
        priority: !event.guestsLoaded,
      });
    });
  }, [sessionStatus, selectedEventIdsKey, activeEventTab, state.filters.guestStatus, debouncedGuestSearch, guestTagFilterKey, state.filters.guestHasNotes, state.filters.guestAttendedGreaterThan, guestDateSortDirection]);

  useEffect(() => {
    if (sessionStatus !== "ready" || activeEventTab !== "overview") return;
    selectedEvents.forEach((event) => {
      if (event.source !== "luma" || !event.guestsLoaded || event.guestQueryLoading || event.guestHistoryLoaded !== false || event.guestHistoryLoading) return;
      const personIds = event.guests.filter((guest) => !guest.eventCounts).map((guest) => guest.personId).slice(0, GUEST_PAGE_SIZE);
      if (personIds.length) void loadEventGuestHistory(event.id, personIds);
    });
  }, [sessionStatus, selectedEventIdsKey, selectedEvents.map((event) => `${event.guestsLoaded}:${event.guestQueryLoading}:${event.guestHistoryLoaded}:${event.guestHistoryLoading}`).join("|"), activeEventTab]);

  useEffect(() => {
    if (sessionStatus !== "ready") return;
    const pending = selectedEvents.filter((event) => event.source === "luma" && !eventAnalyticsReady(event) && !event.analyticsLoading);
    if (!pending.length) return;
    if (["analytics", "invite"].includes(activeEventTab)) {
      pending.forEach((event) => void loadEventAnalytics(event.id));
      return;
    }
    if (activeEventTab !== "overview" || pending.some((event) => !event.guestsLoaded || event.guestQueryLoading || event.guestHistoryLoading || event.guestHistoryLoaded === false)) return;
    const timer = window.setTimeout(() => pending.forEach((event) => void loadEventAnalytics(event.id)), 120);
    return () => window.clearTimeout(timer);
  }, [sessionStatus, selectedEventIdsKey, selectedEvents.map((event) => `${event.analyticsLoaded}:${event.analyticsLoading}:${event.guestsLoaded}:${event.guestQueryLoading}:${event.guestHistoryLoaded}:${event.guestHistoryLoading}`).join("|"), activeEventTab]);

  useEffect(() => {
    if (sessionStatus !== "ready") return;
    const hasActiveGuestQuery = state.filters.guestStatus !== "all"
      || Boolean(debouncedGuestSearch.trim())
      || state.filters.guestTags.length > 0
      || state.filters.guestHasNotes
      || state.filters.guestAttendedGreaterThan !== "";
    if (hasActiveGuestQuery) return;
    const warming = selectedEvents.filter((event) => event.source === "luma" && event.analyticsLoaded && !event.guestSnapshotReady && !event.guestSnapshotWarming);
    if (!warming.length) return;
    const timer = window.setTimeout(() => {
      warming.forEach((event) => void loadEventGuests(event.id, {
          status: state.filters.guestStatus,
          search: debouncedGuestSearch,
          tags: state.filters.guestTags,
          background: true,
        }));
    }, 220);
    return () => window.clearTimeout(timer);
  }, [sessionStatus, selectedEventIdsKey, selectedEvents.map((event) => `${event.analyticsLoaded}:${event.guestSnapshotReady}:${event.guestSnapshotWarming}`).join("|"), state.filters.guestStatus, debouncedGuestSearch, guestTagFilterKey, state.filters.guestHasNotes, state.filters.guestAttendedGreaterThan]);

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
    if (multiEventMode) {
      if (!activeMultiEventGuestPageInfo?.hasMore || multiEventGuestState.loading) return;
      void loadMultiEventGuests({
        append: true,
        status: state.filters.guestStatus,
        search: debouncedGuestSearch,
        tags: state.filters.guestTags,
        cursor: activeMultiEventGuestPageInfo.nextCursor,
      });
      return;
    }
    selectedEvents.forEach((event) => {
      if (event.source !== "luma" || loadingGuestEvents.includes(event.id) || !event.guestPageInfo?.hasMore) return;
      void loadEventGuests(event.id, {
        append: true,
        status: state.filters.guestStatus,
        search: debouncedGuestSearch,
        tags: state.filters.guestTags,
        cursor: event.guestPageInfo.nextCursor,
      });
    });
  };

  useEffect(() => {
    if (
      guestPageTarget <= loadedGuestPage ||
      sessionStatus !== "ready" ||
      activeEventTab !== "overview" ||
      !selectedEvents.some((event) => event.source === "luma" && event.guestsLoaded) ||
      selectedEvents.some((event) => event.guestQueryLoading) ||
      selectedEventLoadingGuests ||
      !workspaceGuestHasMore
    ) return;
    loadMoreGuests();
  }, [
    guestPageTarget,
    loadedGuestPage,
    sessionStatus,
    activeEventTab,
    selectedEventIdsKey,
    selectedEvents.map((event) => `${event.guestsLoaded}:${event.guestQueryLoading}:${event.guestPageInfo?.hasMore}`).join("|"),
    selectedEventLoadingGuests,
    workspaceGuestHasMore,
  ]);

  const handleGuestListScroll = (event) => {
    const target = event.currentTarget;
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 180) loadMoreGuests();
  };

  const selectGuestFilter = (filter) => {
    setFilter("guestStatus", state.filters.guestStatus === filter ? "all" : filter);
    setActiveEventTab("overview");
  };

  const openAnalyticsGuestFilter = (filter) => {
    setGuestPageTarget(1);
    setDebouncedGuestSearch("");
    setAllMatchingGuestsSelected(false);
    setSelectedGuestIds(new Set());
    lastSelectedGuestIdRef.current = "";
    updateState((draft) => {
      draft.filters.guestStatus = filter;
      draft.filters.guestSearch = "";
      draft.filters.guestTags = [];
    });
    setActiveEventTab("overview");
  };

  const toggleGuestSelection = (personId, selected, range = false) => {
    const orderedIds = visibleGuests.map(({ person }) => person.id);
    if (allMatchingGuestsSelected) {
      setAllMatchingGuestsSelected(false);
      setSelectedGuestIds(new Set(orderedIds.filter((id) => id !== personId)));
      lastSelectedGuestIdRef.current = personId;
      return;
    }
    setSelectedGuestIds((current) => updateGuestSelection(
      current,
      orderedIds,
      personId,
      selected,
      lastSelectedGuestIdRef.current,
      range,
    ));
    lastSelectedGuestIdRef.current = personId;
  };

  const toggleAllMatchingGuests = (selected) => {
    lastSelectedGuestIdRef.current = "";
    setAllMatchingGuestsSelected(selected);
    setSelectedGuestIds(new Set());
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

  const savePersonTags = async (personId, tags, { lockAlreadyHeld = false, eventId = "", tagId = "", removed = false } = {}) => {
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
        body: JSON.stringify({ personId, tagId, eventId, removed }),
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
      const mutatedDefinition = state.tagDefinitions.find((definition) => definition.id === tagId);
      if (mutatedDefinition?.semanticKey === "referral" || mutatedDefinition?.name?.toLocaleLowerCase() === REFERRED_PERSON_TAG.toLocaleLowerCase()) {
        void loadEventAnalytics(eventId);
        if (multiEventMode && multiEventStatsKey) {
          setMultiEventStatsByKey((current) => {
            const next = { ...current };
            delete next[multiEventStatsKey];
            return next;
          });
        }
      }
      void loadInviteMetadata("tags", { force: true }).catch(() => {});
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

  const createAndAssignTag = async (personId, name, personTags, eventId) => {
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
      return savePersonTags(personId, sortedTags(unique([...personTags, definition.name])), {
        lockAlreadyHeld: true,
        eventId,
        tagId: definition.id,
        removed: false,
      });
    } catch (error) {
      setApiState({ status: "error", message: error.message });
      setSavingTagPersonId("");
      return false;
    }
  };

  const openTagSettings = async () => {
    setTagSettingsOpen(true);
    try {
      const response = await apiFetch("/api/supertags", { cache: "no-store" });
      const data: any = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to load supertags.");
      setSuperTags(Array.isArray(data.superTags) ? data.superTags : []);
    } catch (error) {
      setApiState({ status: "error", message: error.message });
    }
  };

  const saveTagSettings = async (drafts, superTagDrafts) => {
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
      const superTagResponse = await apiFetch("/api/supertags", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ superTags: superTagDrafts }),
      });
      const superTagData: any = await superTagResponse.json();
      if (!superTagResponse.ok) throw new Error(superTagData.error || "Unable to update supertags.");
      setSuperTags(Array.isArray(superTagData.superTags) ? superTagData.superTags : []);
      setState((current) => normalizeState(applyTagDefinitionUpdates(current, saved)));
      void loadInviteMetadata("tags", { force: true }).catch(() => {});
      setTagSettingsOpen(false);
      setApiState({ status: "live", message: "Saved tag and supertag settings." });
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

  useEffect(() => {
    const eventId = selectedProfileRecord?.event.id;
    const guest = selectedProfileRecord?.guest;
    const personId = selectedPerson?.id;
    const lumaUserId = guest?.lumaUserId || selectedPerson?.lumaUserId;
    if (!profilePanelOpen || !eventId || !guest || !personId || !lumaUserId || hasPrivateReferrerDetails(guest.referrer)) return;
    const token = window.localStorage.getItem(LUMA_SESSION_TOKEN_STORAGE_KEY) || "";
    if (!token) return;
    const requestKey = `${eventId}:${personId}`;
    if (referrerRequestsRef.current.has(requestKey)) return;
    referrerRequestsRef.current.add(requestKey);

    void postLumaAction({
      action: "getGuestReferrer",
      eventId,
      personId,
      lumaUserId,
      lumaSessionToken: normalizeLumaSessionTokenInput(token),
    }, apiFetch)
      .then((result) => {
        if (!result.referrer) return;
        setState((current) => ({
          ...current,
          events: current.events.map((event) => event.id !== eventId ? event : {
            ...event,
            guests: event.guests.map((item) => item.personId === personId ? { ...item, referrer: result.referrer } : item),
          }),
        }));
      })
      .catch((error) => {
        if (error.code !== "LUMA_SESSION_INVALID") return;
        window.localStorage.removeItem(LUMA_SESSION_TOKEN_STORAGE_KEY);
        referrerRequestsRef.current.delete(requestKey);
      });
  }, [profilePanelOpen, selectedProfileRecord?.event.id, selectedProfileRecord?.guest.personId, selectedProfileRecord?.guest.lumaUserId, selectedProfileRecord?.guest.referrer, selectedPerson?.id, selectedPerson?.lumaUserId]);

  const setGuestStatus = async (personId: string, status: string, { sendEmail = false, message = "", eventId = state.selectedEventId, lumaSessionToken = "" }: { sendEmail?: boolean; message?: string; eventId?: string; lumaSessionToken?: string } = {}) => {
    const event = getEvent(state, eventId);
    const guest = event?.guests.find((item) => item.personId === personId);
    const person = getPerson(state, personId);
    if (!event || !guest) return false;
    const isReferredPerson = personHasExactTag(person, REFERRED_PERSON_TAG);

    const writesLumaStatus = ["going", "registered", "declined", "waitlisted"].includes(status);
    const undoingCheckIn = guest.status === "checked_in" && status === "going";
    const writesLumaCheckIn = status === "checked_in" || undoingCheckIn;
    const writesLumaInvite = status === "invited";
    if (event.source === "luma" && guest.lumaGuestId && !writesLumaStatus && !writesLumaCheckIn && !writesLumaInvite) {
      setApiState({ status: "live", message: `${statusLabels[status]} was not changed because Luma public API does not expose that write.` });
      return false;
    }

    const optimisticGuestState = {
      ...guest,
      status,
      operatorDecision: status,
      invitedAt: status === "invited" ? guest.invitedAt || new Date().toISOString() : guest.invitedAt,
      checkedInAt: status === "checked_in" ? new Date().toISOString() : undoingCheckIn ? null : guest.checkedInAt,
      isReferred: isReferredPerson,
    };
    const toDecideDelta = Number(isGuestToDecide(optimisticGuestState)) - Number(isGuestToDecide(guest));
    const attendedDelta = Number(status === "checked_in")
      - Number(guest.status === "checked_in" || Boolean(guest.checkedInAt));
    const selectedStatsEvents = selectedWorkspaceEvents(state);
    const wasSelectedPersonToDecide = selectedStatsEvents.some((selectedStatsEvent) =>
      selectedStatsEvent.guests.some((candidate) => candidate.personId === personId && isGuestToDecide(candidate)),
    );
    const isSelectedPersonToDecide = selectedStatsEvents.some((selectedStatsEvent) =>
      selectedStatsEvent.guests.some((candidate) => candidate.personId === personId
        && isGuestToDecide(selectedStatsEvent.id === eventId ? optimisticGuestState : candidate)),
    );
    const selectedToDecideDelta = Number(isSelectedPersonToDecide) - Number(wasSelectedPersonToDecide);

    const previous = {
      status: guest.status,
      operatorDecision: guest.operatorDecision,
      updatedAt: guest.updatedAt,
      registeredAt: guest.registeredAt,
      approvedAt: guest.approvedAt,
      checkedInAt: guest.checkedInAt,
      invitedAt: guest.invitedAt,
      eventCounts: guest.eventCounts ? { ...guest.eventCounts } : guest.eventCounts,
      statusMutationId: guest._statusMutationId,
    };
    const mutationId = `status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    updateState((draft) => {
      const optimisticEvent = getEvent(draft, eventId);
      const optimisticGuest = optimisticEvent?.guests.find((item) => item.personId === personId);
      if (!optimisticGuest) return;
      const invitationOutcomeBefore = { ...optimisticGuest, isReferred: isReferredPerson };
      const changedAt = new Date().toISOString();
      const wasCheckedIn = optimisticGuest.status === "checked_in";
      optimisticGuest.status = status;
      optimisticGuest.operatorDecision = status;
      optimisticGuest.updatedAt = changedAt;
      optimisticGuest._statusMutationId = mutationId;
      if (status === "registered" && !optimisticGuest.registeredAt) optimisticGuest.registeredAt = changedAt;
      if (status === "going") {
        optimisticGuest.approvedAt = changedAt;
        if (wasCheckedIn) optimisticGuest.checkedInAt = null;
      }
      if (status === "checked_in") optimisticGuest.checkedInAt = changedAt;
      if (status === "invited") optimisticGuest.invitedAt = changedAt;
      if (attendedDelta && Number.isFinite(Number(optimisticGuest.eventCounts?.attended))) {
        optimisticGuest.eventCounts = {
          ...optimisticGuest.eventCounts,
          attended: Math.max(0, Number(optimisticGuest.eventCounts.attended) + attendedDelta),
        };
      }
      adjustGuestStatusStats(
        optimisticEvent?.guestStats,
        invitationOutcomeBefore,
        { ...optimisticGuest, isReferred: isReferredPerson },
      );
      draft.selectedPersonId = personId;
    });
    if (multiEventMode && uniqueWorkspaceStats) {
      setMultiEventStatsByKey((current) => ({
        ...current,
        [multiEventStatsKey]: updatedWorkspaceStats(
          current[multiEventStatsKey],
          guest,
          optimisticGuestState,
          selectedToDecideDelta,
        ),
      }));
    }

    if (event?.source === "luma" && guest?.lumaGuestId) {
      try {
        if (writesLumaCheckIn) {
          await postLumaAction({
            action: "updateGuestCheckIn",
            confirm: LIVE_WRITE_CONFIRMATION,
            eventId: event.id,
            guestId: guest.lumaGuestId,
            checkedIn: status === "checked_in",
            lumaSessionToken,
          }, apiFetch);
        } else if (writesLumaInvite) {
          await postLumaAction({
            action: "sendInvites",
            confirm: LIVE_WRITE_CONFIRMATION,
            eventId: event.id,
            guests: [{ email: person.email, name: person.name, source: person.source }],
          }, apiFetch);
        } else if (writesLumaStatus) {
          await postLumaAction({
            action: "updateGuestStatus",
            confirm: LIVE_WRITE_CONFIRMATION,
            eventId: event.id,
            guestId: guest.lumaGuestId,
            status,
            sendEmail,
            message,
          }, apiFetch);
        }
      } catch (error: any) {
        updateState((draft) => {
          const failedEvent = getEvent(draft, eventId);
          const failedGuest = failedEvent?.guests.find((item) => item.personId === personId);
          if (!failedGuest || failedGuest._statusMutationId !== mutationId) return;
          const invitationOutcomeBeforeRollback = { ...failedGuest, isReferred: isReferredPerson };
          failedGuest.status = previous.status;
          failedGuest.operatorDecision = previous.operatorDecision;
          failedGuest.updatedAt = previous.updatedAt;
          failedGuest.registeredAt = previous.registeredAt;
          failedGuest.approvedAt = previous.approvedAt;
          failedGuest.checkedInAt = previous.checkedInAt;
          failedGuest.invitedAt = previous.invitedAt;
          failedGuest.eventCounts = previous.eventCounts;
          failedGuest._statusMutationId = previous.statusMutationId;
          adjustGuestStatusStats(
            failedEvent?.guestStats,
            invitationOutcomeBeforeRollback,
            { ...failedGuest, isReferred: isReferredPerson },
          );
        });
        if (multiEventMode && uniqueWorkspaceStats) {
          setMultiEventStatsByKey((current) => ({
            ...current,
            [multiEventStatsKey]: updatedWorkspaceStats(
              current[multiEventStatsKey],
              optimisticGuestState,
              guest,
              -selectedToDecideDelta,
            ),
          }));
        }
        if (error.code === "LUMA_SESSION_INVALID") throw error;
        setApiState({ status: "error", message: error.message });
        return false;
      }
    }

    updateState((draft) => {
      const confirmedGuest = getEvent(draft, eventId)?.guests.find((item) => item.personId === personId);
      if (confirmedGuest?._statusMutationId === mutationId) delete confirmedGuest._statusMutationId;
    });
    return true;
  };

  const selectedBulkGuestStatusOperations = (allMatching = false) => selectedEvents
    .filter((event) => event.source === "luma")
    .map((event) => ({
      event,
      guests: allMatching ? [] : selectedGuestRows.flatMap((row) => (row.eventMatches || [{ event: row.sourceEvent, guest: row.guest }])
        .filter((match) => match.event?.id === event.id && match.guest?.lumaGuestId)
        .map((match) => ({ ...match.guest, personId: row.person.id }))),
    }))
    .filter((operation) => allMatching || operation.guests.length);

  const currentAllMatchingGuestSelection = () => ({
    eventIds: selectedEvents.filter((event) => event.source === "luma").map((event) => event.id),
    guestStatus: state.filters.guestStatus,
    guestSearch: debouncedGuestSearch,
    guestTags: [...state.filters.guestTags],
    guestHasNotes: state.filters.guestHasNotes,
    guestAttendedGreaterThan: state.filters.guestAttendedGreaterThan === ""
      ? null
      : Number(state.filters.guestAttendedGreaterThan),
  });

  const requestBulkGuestStatus = (status: string, label: string) => {
    if (bulkSubmitting) return;
    const allMatching = allMatchingGuestsSelected;
    const operations = selectedBulkGuestStatusOperations(allMatching);
    const updateCount = allMatching
      ? bulkSelectionCount
      : operations.reduce((total, operation) => total + operation.guests.length, 0);
    if (!updateCount) return;
    setGuestStatusDraft({
      kind: "bulk",
      status,
      label,
      eventId: operations[0].event.id,
      count: updateCount,
      eventCount: operations.length,
      allMatching,
      selection: allMatching ? currentAllMatchingGuestSelection() : null,
      sendEmail: true,
      message: "",
      submitting: false,
    });
  };

  const runBulkGuestStatus = async (
    status: string,
    label: string,
    { sendEmail = false, message = "", allMatching = false, selection = null }: { sendEmail?: boolean; message?: string; allMatching?: boolean; selection?: any } = {},
  ) => {
    const operations = selectedBulkGuestStatusOperations(allMatching);
    if (!operations.length || bulkSubmitting) return false;

    const changedAt = new Date().toISOString();
    const mutationId = `bulk-status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimisticTargets = allMatching ? [] : operations.flatMap(({ event, guests }) => guests.map((guest) => ({
      eventId: event.id,
      personId: guest.personId,
      lumaGuestId: guest.lumaGuestId,
      previous: {
        ...guest,
        eventCounts: guest.eventCounts ? { ...guest.eventCounts } : guest.eventCounts,
      },
    })));
    const targetByGuest = new Map(optimisticTargets.map((target) => [`${target.eventId}:${target.lumaGuestId}`, target]));
    if (optimisticTargets.length) {
      updateState((draft) => {
        optimisticTargets.forEach((target) => {
          const optimisticEvent = getEvent(draft, target.eventId);
          const optimisticGuest = optimisticEvent?.guests.find((guest) => guest.lumaGuestId === target.lumaGuestId);
          if (!optimisticEvent || !optimisticGuest) return;
          const person = getPerson(draft, optimisticGuest.personId);
          const before = { ...optimisticGuest, isReferred: personHasExactTag(person, REFERRED_PERSON_TAG) };
          Object.assign(optimisticGuest, guestAfterStatusChange(optimisticGuest, status, changedAt), {
            _bulkStatusMutationId: mutationId,
          });
          adjustGuestStatusStats(
            optimisticEvent.guestStats,
            before,
            { ...optimisticGuest, isReferred: before.isReferred },
          );
        });
      });
      invalidateMultiEventStats();
    }

    setBulkSubmitting(true);
    const results = [];
    try {
      for (const operation of operations) {
        const data = await postBulkLumaAction({
          action: "bulkUpdateGuestStatus",
          confirm: LIVE_WRITE_CONFIRMATION,
          eventId: operation.event.id,
          status,
          ...(allMatching ? {
            allMatching: true,
            guestStatus: selection?.guestStatus,
            guestSearch: selection?.guestSearch,
            guestTags: selection?.guestTags,
            guestHasNotes: selection?.guestHasNotes,
            guestAttendedGreaterThan: selection?.guestAttendedGreaterThan,
          } : {
            guests: operation.guests.map((guest) => ({ lumaGuestId: guest.lumaGuestId })),
          }),
          sendEmail,
          message: sendEmail ? message : "",
        }, apiFetch);
        results.push({ ...operation, data });
      }

      updateState((draft) => {
        results.forEach(({ event, data }) => {
          const updatedGuestIds = new Set<string>(data.updatedGuestIds || []);
          const failedGuestIds = new Set<string>((data.failures || []).map((failure) => failure.guestId));
          const updatedEvent = getEvent(draft, event.id);
          if (!updatedEvent) return;
          updatedEvent.guests.forEach((guest) => {
            const target = targetByGuest.get(`${event.id}:${guest.lumaGuestId}`);
            if (target && guest._bulkStatusMutationId === mutationId) {
              if (failedGuestIds.has(guest.lumaGuestId)) {
                const person = getPerson(draft, guest.personId);
                const beforeRollback = { ...guest, isReferred: personHasExactTag(person, REFERRED_PERSON_TAG) };
                adjustGuestStatusStats(
                  updatedEvent.guestStats,
                  beforeRollback,
                  { ...target.previous, isReferred: beforeRollback.isReferred },
                );
                Object.assign(guest, target.previous);
              } else if (updatedGuestIds.has(guest.lumaGuestId)) {
                delete guest._bulkStatusMutationId;
              }
              return;
            }
            if (!allMatching || !updatedGuestIds.has(guest.lumaGuestId)) return;
            const person = getPerson(draft, guest.personId);
            const before = { ...guest, isReferred: personHasExactTag(person, REFERRED_PERSON_TAG) };
            Object.assign(guest, guestAfterStatusChange(guest, status, changedAt));
            adjustGuestStatusStats(updatedEvent.guestStats, before, { ...guest, isReferred: before.isReferred });
          });
        });
      });
      invalidateMultiEventStats();
      const failedPeople = results.flatMap(({ event, guests, data }) => {
        const failedGuestIds = new Set((data.failures || []).map((failure) => failure.guestId));
        if (allMatching) {
          return event.guests
            .filter((guest) => failedGuestIds.has(guest.lumaGuestId))
            .map((guest) => guest.personId);
        }
        return guests.filter((guest) => failedGuestIds.has(guest.lumaGuestId)).map((guest) => guest.personId);
      });
      lastSelectedGuestIdRef.current = "";
      setAllMatchingGuestsSelected(false);
      setSelectedGuestIds(new Set(failedPeople));
      if (allMatching) {
        await Promise.all(operations.map(({ event }) => loadEventGuests(event.id, {
            status: state.filters.guestStatus,
            search: debouncedGuestSearch,
          })));
      }

      const notificationText = sendEmail ? " with a message" : "";
      const updated = results.reduce((total, result) => total + (result.data.updated || 0), 0);
      const failed = results.reduce((total, result) => total + (result.data.failed || 0), 0);
      if (failed) {
        setApiState({ status: "error", message: `${label} updated ${updated} registrations${notificationText}; ${failed} failed.` });
      } else {
        setApiState({ status: "live", message: `${label} updated ${updated} registrations across ${operations.length} event${operations.length === 1 ? "" : "s"}${notificationText}.` });
      }
      return true;
    } catch (error) {
      if (optimisticTargets.length) {
        const completedGuestKeys = new Set(results.flatMap(({ event, data }) =>
          (data.updatedGuestIds || []).map((guestId) => `${event.id}:${guestId}`),
        ));
        updateState((draft) => {
          optimisticTargets.forEach((target) => {
            const failedEvent = getEvent(draft, target.eventId);
            const failedGuest = failedEvent?.guests.find((guest) => guest.lumaGuestId === target.lumaGuestId);
            if (!failedEvent || !failedGuest || failedGuest._bulkStatusMutationId !== mutationId) return;
            if (completedGuestKeys.has(`${target.eventId}:${target.lumaGuestId}`)) {
              delete failedGuest._bulkStatusMutationId;
              return;
            }
            const person = getPerson(draft, failedGuest.personId);
            const beforeRollback = { ...failedGuest, isReferred: personHasExactTag(person, REFERRED_PERSON_TAG) };
            adjustGuestStatusStats(
              failedEvent.guestStats,
              beforeRollback,
              { ...target.previous, isReferred: beforeRollback.isReferred },
            );
            Object.assign(failedGuest, target.previous);
          });
        });
        invalidateMultiEventStats();
      }
      setApiState({ status: "error", message: error.message });
      return false;
    } finally {
      setBulkSubmitting(false);
    }
  };

  const applyBulkTagMutation = async (
    tagIds: string[],
    removed: boolean,
    { allMatching = false, selection = null }: { allMatching?: boolean; selection?: any } = {},
  ) => {
    if (!tagIds.length || (!allMatching && !selectedGuestRows.length) || bulkSubmitting) return false;
    const people = allMatching ? [] : selectedGuestRows.flatMap((row) => {
      const eventId = row.sourceEvent?.id || selectedEvent?.id || "";
      return eventId ? [{ personId: row.person.id, eventId }] : [];
    });
    if (!allMatching && people.length !== selectedGuestRows.length) {
      setApiState({ status: "error", message: "One or more selected guests are not linked to an event." });
      return false;
    }

    setBulkSubmitting(true);
    try {
      const response = await apiFetch("/api/tags", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(allMatching ? {
          bulk: true,
          allMatching: true,
          eventIds: selection?.eventIds,
          guestStatus: selection?.guestStatus,
          guestSearch: selection?.guestSearch,
          guestTags: selection?.guestTags,
          tagIds,
          removed,
        } : { bulk: true, people, tagIds, removed }),
      });
      const data: any = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to update guest tags.");

      const updatedPeople = new Map((Array.isArray(data.people) ? data.people : []).map((person) => [person.personId, person]));
      setState((current) => normalizeState({
        ...current,
        people: current.people.map((person) => {
          const updated: any = updatedPeople.get(person.id);
          return updated ? {
            ...person,
            tags: Array.isArray(updated.tags) ? updated.tags : person.tags,
            manualTags: Array.isArray(updated.manualTags) ? updated.manualTags : person.manualTags,
            automaticTags: Array.isArray(updated.automaticTags) ? updated.automaticTags : person.automaticTags,
          } : person;
        }),
      }));

      const includesReferralTag = tagIds.some((tagId) => {
        const definition = state.tagDefinitions.find((tag) => tag.id === tagId);
        return definition?.semanticKey === "referral" || definition?.name?.toLocaleLowerCase() === REFERRED_PERSON_TAG.toLocaleLowerCase();
      });
      if (includesReferralTag) {
        selectedEvents.forEach((event) => void loadEventAnalytics(event.id));
        invalidateMultiEventStats();
      }
      void loadInviteMetadata("tags", { force: true }).catch(() => {});

      lastSelectedGuestIdRef.current = "";
      setAllMatchingGuestsSelected(false);
      setSelectedGuestIds(new Set());
      if (state.filters.guestTags.length) {
        if (multiEventMode) {
          await loadMultiEventGuests({
            status: state.filters.guestStatus,
            search: debouncedGuestSearch,
            tags: state.filters.guestTags,
          });
        } else {
          await Promise.all(selectedEvents
            .filter((event) => event.source === "luma")
            .map((event) => loadEventGuests(event.id, {
              status: state.filters.guestStatus,
              search: debouncedGuestSearch,
              tags: state.filters.guestTags,
            })));
        }
      }

      const action = removed ? "Removed" : "Added";
      const tagCount = tagIds.length;
      const targetCount = Number(data.matchedPeople) || people.length;
      setApiState({
        status: "live",
        message: `${action} ${tagCount} tag${tagCount === 1 ? "" : "s"} ${removed ? "from" : "to"} ${targetCount} guest${targetCount === 1 ? "" : "s"}.`,
      });
      return true;
    } catch (error) {
      setApiState({ status: "error", message: error.message });
      return false;
    } finally {
      setBulkSubmitting(false);
    }
  };

  const runBulkTagMutation = async (tagIds: string[], removed: boolean) => {
    if (!allMatchingGuestsSelected) return applyBulkTagMutation(tagIds, removed);
    setBulkTagConfirmation({
      tagIds,
      removed,
      count: bulkSelectionCount,
      eventCount: selectedEvents.filter((event) => event.source === "luma").length,
      selection: currentAllMatchingGuestSelection(),
      submitting: false,
    });
    return true;
  };

  const closeBulkTagConfirmation = () => {
    setBulkTagConfirmation((current) => current?.submitting ? current : null);
  };

  const submitBulkTagConfirmation = async (event) => {
    event.preventDefault();
    if (!bulkTagConfirmation || bulkTagConfirmation.submitting) return;
    const draft = bulkTagConfirmation;
    setBulkTagConfirmation((current) => current ? { ...current, submitting: true } : current);
    const updated = await applyBulkTagMutation(draft.tagIds, draft.removed, {
      allMatching: true,
      selection: draft.selection,
    });
    setBulkTagConfirmation((current) => updated ? null : current ? { ...current, submitting: false } : current);
  };

  const requestGuestStatusChange = (personId, status, label, eventId = state.selectedEventId) => {
    const event = getEvent(state, eventId);
    if (event?.source === "luma" && label === "Reinvite") {
      const pending = { kind: "reinvite", personId, status, label, eventId };
      const storedToken = window.localStorage.getItem(LUMA_SESSION_TOKEN_STORAGE_KEY) || "";
      if (!storedToken) {
        setLumaSessionPrompt({ pending, token: "", error: "", submitting: false });
        return;
      }
      void reinviteGuest(personId, eventId, storedToken, pending);
      return;
    }
    if (event?.source === "luma" && ["Check in", "Undo"].includes(label)) {
      const pending = { kind: "check_in", personId, status, label, eventId };
      const storedToken = window.localStorage.getItem(LUMA_SESSION_TOKEN_STORAGE_KEY) || "";
      if (!storedToken) {
        setLumaSessionPrompt({ pending, token: "", error: "", submitting: false });
        return;
      }
      void performLumaCheckInChange(pending, storedToken);
      return;
    }
    if (event?.source !== "luma" || !["Approve", "Waitlist", "Decline"].includes(label)) {
      void setGuestStatus(personId, status, { eventId });
      return;
    }

    setGuestStatusDraft({
      personId,
      status,
      label,
      eventId,
      sendEmail: true,
      message: "",
      submitting: false,
    });
  };

  const reinviteGuest = async (personId, eventId, token, pending = { kind: "reinvite", personId, eventId }) => {
    const event = getEvent(state, eventId);
    const guest = event?.guests.find((item) => item.personId === personId);
    const person = getPerson(state, personId);
    if (!event || !guest || !person?.email || guest.source === "local") return false;
    const guestKey = `${eventId}:${personId}`;
    if (reinvitingGuestKey === guestKey) return false;

    const previous = {
      status: guest.status,
      operatorDecision: guest.operatorDecision,
      invitedAt: guest.invitedAt,
      updatedAt: guest.updatedAt,
      reinvitePending: guest.reinvitePending,
    };
    setReinvitingGuestKey(guestKey);
    updateState((draft) => {
      const optimisticGuest = getEvent(draft, eventId)?.guests.find((item) => item.personId === personId);
      if (!optimisticGuest) return;
      optimisticGuest.reinvitePending = true;
    });

    try {
      const result = await postLumaAction({
        action: "reinviteGuest",
        confirm: LIVE_WRITE_CONFIRMATION,
        eventId,
        guestId: guest.lumaGuestId,
        lumaUserId: guest.lumaUserId || person.lumaUserId || person.id,
        email: person.email,
        name: person.name,
        lumaSessionToken: normalizeLumaSessionTokenInput(token),
      }, apiFetch);
      const actualStatus = result.emailConfirmed ? "invited" : previous.status;
      updateState((draft) => {
        const reconciledGuest = getEvent(draft, eventId)?.guests.find((item) => item.personId === personId);
        if (!reconciledGuest) return;
        reconciledGuest.status = actualStatus;
        reconciledGuest.operatorDecision = previous.operatorDecision;
        reconciledGuest.invitedAt = result.emailConfirmed ? result.emailSentAt || new Date().toISOString() : previous.invitedAt;
        reconciledGuest.updatedAt = new Date().toISOString();
        reconciledGuest.reinvitePending = false;
      });
      invalidateMultiEventStats();
      setApiState({
        status: "live",
        message: `Reinvite email sent to ${person.name}.`,
      });
      return true;
    } catch (error: any) {
      updateState((draft) => {
        const failedGuest = getEvent(draft, eventId)?.guests.find((item) => item.personId === personId);
        if (!failedGuest) return;
        failedGuest.status = previous.status;
        failedGuest.operatorDecision = previous.operatorDecision;
        failedGuest.invitedAt = previous.invitedAt;
        failedGuest.updatedAt = previous.updatedAt;
        failedGuest.reinvitePending = previous.reinvitePending;
      });
      invalidateMultiEventStats();
      if (error.code === "LUMA_SESSION_INVALID") {
        window.localStorage.removeItem(LUMA_SESSION_TOKEN_STORAGE_KEY);
        setLumaSessionPrompt({ pending, token: "", error: error.message, submitting: false });
        return false;
      }
      setApiState({ status: "error", message: `Couldn’t reinvite ${person.name}: ${error.message}` });
      return false;
    } finally {
      setReinvitingGuestKey("");
    }
  };

  const performLumaCheckInChange = async (pending, token) => {
    const guestKey = `${pending.eventId}:${pending.personId}`;
    if (lumaCheckInGuestKey === guestKey) return false;
    setLumaCheckInGuestKey(guestKey);
    try {
      const updated = await setGuestStatus(pending.personId, pending.status, {
        eventId: pending.eventId,
        lumaSessionToken: normalizeLumaSessionTokenInput(token),
      });
      if (!updated) return false;
      setApiState({
        status: "live",
        message: pending.status === "checked_in" ? "Checked in on Luma." : "Removed Luma check-in.",
      });
      return true;
    } catch (error: any) {
      if (error.code === "LUMA_SESSION_INVALID") {
        window.localStorage.removeItem(LUMA_SESSION_TOKEN_STORAGE_KEY);
        setLumaSessionPrompt({ pending, token: "", error: error.message, submitting: false });
        return false;
      }
      setApiState({ status: "error", message: error.message });
      return false;
    } finally {
      setLumaCheckInGuestKey("");
    }
  };

  const submitLumaSessionToken = async (event) => {
    event.preventDefault();
    if (!lumaSessionPrompt || lumaSessionPrompt.submitting) return;
    const token = normalizeLumaSessionTokenInput(lumaSessionPrompt.token);
    if (!token) {
      setLumaSessionPrompt((current) => current ? { ...current, error: "Paste a Luma session token." } : current);
      return;
    }
    const pending = lumaSessionPrompt.pending;
    window.localStorage.setItem(LUMA_SESSION_TOKEN_STORAGE_KEY, token);
    setLumaSessionPrompt((current) => current ? { ...current, token, error: "", submitting: true } : current);
    const updated = pending.kind === "sync_referrers"
      ? await performSelectedEventSync(pending.eventIds, token)
      : pending.kind === "reinvite"
        ? await reinviteGuest(pending.personId, pending.eventId, token, pending)
        : await performLumaCheckInChange(pending, token);
    if (updated) setLumaSessionPrompt(null);
    else setLumaSessionPrompt((current) => current ? { ...current, submitting: false } : current);
  };

  const syncWithoutReferrers = () => {
    const pending = lumaSessionPrompt?.pending;
    if (pending?.kind !== "sync_referrers" || lumaSessionPrompt.submitting) return;
    setLumaSessionPrompt(null);
    void performSelectedEventSync(pending.eventIds);
  };

  const closeGuestStatusDialog = () => {
    setGuestStatusDraft((current) => current?.submitting ? current : null);
  };

  const submitGuestStatusChange = async (event) => {
    event.preventDefault();
    if (!guestStatusDraft || guestStatusDraft.submitting) return;

    const draft = guestStatusDraft;
    setGuestStatusDraft((current) => current ? { ...current, submitting: true } : current);
    if (draft.kind === "bulk") {
      const updated = await runBulkGuestStatus(draft.status, draft.label, {
        sendEmail: draft.sendEmail,
        message: draft.sendEmail ? draft.message : "",
        allMatching: draft.allMatching,
        selection: draft.selection,
      });
      setGuestStatusDraft((current) => updated ? null : current ? { ...current, submitting: false } : current);
      return;
    }
    const updated = await setGuestStatus(draft.personId, draft.status, {
      sendEmail: draft.sendEmail,
      message: draft.sendEmail ? draft.message : "",
      eventId: draft.eventId,
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
        draft.selectedEventIds = [id];
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

  const sendInviteRecipients = async (people, { confirm = true, message = inviteMessage.trim() } = {}) => {
    const targets = selectedWorkspaceEvents(state);
    if (!targets.length) return false;
    const uniquePeople: any[] = [...new Map<string, any>(people.filter(Boolean).map((person) => [person.email?.toLocaleLowerCase() || person.id, person])).values()];
    const guests = uniquePeople.map((person) => ({ email: person.email, name: person.name, source: person.source })).filter((guest) => guest.email);
    const lumaGuests = guests.filter((guest) => guest.source === "luma");
    if (!guests.length || (targets.every((target) => target.source === "luma") && !lumaGuests.length)) {
      setApiState({ status: "error", message: "Add at least one recipient before sending invitations." });
      return false;
    }
    const deliveryCount = targets.reduce((total, target) => total + (target.source === "luma" ? lumaGuests.length : guests.length), 0);
    const targetLabel = targets.length === 1 ? targets[0].title : `${targets.length} selected events`;
    if (confirm && !window.confirm(`Send ${deliveryCount} invitation${deliveryCount === 1 ? "" : "s"} to ${guests.length} people across ${targetLabel}?`)) return false;

    for (const target of targets.filter((event) => event.source === "luma")) {
      try {
        for (let index = 0; index < lumaGuests.length; index += 50) {
          await postLumaAction({
            action: "sendInvites",
            confirm: LIVE_WRITE_CONFIRMATION,
            eventId: target.id,
            guests: lumaGuests.slice(index, index + 50),
            message,
          }, apiFetch);
        }
      } catch (error) {
        setApiState({ status: "error", message: `Stopped after an invite failed for ${target.title}: ${error.message}` });
        return false;
      }
    }

    updateState((draft) => {
      targets.forEach((target) => {
        const nextTarget = getEvent(draft, target.id);
        if (!nextTarget) return;
        const existing = new Set(nextTarget.guests.map((guest) => guest.personId));
        const queuedEmails = new Set((target.source === "luma" ? lumaGuests : guests).map((guest) => guest.email));
        uniquePeople.forEach((person) => {
          if (!queuedEmails.has(person.email) || existing.has(person.id)) return;
          nextTarget.guests.push({ personId: person.id, status: "invited", invitedAt: new Date().toISOString() });
        });
      });
    });
    invalidateMultiEventStats();
    setApiState({ status: "live", message: `Sent ${deliveryCount} invitations across ${targetLabel}.` });
    return true;
  };

  const sendInviteAudience = async (criteria, { message = inviteMessage.trim(), recipientCount = 0 } = {}) => {
    const targets = selectedWorkspaceEvents(state);
    const lumaTargets = targets.filter((event) => event.source === "luma");
    if (!lumaTargets.length) {
      setApiState({ status: "error", message: "Select at least one Luma event before sending invitations." });
      return false;
    }
    if (!recipientCount) {
      setApiState({ status: "error", message: "Add at least one recipient before sending invitations." });
      return false;
    }
    const deliveryCount = recipientCount * lumaTargets.length;
    const targetLabel = lumaTargets.length === 1 ? lumaTargets[0].title : `${lumaTargets.length} selected events`;
    try {
      const result = await postLumaAction({
        action: "sendAudienceInvites",
        confirm: LIVE_WRITE_CONFIRMATION,
        eventIds: lumaTargets.map((event) => event.id),
        criteria,
        message,
      }, apiFetch);
      invalidateMultiEventStats();
      let refreshedEventCount = 0;
      for (const event of lumaTargets) {
        const refreshed = await loadEventGuests(event.id, { force: true });
        if (refreshed) refreshedEventCount += 1;
      }
      await loadInviteMetadata("events", { force: true }).catch(() => {});
      const refreshComplete = refreshedEventCount === lumaTargets.length;
      setApiState({
        status: refreshComplete ? "live" : "error",
        message: refreshComplete
          ? `Sent ${Number(result.invited || deliveryCount).toLocaleString()} invitations across ${targetLabel} and refreshed the event guest data.`
          : `Sent ${Number(result.invited || deliveryCount).toLocaleString()} invitations across ${targetLabel}, but only refreshed ${refreshedEventCount} of ${lumaTargets.length} events.`,
      });
      return true;
    } catch (error) {
      setApiState({ status: "error", message: error.message || "Unable to send the selected audience." });
      return false;
    }
  };

  const mergeIndexedPeople = (entries) => {
    const incomingPeople = entries.map((entry) => {
      const person = entry?.person || entry;
      return person ? { ...person, eventCounts: entry?.eventCounts || person.eventCounts || null } : null;
    }).filter(Boolean);
    if (!incomingPeople.length) return;
    setState((current) => {
      const peopleById = new Map(current.people.map((person) => [person.id, person]));
      incomingPeople.forEach((person) => peopleById.set(person.id, mergePersonRecord(peopleById.get(person.id), person)));
      return { ...current, people: [...peopleById.values()] };
    });
  };

  const applyInviteTemplate = (templateId) => {
    setInviteTemplateId(templateId);
    const template = inviteMessageTemplates.find((item) => item.id === templateId);
    if (!template) return;
    const templateTarget = selectedEvents.length > 1 ? { title: `${selectedEvents.length} upcoming events` } : inviteTargetEvent;
    setInviteMessage(template.message(templateTarget).slice(0, MAX_INVITE_MESSAGE_LENGTH));
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
        draft.selectedEventIds = [result.id];
        draft.invite.targetEventId = result.id;
        draft.filters.event = "all";
      }
      if (result.type === "person") {
        if (result.person) {
          const existingPerson = draft.people.find((person) => person.id === result.person.id || (person.email && person.email.toLocaleLowerCase() === result.person.email?.toLocaleLowerCase()));
          const mergedPerson = mergePersonRecord(existingPerson, result.person);
          draft.people = existingPerson
            ? draft.people.map((person) => person.id === existingPerson.id ? mergedPerson : person)
            : [...draft.people, mergedPerson];
        }
        draft.selectedPersonId = result.id;
        if (result.eventId) {
          draft.selectedEventId = result.eventId;
          draft.selectedEventIds = [result.eventId];
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
          <button className="button" type="button" onClick={openTagSettings}>
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
            {multiEventMode ? (
              <button
                className="count-pill count-pill-clearable"
                type="button"
                aria-label="Clear multi-event selection"
                onClick={clearMultiEventSelection}
              >
                <span className="count-pill-value">{filteredEvents.length}</span>
                <X className="count-pill-clear" size={14} aria-hidden="true" />
              </button>
            ) : <span className="count-pill">{filteredEvents.length}</span>}
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
                <span className="event-scroll-sentinel" ref={eventStartRef} aria-hidden="true" />
                {renderedEvents.map((event) => (
                    <div
                      className={`event-card ${state.selectedEventIds.includes(event.id) || event.id === state.selectedEventId ? "active" : ""} ${multiEventMode && state.selectedEventIds.includes(event.id) ? "multi-selected" : ""} ${commandPressed ? "command-selecting" : ""}`}
                      key={event.id}
                      data-event-anchor={event.id === eventAnchorId ? "true" : undefined}
                    >
                      <button
                        className="event-card-primary"
                        type="button"
                        aria-label={`${state.selectedEventIds.includes(event.id) ? "Selected: " : "Select "}${event.title}`}
                        onClick={(clickEvent) => selectEvent(event.id, { additive: clickEvent.metaKey })}
                      >
                        <EventArtwork event={event} />
                        <div className="event-card-body">
                          <h3>{event.title}</h3>
                          <time className="event-card-date" dateTime={event.date}>{formatDate(event.date)}</time>
                        </div>
                      </button>
                      <label className="event-card-checkbox" title="Add event to selection">
                        <input
                          type="checkbox"
                          aria-label={`Include ${event.title} in multi-event view`}
                          checked={state.selectedEventIds.includes(event.id) || event.id === state.selectedEventId}
                          onChange={() => selectEvent(event.id, { additive: true })}
                        />
                      </label>
                      {commandPressed ? (
                        <button
                          className="event-card-command-add"
                          type="button"
                          aria-label={`${state.selectedEventIds.includes(event.id) ? "Remove" : "Add"} ${event.title} ${state.selectedEventIds.includes(event.id) ? "from" : "to"} selection`}
                          onClick={() => selectEvent(event.id, { additive: true })}
                        >
                          {state.selectedEventIds.includes(event.id) ? <X size={17} aria-hidden="true" /> : <Plus size={17} aria-hidden="true" />}
                        </button>
                      ) : null}
                    </div>
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
              <div className={`event-summary ${multiEventMode ? "multi-event-summary" : ""}`} key={selectedEventIdsKey}>
                {multiEventMode ? <EventArtworkDeck events={selectedEvents.slice(-3)} /> : <EventArtwork event={selectedEvent} large />}
                <div className="event-summary-content">
                  {selectedEvents.some((event) => event.source === "luma") ? (
                    <div className="event-header-actions" aria-label="Event actions">
                      {!multiEventMode && selectedEvent.lumaUrl ? (
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
                        aria-label={selectedEventLoadingGuests ? "Syncing selected events" : `Sync ${selectedEvents.length === 1 ? "event" : `${selectedEvents.length} events`}`}
                        data-tooltip={selectedEventLoadingGuests ? "Syncing guest data…" : `Refresh ${selectedEvents.length === 1 ? "guests and referrers" : `${selectedEvents.length} events`}`}
                        disabled={selectedEventLoadingGuests}
                        onClick={requestSelectedEventSync}
                      >
                        <RefreshCw
                          className={selectedEventLoadingGuests ? "animate-spin" : ""}
                          size={18}
                          aria-hidden="true"
                        />
                      </button>
                      {!multiEventMode && selectedEventManageUrl ? (
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
                    {multiEventMode ? `${formatEventSelectionRange(selectedEvents)} · Combined workspace` : `${selectedEvent.category} - ${formatDate(selectedEvent.date)}`}
                  </p>
                  <div className="event-title-row">
                    <h2>{multiEventMode ? `${selectedEvents.length} events` : selectedEvent.title}</h2>
                    {multiEventMode ? (
                      <button
                        className="multi-event-clear-button event-action-tooltip"
                        type="button"
                        aria-label="Clear multi-event selection"
                        data-tooltip="Clear selection"
                        onClick={clearMultiEventSelection}
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                  <div className="event-meta">
                    {multiEventMode ? (
                      <span><Layers3 size={15} aria-hidden="true" />{selectedEvents.map((event) => event.title).join(" · ")}</span>
                    ) : <span><MapPin size={15} aria-hidden="true" />{selectedEvent.location}</span>}
                  </div>
                  <EventStats
                    stats={workspaceStats}
                    mode={eventSelectionTiming(selectedEvents, lifecycleNow)}
                    loading={workspaceStatsLoading || (!multiEventMode && selectedEvents.some((event) => event.source === "luma" && !eventHeaderStatsReady(event)))}
                    uniquePeople={multiEventMode}
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
                    onPointerEnter={() => tab.id === "invite" && void loadInviteMetadata("tags").catch(() => {})}
                    onFocus={() => tab.id === "invite" && void loadInviteMetadata("tags").catch(() => {})}
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
                    {hasActiveGuestFilters ? (
                      <button className="button ghost clear-guest-filters" type="button" onClick={clearGuestFilters}>
                        <X size={14} aria-hidden="true" />
                        Clear filters
                      </button>
                    ) : null}
                    <StatusFilter
                      options={guestFilterOptions}
                      selected={state.filters.guestStatus}
                      onChange={(status) => setFilter("guestStatus", status)}
                    />
                    <TagFilter
                      definitions={state.tagDefinitions}
                      selected={state.filters.guestTags}
                      onChange={(tags) => setFilter("guestTags", tags)}
                    />
                    <GuestAttributeFilter
                      hasNotes={state.filters.guestHasNotes}
                      attendedGreaterThan={state.filters.guestAttendedGreaterThan}
                      onHasNotesChange={(value) => setFilter("guestHasNotes", value)}
                      onAttendedGreaterThanChange={(value) => setFilter("guestAttendedGreaterThan", value)}
                    />
                    <label className={`find-filter-control ${state.filters.guestSearch.trim() ? "filter-active" : ""}`}>
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

                {bulkSelectionCount ? (
                  <div className="bulk-toolbar" role="region" aria-label="Bulk guest actions">
                    <strong className="bulk-selection-count">{bulkSelectionCount} selected</strong>
                    <BulkTagMenu
                      definitions={state.tagDefinitions}
                      people={(allMatchingGuestsSelected ? visibleGuests : selectedGuestRows).map((row) => row.person)}
                      allMatching={allMatchingGuestsSelected}
                      submitting={bulkSubmitting}
                      onApply={runBulkTagMutation}
                    />
                    <div className="bulk-actions">
                      <button className="guest-action guest-action-going" type="button" disabled={bulkSubmitting} onClick={() => requestBulkGuestStatus("going", "Approve")}>
                        <CircleCheck size={14} aria-hidden="true" />
                        <span>Approve</span>
                      </button>
                      <button className="guest-action guest-action-waitlisted" type="button" disabled={bulkSubmitting} onClick={() => requestBulkGuestStatus("waitlisted", "Waitlist")}>
                        <Clock3 size={14} aria-hidden="true" />
                        <span>Waitlist</span>
                      </button>
                      <button className="guest-action guest-action-declined" type="button" disabled={bulkSubmitting} onClick={() => requestBulkGuestStatus("declined", "Decline")}>
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
                            aria-label="Select all matching guests"
                            checked={allVisibleGuestsSelected}
                            onChange={(event) => toggleAllMatchingGuests(event.target.checked)}
                          />
                        </th>
                        <th className="guest-identity-column">Guest</th>
                        {showGuestGroups ? <th>Groups</th> : null}
                        <th className="tag-cell">Tags</th>
                        <th className="status-cell">Status</th>
                        {showGuestReferrer ? <th className="referrer-cell">Referrer</th> : null}
                        <th className="event-count-heading text-center">
                          <abbr className="table-header-abbr" data-tooltip="Events attended" aria-label="Events attended" tabIndex={0}>EA</abbr>
                        </th>
                        <th className="event-count-heading text-center">
                          <abbr className="table-header-abbr" data-tooltip="Events registered" aria-label="Events registered" tabIndex={0}>ER</abbr>
                        </th>
                        <th>Actions</th>
                        <th className="note-cell">Notes</th>
                        <th className="whitespace-nowrap">
                          <button
                            className="date-sort-trigger"
                            type="button"
                            aria-label={`Sort status date ${guestDateSortDirection === "desc" ? "oldest first" : "newest first"}`}
                            aria-pressed={guestDateSortDirection === "asc"}
                            onClick={() => {
                              setGuestPageTarget(1);
                              setAllMatchingGuestsSelected(false);
                              setSelectedGuestIds(new Set());
                              lastSelectedGuestIdRef.current = "";
                              setGuestDateSortDirection((current) => current === "desc" ? "asc" : "desc");
                            }}
                          >
                            <span>Status date</span>
                            {guestDateSortDirection === "desc" ? <ArrowDown size={13} /> : <ArrowUp size={13} />}
                          </button>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleGuests.length ? (
                        visibleGuests.map(({ guest, person, history, statusDate, sourceEvent, eventCount }) => {
                          const selectPerson = () => openPerson(person.id);
                          return (
                          <tr
                            className={`guest-row ${state.selectedPersonId === person.id ? "selected" : ""} ${allMatchingGuestsSelected || selectedGuestIds.has(person.id) ? "bulk-selected" : ""}`}
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
                                checked={allMatchingGuestsSelected || selectedGuestIds.has(person.id)}
                                onClick={(event) => toggleGuestSelection(person.id, event.currentTarget.checked, event.shiftKey)}
                                onChange={() => {}}
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
                                onChange={(tags, mutation) => savePersonTags(person.id, tags, {
                                  ...mutation,
                                  eventId: sourceEvent?.id || selectedEvent.id,
                                })}
                                onCreate={(name, tags) => createAndAssignTag(person.id, name, tags, sourceEvent?.id || selectedEvent.id)}
                              />
                            </td>
                            <td className="status-cell">
                              <StatusPill status={guest.status} />
                              {multiEventMode && sourceEvent ? <small className="guest-event-context">{eventCount > 1 ? `${eventCount} selected events · ` : ""}{sourceEvent.title}</small> : null}
                            </td>
                            {showGuestReferrer ? (
                              <td className="referrer-cell">
                                <ReferrerValue referrer={guest.referrer} />
                              </td>
                            ) : null}
                            <td className="event-count-cell text-center text-sm font-semibold tabular-nums">
                              {history.countsLoaded ? history.attendedCount : <span aria-label="Loading events attended">&hellip;</span>}
                            </td>
                            <td className="event-count-cell text-center text-sm font-semibold tabular-nums">
                              {history.countsLoaded ? history.registeredCount : <span aria-label="Loading events registered">&hellip;</span>}
                            </td>
                            <td>
                              <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                                {actionsForStatus(guest.status, sourceEvent).map(([label, status]) => {
                                  const actionKey = `${sourceEvent?.id || state.selectedEventId}:${person.id}`;
                                  const actionBusy = lumaCheckInGuestKey === actionKey || (label === "Reinvite" && reinvitingGuestKey === actionKey);
                                  const ActionIcon = actionBusy ? RefreshCw : guestActionIcons[label];
                                  return (
                                    <button
                                      className={`guest-action guest-action-${status}`}
                                      type="button"
                                      key={status}
                                      aria-label={`${label} ${person.name}`}
                                      title={label}
                                      disabled={actionBusy}
                                      onClick={() => requestGuestStatusChange(person.id, status, label, sourceEvent?.id)}
                                    >
                                      <ActionIcon className={actionBusy ? "animate-spin" : undefined} aria-hidden="true" size={14} strokeWidth={2.25} />
                                      <span>{actionBusy && label === "Reinvite" ? "Sending..." : label}</span>
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
                      ) : selectedEventNeedsGuestLoad || selectedEvents.some((event) => event.guestQueryLoading) ? (
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
                      {visibleGuests.length && selectedEventLoadingGuests && workspaceGuestHasMore ? (
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
                {activeMultiEventGuestPageInfo || selectedEvents.some((event) => event.guestPageInfo) ? (
                  <p className="guest-list-progress">
                    Showing {visibleGuests.length} unique guest{visibleGuests.length === 1 ? "" : "s"} across {selectedEvents.length} event{selectedEvents.length === 1 ? "" : "s"}{workspaceGuestTotal ? ` · ${workspaceGuestTotal} matching registrations` : ""}
                  </p>
                ) : null}
              </section>

            </div>
            ) : null}
          </section>

          {activeEventTab === "invite" ? (
            <InviteTab
              state={state}
              targetEvents={inviteTargetEvents}
              message={inviteMessage}
              templateId={inviteTemplateId}
              onSetInvite={setInvite}
              onMessageChange={(value) => {
                setInviteMessage(value);
                setInviteTemplateId("");
              }}
              onTemplateChange={applyInviteTemplate}
              onOpenPerson={openPerson}
              onAvatarClick={setAvatarPreview}
              onSend={sendInviteAudience}
              onInvitePeople={(people, options) => sendInviteRecipients(people, options)}
              onMergePeople={mergeIndexedPeople}
              request={apiFetch}
              metadata={inviteMetadata}
              onLoadMetadata={loadInviteMetadata}
              onOpenTagSettings={openTagSettings}
            />
          ) : activeEventTab === "analytics" ? (
            <AnalyticsTab
              event={multiEventMode ? { ...selectedEvent, title: `${selectedEvents.length} events` } : selectedEvent}
              analytics={selectedEventAnalytics}
              loading={selectedEvents.some((event) => event.source === "luma" && !eventAnalyticsReady(event))}
              uniquePeople={multiEventMode}
              onOpenPerson={openAnalyticsResponsePerson}
              onOpenRespondents={openAnalyticsRespondents}
              onFilter={openAnalyticsGuestFilter}
            />
          ) : null}
        </section>

        {showProfilePanel ? (
          <ProfilePanel
            state={state}
            person={selectedPerson}
            trace={selectedTrace}
            lumaCheckInGuestKey={lumaCheckInGuestKey}
            reinvitingGuestKey={reinvitingGuestKey}
            onGuestAction={requestGuestStatusChange}
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
          peopleSearchStatus={activeUniversalPeopleSearch?.status || (normalizedUniversalQuery ? "loading" : "idle")}
          peopleSearchError={activeUniversalPeopleSearch?.error || ""}
          inputRef={universalSearchInputRef}
          onQueryChange={setUniversalQuery}
          onClose={() => setSearchOpen(false)}
          onSelect={selectUniversalResult}
        />
      ) : null}

      {avatarPreview ? (
        <AvatarPhotoViewer preview={avatarPreview} onClose={() => setAvatarPreview(null)} />
      ) : null}

      {analyticsRespondentDialog ? (
        <AnalyticsRespondentsDialog
          draft={analyticsRespondentDialog}
          onClose={() => setAnalyticsRespondentDialog(null)}
          onLoadMore={() => {
            const current = analyticsRespondentDialog;
            if (!current || current.loading) return;
            void loadAnalyticsRespondents(current, { append: current.respondents.length > 0 });
          }}
          onOpenPerson={(personId) => {
            setAnalyticsRespondentDialog(null);
            void openAnalyticsResponsePerson(personId);
          }}
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

      {bulkTagConfirmation ? (
        <BulkTagConfirmationDialog
          draft={bulkTagConfirmation}
          definitions={state.tagDefinitions}
          onClose={closeBulkTagConfirmation}
          onSubmit={submitBulkTagConfirmation}
        />
      ) : null}

      {guestStatusDraft ? (
        <GuestStatusDialog
          draft={guestStatusDraft}
          event={getEvent(state, guestStatusDraft.eventId || selectedEvent?.id)}
          guest={getEvent(state, guestStatusDraft.eventId || selectedEvent?.id)?.guests.find((guest) => guest.personId === guestStatusDraft.personId)}
          person={getPerson(state, guestStatusDraft.personId)}
          onChange={setGuestStatusDraft}
          onClose={closeGuestStatusDialog}
          onSubmit={submitGuestStatusChange}
        />
      ) : null}

      {lumaSessionPrompt ? (
        <LumaSessionTokenDialog
          draft={lumaSessionPrompt}
          onChange={setLumaSessionPrompt}
          onClose={() => setLumaSessionPrompt((current) => current?.submitting ? current : null)}
          onSubmit={submitLumaSessionToken}
          onSkip={syncWithoutReferrers}
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
          superTags={superTags}
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

function AnalyticsRespondentsDialog({ draft, onClose, onLoadMore, onOpenPerson }) {
  const closeButtonRef = useRef(null);
  const respondents = Array.isArray(draft.respondents) ? draft.respondents : [];
  const total = draft.pageInfo?.total ?? draft.expectedCount;
  const hasMore = Boolean(draft.pageInfo?.hasMore);

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
    <div className="modal-scrim" role="presentation" onMouseDown={onClose}>
      <section
        className="event-dialog analytics-respondents-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="analytics-respondents-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <div className="dialog-head analytics-respondents-head">
          <div>
            <p className="eyebrow">{draft.answer ? "Answer respondents" : "Question respondents"}</p>
            <h2 id="analytics-respondents-title">{draft.question.label}</h2>
            {draft.answer ? <span className="analytics-answer-filter">{draft.answer}</span> : null}
          </div>
          <button ref={closeButtonRef} className="icon-button" type="button" aria-label="Close respondents" title="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="analytics-respondents-summary">
          <span><Users size={15} aria-hidden="true" />{total} respondent{total === 1 ? "" : "s"}</span>
          {respondents.length ? <span>Showing {respondents.length}</span> : null}
        </div>

        <div
          className="analytics-respondent-list"
          aria-live="polite"
          onScroll={(event) => {
            if (!hasMore || draft.loading) return;
            const list = event.currentTarget;
            if (list.scrollHeight - list.scrollTop - list.clientHeight <= 72) onLoadMore();
          }}
        >
          {respondents.map((row) => (
            <button
              className="analytics-respondent-row"
              type="button"
              key={row.person.id}
              onClick={() => onOpenPerson(row.person.id)}
            >
              <Avatar person={row.person} />
              <span className="analytics-respondent-identity">
                <strong>{row.person.name}</strong>
                <small>{row.person.email || row.person.title || "Luma guest"}</small>
              </span>
              <span className="analytics-respondent-context">
                {!draft.answer ? <strong>{row.response}</strong> : null}
                {draft.eventIds.length > 1 ? <small>{row.eventTitle}</small> : null}
              </span>
              <ArrowRight size={15} aria-hidden="true" />
            </button>
          ))}

          {draft.loading ? (
            <div className="analytics-respondents-loading" role="status">
              <span className="loading-spinner" aria-hidden="true" />
              <span>{respondents.length ? "Loading more respondents" : "Loading respondents"}</span>
            </div>
          ) : null}
          {!draft.loading && draft.error ? (
            <div className="analytics-respondents-error" role="alert">
              <span>{draft.error}</span>
              <button className="button secondary" type="button" onClick={onLoadMore}>Retry</button>
            </div>
          ) : null}
          {!draft.loading && !draft.error && !respondents.length ? (
            <div className="empty-state compact">No matching respondents were found.</div>
          ) : null}
          {!draft.loading && !draft.error && hasMore ? (
            <button className="analytics-respondents-more" type="button" onClick={onLoadMore}>
              Load 10 more <span>{respondents.length} of {total}</span>
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function GuestStatusDialog({ draft, event, guest, person, onChange, onClose, onSubmit }) {
  const bulk = draft.kind === "bulk";
  if (!event || (!bulk && (!guest || !person))) return null;
  const ActionIcon = guestActionIcons[draft.label] || CircleCheck;
  const guestCount = Number(draft.count) || 0;
  const eventCount = Number(draft.eventCount) || 1;
  const dialogSubject = bulk ? `${guestCount} guest${guestCount === 1 ? "" : "s"}` : person.name;
  const contextLabel = bulk && eventCount > 1
    ? `${eventCount} selected events`
    : event.title;
  const destinationStatus = statusLabels[draft.status] || draft.status;

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
            <p className="eyebrow">{contextLabel}</p>
            <h2 id="guest-status-dialog-title">{draft.label} {dialogSubject}</h2>
          </div>
          <button className="icon-button" type="button" disabled={draft.submitting} aria-label="Close status dialog" title="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="status-transition" aria-label={bulk ? `Change ${dialogSubject} to ${destinationStatus}` : `Change status from ${statusLabels[guest.status] || guest.status} to ${destinationStatus}`}>
          {bulk ? <span className="status-pill status-bulk-selection">{guestCount} selected</span> : <StatusPill status={guest.status} />}
          <ArrowRight size={16} aria-hidden="true" />
          <StatusPill status={draft.status} />
        </div>

        {bulk && draft.allMatching ? (
          <div className="all-matching-confirmation" role="note">
            <strong>All matching guests</strong>
            <span>This will update every guest matching the current filters, including results that have not been loaded.</span>
          </div>
        ) : null}

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
            <small>{bulk ? `Email each of the ${dialogSubject}` : person.email || "Luma guest"}</small>
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
            placeholder={bulk ? "Add a note for the selected guests" : "Add a personal note"}
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

function BulkTagConfirmationDialog({ draft, definitions, onClose, onSubmit }) {
  const action = draft.removed ? "Remove" : "Add";
  const guestCount = Number(draft.count) || 0;
  const eventCount = Number(draft.eventCount) || 1;
  const selectedTags = draft.tagIds.map((tagId) => definitions.find((definition) => definition.id === tagId)).filter(Boolean);

  return (
    <div className="modal-scrim" role="presentation" onMouseDown={onClose}>
      <form
        className="event-dialog status-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-tag-confirmation-title"
        onSubmit={onSubmit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <div>
            <p className="eyebrow">{eventCount} selected event{eventCount === 1 ? "" : "s"}</p>
            <h2 id="bulk-tag-confirmation-title">{action} tags for {guestCount} guests</h2>
          </div>
          <button className="icon-button" type="button" disabled={draft.submitting} aria-label="Close tag confirmation" title="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="all-matching-confirmation" role="note">
          <strong>All matching guests</strong>
          <span>This will update every guest matching the current filters, including results that have not been loaded.</span>
        </div>

        <div className="bulk-confirmation-tags" aria-label="Selected tags">
          {selectedTags.map((tag) => (
            <span className="tag-chip" style={tagChipStyle(tag.color)} key={tag.id}>{tagDisplayName(tag.name)}</span>
          ))}
        </div>

        <div className="dialog-actions">
          <button className="button ghost" type="button" disabled={draft.submitting} onClick={onClose}>Cancel</button>
          <button className={`button ${draft.removed ? "danger" : "primary"}`} type="submit" disabled={draft.submitting}>
            {draft.submitting ? <RefreshCw className="animate-spin" size={16} aria-hidden="true" /> : draft.removed ? <X size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
            {draft.submitting ? "Updating..." : `${action} tags`}
          </button>
        </div>
      </form>
    </div>
  );
}

function LumaSessionTokenDialog({ draft, onChange, onClose, onSubmit, onSkip }) {
  const syncingReferrers = draft.pending?.kind === "sync_referrers";
  const reinviting = draft.pending?.kind === "reinvite";
  const accessTitle = syncingReferrers
    ? "Luma guest details access"
    : reinviting
      ? "Luma email delivery access"
      : "Luma check-in access";
  const requestName = syncingReferrers
    ? "get-guest-info"
    : reinviting
      ? "invite/send"
      : "update-check-in";
  return (
    <div className="modal-scrim" role="presentation" onMouseDown={onClose}>
      <form
        className="event-dialog luma-session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="luma-session-dialog-title"
        onSubmit={onSubmit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <div>
            <p className="eyebrow">{accessTitle}</p>
            <h2 id="luma-session-dialog-title">Add your session token</h2>
            <p className="dialog-description">{syncingReferrers ? "Luma only includes referrers in its signed-in guest details response." : "This private Luma action needs the signed-in session header."} Paste the <code>x-luma-auth-session</code> token to continue.</p>
          </div>
          <button className="icon-button" type="button" disabled={draft.submitting} aria-label="Close Luma session token dialog" title="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <label className="luma-session-field">
          <span>Session token</span>
          <input
            type="password"
            autoComplete="off"
            autoFocus
            spellCheck={false}
            value={draft.token}
            disabled={draft.submitting}
            placeholder="Paste token"
            onChange={(event) => onChange((current) => current ? { ...current, token: event.target.value, error: "" } : current)}
          />
        </label>
        <p className="luma-session-help">In Luma, open DevTools → Network, select a <code>{requestName}</code> request, then copy this request header’s value.</p>
        <p className="luma-session-storage-note"><Lock size={14} aria-hidden="true" /> Persisted only in this browser’s local storage. Expired tokens are removed automatically.</p>
        {draft.error ? <p className="session-error" role="alert">{draft.error}</p> : null}

        <div className="dialog-actions">
          <button className="button ghost" type="button" disabled={draft.submitting} onClick={onClose}>Cancel</button>
          {syncingReferrers ? <button className="button ghost" type="button" disabled={draft.submitting} onClick={onSkip}>Sync guests only</button> : null}
          <button className="button primary" type="submit" disabled={draft.submitting || !draft.token.trim()}>
            {draft.submitting ? <RefreshCw className="animate-spin" size={16} aria-hidden="true" /> : syncingReferrers ? <RefreshCw size={16} aria-hidden="true" /> : <BadgeCheck size={16} aria-hidden="true" />}
            {draft.submitting ? "Checking..." : syncingReferrers ? "Save and sync" : "Save and retry"}
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
              onKeyDown={(event) => {
                if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey) || event.nativeEvent.isComposing) return;
                event.preventDefault();
                if (!draft.saving) event.currentTarget.form?.requestSubmit();
              }}
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

function TagSettingsDialog({ definitions, superTags, saving, onClose, onSave }) {
  const [drafts, setDrafts] = useState(() => definitions.map((tag) => ({ ...tag })));
  const [superTagDrafts, setSuperTagDrafts] = useState(() => superTags.map((tag) => ({
    ...tag,
    rules: Array.isArray(tag.rules) ? tag.rules.map((rule) => ({ ...rule })) : [],
  })));
  useEffect(() => {
    setSuperTagDrafts(superTags.map((tag) => ({
      ...tag,
      rules: Array.isArray(tag.rules) ? tag.rules.map((rule) => ({ ...rule })) : [],
    })));
  }, [superTags]);
  const hasInvalidName = drafts.some((tag) => !cleanTagName(tag.name))
    || superTagDrafts.some((tag) => !cleanTagName(tag.name)
      || !tag.rules.length
      || tag.rules.some((rule) => rule.phrase.trim().length < 2));
  const updateSuperTag = (index, updates) => setSuperTagDrafts((current) => current.map((item, itemIndex) => (
    itemIndex === index ? { ...item, ...updates } : item
  )));
  return (
    <div className="modal-scrim" role="presentation" onMouseDown={onClose}>
      <form
        className="event-dialog tag-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tag-settings-title"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(drafts, superTagDrafts);
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <div>
            <p className="eyebrow">Settings</p>
            <h2 id="tag-settings-title">Tags</h2>
            <p className="dialog-description">Manage tag styles and build reusable supertags from tag or event name phrases.</p>
          </div>
          <button className="icon-button" type="button" disabled={saving} aria-label="Close tag settings" title="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        {drafts.length ? (
          <div className="tag-settings-block">
            <div className="tag-settings-section-head"><div><strong>Tags</strong><span>Names and colors update everywhere.</span></div></div>
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
                      onChange={(event) => {
                        const previousName = tag.name;
                        const name = event.target.value;
                        setDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, name } : item));
                        setSuperTagDrafts((current) => current.map((superTag) => ({
                          ...superTag,
                          rules: superTag.rules.map((rule) => rule.source === "tag_exact" && rule.phrase === previousName ? { ...rule, phrase: name } : rule),
                        })));
                      }}
                    />
                  </label>
                  <div className="tag-color-options" aria-label={`Color for ${tag.name}`}>
                    <label className="tag-custom-color" style={{ "--tag-color": tag.color } as CSSProperties} title={tag.managed ? "Automatically managed color" : "Choose a custom color"}>
                      <input type="color" value={tag.color} disabled={saving || tag.managed} aria-label={`Choose a custom color for ${tag.name}`} onChange={(event) => {
                        const color = event.target.value;
                        setDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, color } : item));
                      }} />
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : <div className="empty-state compact">Create your first tag from any guest’s Tags cell.</div>}
        <div className="tag-settings-block">
          <div className="tag-settings-section-head">
            <div><strong>Supertags</strong><span>Match people through phrases found in tag names or event names.</span></div>
            <button className="button compact" type="button" disabled={saving} onClick={() => setSuperTagDrafts((current) => [...current, {
              id: `new-${crypto.randomUUID()}`,
              name: "",
              color: "#38bdf8",
              rules: [{ source: "tag_exact", phrase: "" }],
            }])}><Plus size={14} aria-hidden="true" /> New supertag</button>
          </div>
          <div className="supertag-settings-list">
            {superTagDrafts.map((tag, index) => (
              <section className="supertag-settings-card" key={tag.id}>
                <div className="supertag-settings-primary">
                  <label className="tag-custom-color" style={{ "--tag-color": tag.color } as CSSProperties} title="Choose a supertag color">
                    <input type="color" value={tag.color} disabled={saving} aria-label={`Color for ${tag.name || "new supertag"}`} onChange={(event) => updateSuperTag(index, { color: event.target.value })} />
                  </label>
                  <input type="text" maxLength={40} placeholder="Supertag name" value={tag.name} disabled={saving} aria-label="Supertag name" onChange={(event) => updateSuperTag(index, { name: event.target.value })} />
                  <button className="icon-button compact" type="button" disabled={saving} aria-label={`Delete ${tag.name || "supertag"}`} title="Delete supertag" onClick={() => setSuperTagDrafts((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={15} aria-hidden="true" /></button>
                </div>
                <div className="supertag-rule-list">
                  {tag.rules.map((rule, ruleIndex) => (
                    <div className="supertag-rule-row" key={`${rule.source}-${ruleIndex}`}>
                      <select value={rule.source} disabled={saving} aria-label="Match source" onChange={(event) => updateSuperTag(index, {
                        rules: tag.rules.map((item, itemIndex) => itemIndex === ruleIndex ? { ...item, source: event.target.value } : item),
                      })}>
                        <option value="tag_exact">Specific tag is</option>
                        <option value="tag">Tag name contains</option>
                        <option value="event">Checked-in event contains</option>
                      </select>
                      {rule.source === "tag_exact" ? (
                        <select value={rule.phrase} disabled={saving} aria-label="Specific tag" onChange={(event) => updateSuperTag(index, {
                          rules: tag.rules.map((item, itemIndex) => itemIndex === ruleIndex ? { ...item, phrase: event.target.value } : item),
                        })}>
                          <option value="">Choose a tag</option>
                          {definitions.map((definition) => <option value={definition.name} key={definition.id}>{tagDisplayName(definition.name)}</option>)}
                        </select>
                      ) : (
                        <input type="text" maxLength={80} placeholder={rule.source === "event" ? "Open Campus" : "Off Season"} value={rule.phrase} disabled={saving} aria-label="Phrase to match" onChange={(event) => updateSuperTag(index, {
                          rules: tag.rules.map((item, itemIndex) => itemIndex === ruleIndex ? { ...item, phrase: event.target.value } : item),
                        })} />
                      )}
                      <button className="icon-button compact" type="button" disabled={saving || tag.rules.length === 1} aria-label="Remove rule" title="Remove rule" onClick={() => updateSuperTag(index, { rules: tag.rules.filter((_, itemIndex) => itemIndex !== ruleIndex) })}><X size={14} aria-hidden="true" /></button>
                    </div>
                  ))}
                </div>
                <button className="button ghost compact supertag-add-rule" type="button" disabled={saving || tag.rules.length >= 20} onClick={() => updateSuperTag(index, { rules: [...tag.rules, { source: "tag_exact", phrase: "" }] })}><Plus size={13} aria-hidden="true" /> Add matching rule</button>
              </section>
            ))}
            {!superTagDrafts.length ? <div className="empty-state compact">No supertags yet. Create one to combine related tags or event audiences.</div> : null}
          </div>
        </div>
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

function GuestAttributeFilter({ hasNotes, attendedGreaterThan, onHasNotesChange, onAttendedGreaterThanChange }) {
  const activeCount = Number(hasNotes) + Number(attendedGreaterThan !== "");
  return (
    <div className="attribute-filter-control">
      <span>More</span>
      <details className={`attribute-filter-menu toolbar-filter-menu ${activeCount ? "filter-active" : ""}`}>
        <summary>
          <ListFilter size={15} aria-hidden="true" />
          <span>{activeCount ? `${activeCount} active` : "More filters"}</span>
          {activeCount ? <span className="tag-filter-count">{activeCount}</span> : null}
          <ChevronDown className="status-filter-chevron" size={15} aria-hidden="true" />
        </summary>
        <div className="attribute-filter-popover">
          <div className="attribute-filter-head">
            <strong>Guest details</strong>
            {activeCount ? (
              <button
                type="button"
                onClick={() => {
                  onHasNotesChange(false);
                  onAttendedGreaterThanChange("");
                }}
              >
                Clear
              </button>
            ) : null}
          </div>
          <label className="attribute-filter-option">
            <input type="checkbox" checked={hasNotes} onChange={(event) => onHasNotesChange(event.target.checked)} />
            <FileText size={16} aria-hidden="true" />
            <span>
              <strong>Has notes</strong>
              <small>Only guests with a saved note</small>
            </span>
          </label>
          <label className="attribute-number-filter">
            <span>
              <strong>Events attended</strong>
              <small>Show guests who attended more than</small>
            </span>
            <input
              type="number"
              inputMode="numeric"
              min="0"
              max="10000"
              step="1"
              placeholder="Any"
              value={attendedGreaterThan}
              onChange={(event) => {
                const value = event.target.value;
                onAttendedGreaterThanChange(value === "" ? "" : String(Math.max(0, Math.min(10000, Number.parseInt(value, 10) || 0))));
              }}
              aria-label="Minimum events attended, exclusive"
            />
          </label>
          <p className="attribute-filter-hint">
            {attendedGreaterThan === "" ? "No attendance minimum." : `More than ${attendedGreaterThan} attended event${attendedGreaterThan === "1" ? "" : "s"}.`}
          </p>
        </div>
      </details>
    </div>
  );
}

function TagFilter({ definitions, selected, onChange }) {
  const menuRef = useDismissableDetails();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const tags = definitions.map((tag) => tag.name);
  const selectedTags = Array.isArray(selected) ? selected : [];
  const selectedSet = new Set(selectedTags);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredTags = tags
    .map((tag, index) => ({ tag, index }))
    .filter(({ tag }) => tagDisplayName(tag).toLocaleLowerCase().includes(normalizedQuery))
    .sort((left, right) => Number(selectedSet.has(right.tag)) - Number(selectedSet.has(left.tag)) || left.index - right.index)
    .map(({ tag }) => tag);
  const primaryLabel = selectedTags.length ? tagDisplayName(selectedTags[0]) : "All tags";
  const remainingCount = Math.max(0, selectedTags.length - 1);
  const toggleTag = (tag) => onChange(selectedSet.has(tag)
    ? selectedTags.filter((item) => item !== tag)
    : sortedTags(unique([...selectedTags, tag])));

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, filteredTags.length - 1)));
  }, [query, filteredTags.length]);

  return (
    <div className="tag-filter-control">
      <span>Tags</span>
      <details
        className={`tag-filter-menu toolbar-filter-menu ${selectedTags.length ? "filter-active" : ""}`}
        ref={menuRef}
        onToggle={(event) => {
          if (!event.currentTarget.open) return;
          setQuery("");
          setActiveIndex(0);
          window.requestAnimationFrame(() => searchRef.current?.focus());
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }}
      >
        <summary title={selectedTags.length ? selectedTags.map(tagDisplayName).join(", ") : "All tags"}>
          <Tag size={14} aria-hidden="true" />
          <span className="tag-filter-summary-label">
            <span>{primaryLabel}</span>
            {selectedTags.length ? (
              <span className="tag-filter-count">{remainingCount ? `+${remainingCount}` : "1"}</span>
            ) : null}
          </span>
        </summary>
        <div className="tag-filter-popover">
          <div className="filter-popover-header">
            <div className="tag-filter-head">
              <strong>Match any tag</strong>
              {selectedTags.length ? <button type="button" onClick={() => onChange([])}>Clear</button> : null}
            </div>
            <label className="filter-popover-search">
              <Search size={14} aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                role="combobox"
                aria-label="Search tag filters"
                aria-expanded="true"
                aria-controls="tag-filter-options"
                aria-activedescendant={filteredTags[activeIndex] ? `tag-filter-option-${activeIndex}` : undefined}
                placeholder="Search tags…"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setActiveIndex((current) => filteredTags.length ? (current + 1) % filteredTags.length : 0);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveIndex((current) => filteredTags.length ? (current - 1 + filteredTags.length) % filteredTags.length : 0);
                  } else if (event.key === "Enter" && filteredTags[activeIndex]) {
                    event.preventDefault();
                    toggleTag(filteredTags[activeIndex]);
                  }
                }}
              />
            </label>
          </div>
          <div id="tag-filter-options" role="listbox" aria-multiselectable="true">
          {filteredTags.length ? filteredTags.map((tag, index) => (
            <label className={`tag-filter-option ${index === activeIndex ? "keyboard-active" : ""}`} id={`tag-filter-option-${index}`} role="option" aria-selected={selectedSet.has(tag)} key={tag} onMouseEnter={() => setActiveIndex(index)}>
              <input
                type="checkbox"
                checked={selectedSet.has(tag)}
                onChange={() => toggleTag(tag)}
              />
              <span className="tag-filter-dot" style={{ backgroundColor: tagDefinitionForName(definitions, tag).color }} aria-hidden="true" />
              <span>{tagDisplayName(tag)}</span>
            </label>
          )) : <span className="tag-filter-empty">{query ? "No matching tags" : "No tags yet"}</span>}
          </div>
        </div>
      </details>
    </div>
  );
}

function StatusFilter({ options, selected, onChange }) {
  const menuRef = useDismissableDetails();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const selectedOption = options.find((option) => option.value === selected) || options[0];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredOptions = options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => option.label.toLocaleLowerCase().includes(normalizedQuery))
    .sort((left, right) => Number(right.option.value === selectedOption.value) - Number(left.option.value === selectedOption.value) || left.index - right.index)
    .map(({ option }) => option);
  const selectOption = (option) => {
    if (!option) return;
    onChange(option.value);
    if (menuRef.current) menuRef.current.open = false;
    menuRef.current?.querySelector("summary")?.focus();
  };

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, filteredOptions.length - 1)));
  }, [query, filteredOptions.length]);

  return (
    <div className="status-filter-control">
      <span>Status</span>
      <details
        className={`status-filter-menu toolbar-filter-menu ${selectedOption.value !== "all" ? "filter-active" : ""}`}
        ref={menuRef}
        onToggle={(event) => {
          if (!event.currentTarget.open) return;
          setQuery("");
          setActiveIndex(0);
          window.requestAnimationFrame(() => searchRef.current?.focus());
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }}
      >
        <summary>
          <span className="status-filter-current">
            <span className="status-filter-dot" style={{ "--status-filter-color": selectedOption.color } as CSSProperties} aria-hidden="true" />
            <span>{selectedOption.label}</span>
          </span>
          <ChevronDown className="status-filter-chevron" size={15} aria-hidden="true" />
        </summary>
        <div className="status-filter-popover" role="listbox" aria-label="Filter guests by status">
          <div className="filter-popover-header">
            <div className="status-filter-head"><strong>Guest status</strong></div>
            <label className="filter-popover-search">
              <Search size={14} aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                role="combobox"
                aria-label="Search guest statuses"
                aria-expanded="true"
                aria-controls="status-filter-options"
                aria-activedescendant={filteredOptions[activeIndex] ? `status-filter-option-${activeIndex}` : undefined}
                placeholder="Search statuses…"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setActiveIndex((current) => filteredOptions.length ? (current + 1) % filteredOptions.length : 0);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveIndex((current) => filteredOptions.length ? (current - 1 + filteredOptions.length) % filteredOptions.length : 0);
                  } else if (event.key === "Enter" && filteredOptions[activeIndex]) {
                    event.preventDefault();
                    selectOption(filteredOptions[activeIndex]);
                  }
                }}
              />
            </label>
          </div>
          <div id="status-filter-options">
          {filteredOptions.map((option, index) => {
            const active = option.value === selectedOption.value;
            return (
              <button
                className={`status-filter-option ${active ? "active" : ""} ${index === activeIndex ? "keyboard-active" : ""}`}
                id={`status-filter-option-${index}`}
                type="button"
                role="option"
                aria-selected={active}
                style={{ "--status-filter-color": option.color } as CSSProperties}
                key={option.value}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectOption(option)}
              >
                <span className="status-filter-dot" aria-hidden="true" />
                <span>{option.label}</span>
                {active ? <CircleCheck size={15} aria-hidden="true" /> : null}
              </button>
            );
          })}
          {!filteredOptions.length ? <span className="tag-filter-empty">No matching statuses</span> : null}
          </div>
        </div>
      </details>
    </div>
  );
}

function useDismissableDetails() {
  const menuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) menuRef.current?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, []);
  return menuRef;
}

function UniversalSearchModal({ query, results, resultCount, peopleSearchStatus, peopleSearchError, inputRef, onQueryChange, onClose, onSelect }) {
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
        ) : resultCount || peopleSearchStatus === "loading" ? (
          <div className="search-results">
            <SearchSection title="People" results={results.people} loading={peopleSearchStatus === "loading"} error={peopleSearchError} onSelect={onSelect} />
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

function SearchSection({ title, results, loading = false, error = "", onSelect }) {
  if (!results.length && !loading && !error) return null;
  return (
    <section className="search-section">
      <p className="eyebrow">{title}</p>
      <div className="search-result-list">
        {results.map((result) => (
          <button className="search-result plain" type="button" key={result.type + "-" + result.id} onClick={() => onSelect(result)}>
            <span className="search-result-leading">
              {result.person ? <Avatar person={result.person} /> : null}
              <span className="search-result-kind">{result.kind}</span>
            </span>
            <span className="search-result-main">
              <strong>{result.title}</strong>
              <span>{result.subtitle}</span>
              {result.tags?.length ? (
                <span className="search-result-tags">
                  {result.tags.slice(0, 3).map((tag) => (
                    <span className="tag-chip" style={tagChipStyle(tag.color)} key={tag.name}>{tagDisplayName(tag.name)}</span>
                  ))}
                  {result.tags.length > 3 ? <span className="tag-chip tag-chip-more">+{result.tags.length - 3}</span> : null}
                </span>
              ) : null}
              {result.detail ? <small>{result.detail}</small> : null}
            </span>
          </button>
        ))}
        {loading ? <div className="search-result-state">Searching every indexed person...</div> : null}
        {error ? <div className="search-result-state search-result-error">{error} Showing loaded matches instead.</div> : null}
      </div>
    </section>
  );
}

function EventStats({ stats, mode = "past", loading = false, uniquePeople = false, activeFilter, onFilter }) {
  const items = [
    ...(mode === "upcoming"
      ? [{ value: "to_decide", label: "To Decide", count: stats.toDecide ?? 0 }]
      : mode === "past" ? [
          { value: "new_faces", label: "New Faces", count: stats.newFaces ?? 0 },
          { value: "new_referrals", label: "New Referrals", count: stats.newReferrals ?? 0 },
          { value: "checked_in", label: "Check-ins", count: stats.checkedIn },
        ] : [
          { value: "to_decide", label: "To Decide", count: stats.toDecide ?? 0 },
          { value: "new_faces", label: "New Faces", count: stats.newFaces ?? 0 },
          { value: "new_referrals", label: "New Referrals", count: stats.newReferrals ?? 0 },
          { value: "checked_in", label: "Check-ins", count: stats.checkedIn },
        ]),
    ...(mode === "upcoming" ? [{ value: "new_referrals", label: "New Referrals", count: stats.newReferrals ?? 0 }] : []),
    { value: "first_registers", label: "First Registers", count: stats.newRegistrations ?? stats.firstRegisters ?? 0 },
    { value: "accepted", label: "Accepted", count: stats.accepted ?? stats.confirmed ?? 0 },
    { value: "registered", label: "Registered", count: stats.registered },
    { value: "invited", label: "Invited", count: stats.invited },
    { value: "waitlisted", label: "Waitlist", count: stats.waitlisted },
  ];
  return (
    <div className="summary-stats-wrap">
      {uniquePeople ? <div className="summary-stats-scope"><Users size={13} aria-hidden="true" /> Unique people across selected events</div> : null}
      <div className="summary-stats" aria-label={uniquePeople ? "Unique guest status filters" : "Guest status filters"} aria-busy={loading}>
      {items.map((item) => (
        <button
          className={`summary-stat ${activeFilter === item.value ? "active" : ""}`}
          type="button"
          aria-pressed={activeFilter === item.value}
          title={uniquePeople ? `${loading ? "Loading" : item.count || 0} unique people` : undefined}
          key={item.value}
          onClick={() => onFilter(item.value)}
        >
          <strong>{loading ? "..." : item.count || 0}</strong>
          <span>{item.label}</span>
        </button>
      ))}
      </div>
    </div>
  );
}

function InviteTab({
  state,
  targetEvents,
  message,
  templateId,
  onSetInvite,
  onMessageChange,
  onTemplateChange,
  onOpenPerson,
  onAvatarClick,
  onSend,
  onInvitePeople,
  onMergePeople,
  request,
  metadata,
  onLoadMetadata,
  onOpenTagSettings,
}) {
  const [stage, setStage] = useState("add");
  const [tagLoading, setTagLoading] = useState("");
  const [eventLoading, setEventLoading] = useState("");
  const [builderError, setBuilderError] = useState("");
  const [confirmationStatus, setConfirmationStatus] = useState("idle");
  const [directoryQuery, setDirectoryQuery] = useState("");
  const [directorySearch, setDirectorySearch] = useState({ query: "", loading: false, results: [], error: "" });
  const [resolvedAudience, setResolvedAudience] = useState<any>({
    loading: false,
    loadingMore: false,
    countLoading: false,
    people: [],
    total: 0,
    matchedTotal: 0,
    nextCursor: null,
    error: "",
  });
  const inviteBuilderRef = useRef<HTMLElement | null>(null);
  const directoryScrollRef = useRef<HTMLDivElement | null>(null);
  const audienceLoadMoreRef = useRef<HTMLDivElement | null>(null);
  const tagGroups = metadata.tagGroups || [];
  const superTagGroups = metadata.superTagGroups || [];
  const tagsLoading = metadata.tagsStatus === "idle" || metadata.tagsStatus === "loading";
  const tagIdByName = useMemo(() => new Map(tagGroups.map((group) => [group.name, group.id])), [tagGroups]);
  const superTagIdByName = useMemo(() => new Map(superTagGroups.map((group) => [group.name, group.id])), [superTagGroups]);
  const audienceCriteria = useMemo(() => ({
    includeTagIds: (state.invite.includeTags || []).map((name) => tagIdByName.get(name)).filter(Boolean),
    excludeTagIds: (state.invite.excludeTags || []).map((name) => tagIdByName.get(name)).filter(Boolean),
    includeSuperTagIds: (state.invite.includeSuperTags || []).map((name) => superTagIdByName.get(name)).filter(Boolean),
    excludeSuperTagIds: (state.invite.excludeSuperTags || []).map((name) => superTagIdByName.get(name)).filter(Boolean),
    includeEventCohorts: Object.entries(state.invite.includeEventCohorts || {}).map(([eventId, selection]: [string, any]) => ({
      eventId,
      cohort: selection.cohort,
    })),
    excludeEventCohorts: Object.entries(state.invite.excludeEventCohorts || {}).map(([eventId, selection]: [string, any]) => ({
      eventId,
      cohort: selection.cohort,
    })),
    excludeExistingEventIds: targetEvents.filter((event) => event.source === "luma").map((event) => event.id),
    includePersonIds: state.invite.includePeople || [],
    excludePersonIds: state.invite.excludePeople || [],
  }), [
    state.invite.includeTags,
    state.invite.excludeTags,
    state.invite.includeSuperTags,
    state.invite.excludeSuperTags,
    state.invite.includeEventCohorts,
    state.invite.excludeEventCohorts,
    state.invite.includePeople,
    state.invite.excludePeople,
    targetEvents,
    tagIdByName,
    superTagIdByName,
  ]);
  const audienceCriteriaKey = useMemo(() => JSON.stringify(audienceCriteria), [audienceCriteria]);
  const confirmationKey = `${audienceCriteriaKey}:${message}:${targetEvents.map((event) => event.id).join(",")}`;

  useEffect(() => setConfirmationStatus("idle"), [confirmationKey]);

  useEffect(() => {
    if (metadata.tagsStatus === "loading" || metadata.tagsStatus === "refreshing" || metadata.tagsStatus === "error") return;
    void onLoadMetadata("tags").catch(() => {});
  }, [metadata.tagsStatus]);

  useEffect(() => {
    if (metadata.tagsStatus !== "ready" || metadata.eventsStatus === "loading" || metadata.eventsStatus === "refreshing" || metadata.eventsStatus === "error") return;
    const timeout = window.setTimeout(() => void onLoadMetadata("events").catch(() => {}), 0);
    return () => window.clearTimeout(timeout);
  }, [metadata.tagsStatus, metadata.eventsStatus]);

  useEffect(() => {
    const query = directoryQuery.trim();
    if (!query) {
      setDirectorySearch({ query: "", loading: false, results: [], error: "" });
      return;
    }
    const controller = new AbortController();
    setDirectorySearch({ query, loading: true, results: [], error: "" });
    const timeout = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query, scope: "name", limit: "30" });
        const response = await request(`/api/search/people?${params.toString()}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to search people.");
        if (!controller.signal.aborted) setDirectorySearch({ query, loading: false, results: data.people || [], error: "" });
      } catch (error: any) {
        if (!controller.signal.aborted) setDirectorySearch({ query, loading: false, results: [], error: error.message || "Unable to search people." });
      }
    }, UNIVERSAL_PEOPLE_SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [directoryQuery]);

  useEffect(() => {
    const hasIncludes = audienceCriteria.includeTagIds.length
      || audienceCriteria.includeEventCohorts.length
      || audienceCriteria.includePersonIds.length;
    if (!hasIncludes) {
      setResolvedAudience({ loading: false, loadingMore: false, countLoading: false, people: [], total: 0, matchedTotal: 0, nextCursor: null, error: "" });
      return;
    }
    const controller = new AbortController();
    setResolvedAudience({ loading: true, loadingMore: false, countLoading: true, people: [], total: 0, matchedTotal: 0, nextCursor: null, error: "" });
    void (async () => {
      try {
        const response = await request("/api/audience/resolve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ criteria: audienceCriteria, cursor: "", pageSize: 10, includeTotals: false }),
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to load the selected audience.");
        if (!controller.signal.aborted) {
          setResolvedAudience((current) => ({
            ...current,
            loading: false,
            loadingMore: false,
            people: data.people || [],
            nextCursor: data.pageInfo?.nextCursor ?? null,
            error: "",
          }));
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setResolvedAudience((current) => ({ ...current, loading: false, loadingMore: false, people: [], nextCursor: null, error: error.message || "Unable to load the selected audience." }));
        }
      }
    })();
    void (async () => {
      try {
        const response = await request("/api/audience/resolve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ criteria: audienceCriteria, countsOnly: true }),
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to count the selected audience.");
        if (!controller.signal.aborted) {
          setResolvedAudience((current) => ({
            ...current,
            countLoading: false,
            total: Number(data.eligibleTotal) || 0,
            matchedTotal: Number(data.total) || 0,
          }));
        }
      } catch (error) {
        if (!controller.signal.aborted) setResolvedAudience((current) => ({ ...current, countLoading: false }));
      }
    })();
    return () => controller.abort();
  }, [audienceCriteriaKey]);

  const includeTags = state.invite.includeTags || [];
  const excludeTags = state.invite.excludeTags || [];
  const includeSuperTags = state.invite.includeSuperTags || [];
  const excludeSuperTags = state.invite.excludeSuperTags || [];
  const includeEventCohorts = state.invite.includeEventCohorts || {};
  const excludeEventCohorts = state.invite.excludeEventCohorts || {};
  const directoryRows = directoryQuery.trim()
    ? directorySearch.results
    : resolvedAudience.people;
  const renderedDirectoryRows = directoryRows;
  const audienceTotal = resolvedAudience.total;
  const matchedAudienceTotal = resolvedAudience.matchedTotal;
  const existingAudienceTotal = Math.max(0, matchedAudienceTotal - audienceTotal);

  const loadMoreAudience = async () => {
    if (resolvedAudience.loadingMore || resolvedAudience.nextCursor == null) return;
    setResolvedAudience((current) => ({ ...current, loadingMore: true, error: "" }));
    try {
      const response = await request("/api/audience/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ criteria: audienceCriteria, cursor: resolvedAudience.nextCursor, pageSize: 10, includeTotals: false }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to load more recipients.");
      setResolvedAudience((current) => ({
        ...current,
        loadingMore: false,
        people: [...current.people, ...(data.people || [])],
        nextCursor: data.pageInfo?.nextCursor ?? null,
      }));
    } catch (error: any) {
      setResolvedAudience((current) => ({ ...current, loadingMore: false, error: error.message || "Unable to load more recipients." }));
    }
  };

  useEffect(() => {
    const target = audienceLoadMoreRef.current;
    const root = directoryScrollRef.current;
    if (!target || !root || directoryQuery.trim() || resolvedAudience.nextCursor == null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMoreAudience();
    }, { root, rootMargin: "180px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [directoryQuery, resolvedAudience.nextCursor, resolvedAudience.loadingMore, audienceCriteriaKey]);

  const selectTagGroup = async (group, mode) => {
    const key = group.superTag
      ? mode === "add" ? "includeSuperTags" : "excludeSuperTags"
      : mode === "add" ? "includeTags" : "excludeTags";
    const selected = state.invite[key] || [];
    if (selected.includes(group.name)) {
      onSetInvite(key, selected.filter((tag) => tag !== group.name));
      return;
    }
    setBuilderError("");
    onSetInvite(key, [...selected, group.name]);
  };

  const selectEventCohort = async (event, cohort, mode) => {
    const key = mode === "add" ? "includeEventCohorts" : "excludeEventCohorts";
    const selected = state.invite[key] || {};
    const current = selected[event.id];
    if (current?.cohort === cohort) {
      const next = { ...selected };
      delete next[event.id];
      onSetInvite(key, next);
      return;
    }
    setBuilderError("");
    onSetInvite(key, {
      ...selected,
      [event.id]: { cohort },
    });
  };

  const directorySelectionKey = stage === "subtract" ? "excludePeople" : "includePeople";
  const directorySelectedPeople = state.invite[directorySelectionKey] || [];
  const hasAdditions = includeTags.length > 0
    || includeSuperTags.length > 0
    || Object.keys(includeEventCohorts).length > 0
    || (state.invite.includePeople || []).length > 0;
  const hasSubtractions = excludeTags.length > 0
    || excludeSuperTags.length > 0
    || Object.keys(excludeEventCohorts).length > 0
    || (state.invite.excludePeople || []).length > 0;
  const confirmationEvents = targetEvents.filter((event) => event.source === "luma");
  const confirmationInvitationCount = audienceTotal * confirmationEvents.length;
  const confirmationPreviewEvent = confirmationEvents[0] || null;
  const confirmationEventDate = confirmationPreviewEvent?.startsAt
    ? formatDateTime(confirmationPreviewEvent.startsAt)
    : confirmationPreviewEvent?.date ? formatDate(confirmationPreviewEvent.date) : "Event date";
  const eventById = new Map(state.events.map((event) => [event.id, event]));
  const additionSummary = [
    ...includeSuperTags.map((name) => ({ label: name, detail: "Supertag" })),
    ...includeTags.map((name) => ({ label: name, detail: "Tag group" })),
    ...Object.entries(includeEventCohorts).map(([eventId, selection]: [string, any]) => ({
      label: (eventById.get(eventId) as any)?.title || "Historical event",
      detail: `${selection.cohort} group`,
    })),
    ...((state.invite.includePeople || []).length
      ? [{ label: `${state.invite.includePeople.length.toLocaleString()} individual ${state.invite.includePeople.length === 1 ? "person" : "people"}`, detail: "Manually added" }]
      : []),
  ];
  const subtractionSummary = [
    ...excludeSuperTags.map((name) => ({ label: name, detail: "Supertag" })),
    ...excludeTags.map((name) => ({ label: name, detail: "Tag group" })),
    ...Object.entries(excludeEventCohorts).map(([eventId, selection]: [string, any]) => ({
      label: (eventById.get(eventId) as any)?.title || "Historical event",
      detail: `${selection.cohort} group`,
    })),
    ...((state.invite.excludePeople || []).length
      ? [{ label: `${state.invite.excludePeople.length.toLocaleString()} individual ${state.invite.excludePeople.length === 1 ? "person" : "people"}`, detail: "Manually subtracted" }]
      : []),
  ];
  const clearStageSelections = (mode) => {
    if (mode === "add") {
      onSetInvite({ includeTags: [], includeSuperTags: [], includeEventCohorts: {}, includePeople: [] });
      return;
    }
    onSetInvite({ excludeTags: [], excludeSuperTags: [], excludeEventCohorts: {}, excludePeople: [] });
  };
  const goToStage = (nextStage) => {
    setStage(nextStage);
    window.requestAnimationFrame(() => {
      inviteBuilderRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };
  const toggleDirectoryPerson = (person) => {
    if (directorySelectedPeople.includes(person.id)) {
      onSetInvite(directorySelectionKey, directorySelectedPeople.filter((personId) => personId !== person.id));
      return;
    }
    onMergePeople([person]);
    onSetInvite(directorySelectionKey, [...directorySelectedPeople, person.id]);
  };
  const confirmAndSend = async () => {
    if (confirmationStatus !== "idle") return;
    setConfirmationStatus("sending");
    const sent = await onSend(audienceCriteria, { message, recipientCount: audienceTotal });
    setConfirmationStatus(sent ? "sent" : "idle");
  };

  return (
    <section className="invite-tab invite-workspace panel" role="tabpanel" aria-label="Invite">
      <header className="invite-workspace-head">
        <div>
          <p className="eyebrow">Invite people</p>
          <h2>{targetEvents.length > 1 ? `${targetEvents.length} selected events` : targetEvents[0]?.title || "Select an event"}</h2>
          <p>Build an audience from tags or individual people, then send one email invitation.</p>
        </div>
        <div className="invite-recipient-total">
          <strong>{resolvedAudience.countLoading ? "…" : audienceTotal.toLocaleString()}</strong>
          <span>eligible to invite</span>
          {!resolvedAudience.countLoading && existingAudienceTotal ? <small>{existingAudienceTotal.toLocaleString()} already in event</small> : null}
        </div>
      </header>

      <div className="invite-workspace-columns">
        <div className="invite-workflow-panel">
          <nav className="invite-steps" aria-label="Invitation steps">
            {[
              { id: "add", number: 1, label: "Add people" },
              { id: "subtract", number: 2, label: "Subtract" },
              { id: "message", number: 3, label: "Message & send" },
            ].map((item) => (
              <button
                className={stage === item.id || (stage === "confirm" && item.id === "message") ? "active" : ""}
                type="button"
                key={item.id}
                disabled={item.id === "message" && (!hasAdditions || resolvedAudience.countLoading || !audienceTotal)}
                onClick={() => goToStage(item.id)}
              >
                <span>{item.number}</span>{item.label}
              </button>
            ))}
          </nav>

          <section className="invite-builder-stage" ref={inviteBuilderRef}>
        {stage === "add" ? (
          <div className="invite-mode-banner invite-mode-banner-add">
            <UserPlus size={18} aria-hidden="true" />
            <div><strong>Adding people</strong><span>Selections will be added to the invitation audience.</span></div>
            <div className="invite-mode-banner-actions"><small>Step 1 of 3</small><button type="button" disabled={!hasAdditions} onClick={() => clearStageSelections("add")}><X size={13} aria-hidden="true" /> Clear additions</button></div>
          </div>
        ) : stage === "subtract" ? (
          <div className="invite-mode-banner invite-mode-banner-subtract">
            <UserMinus size={18} aria-hidden="true" />
            <div><strong>Subtracting people</strong><span>Selections will be removed from the invitation audience.</span></div>
            <div className="invite-mode-banner-actions"><small>Step 2 of 3</small><button type="button" disabled={!hasSubtractions} onClick={() => clearStageSelections("subtract")}><X size={13} aria-hidden="true" /> Clear subtractions</button></div>
          </div>
        ) : null}
        {builderError || metadata.tagsError ? <div className="invite-builder-error" role="alert">{builderError || metadata.tagsError}</div> : null}
        {stage === "add" ? (
          <>
            <div className="invite-stage-head"><div><p className="eyebrow">Step 1</p><h3>Add people by group</h3><p>Build an audience from tag groups, past events, or individual people.</p></div></div>
            <TagAudienceBubbles groups={tagGroups} superTags={superTagGroups} selected={includeTags} selectedSuperTags={includeSuperTags} loading={tagsLoading} activeLoading={tagLoading} mode="add" onSelect={selectTagGroup} onOpenTagSettings={onOpenTagSettings} />
            <EventAudiencePicker events={state.events} selections={includeEventCohorts} activeLoading={eventLoading} mode="add" cohortCounts={metadata.eventCounts} countsStatus={metadata.eventsStatus} countsError={metadata.eventsError} onSelect={selectEventCohort} />
            <div className="invite-stage-actions"><div className="invite-stage-progress"><strong>{resolvedAudience.countLoading ? "…" : audienceTotal.toLocaleString()}</strong><span>people ready</span></div><button className="button primary" type="button" title="Continue to subtract people" disabled={!audienceTotal || resolvedAudience.countLoading} onClick={() => goToStage("subtract")}>Continue <ArrowRight size={15} aria-hidden="true" /></button></div>
          </>
        ) : null}

        {stage === "subtract" ? (
          <>
            <div className="invite-stage-head"><div><p className="eyebrow">Step 2</p><h3>Subtract people</h3><p>Remove tag groups, past-event groups, or individual people.</p></div></div>
            <TagAudienceBubbles groups={tagGroups.filter((group) => !includeTags.includes(group.name))} superTags={superTagGroups.filter((group) => !includeSuperTags.includes(group.name))} selected={excludeTags} selectedSuperTags={excludeSuperTags} loading={tagsLoading} activeLoading={tagLoading} mode="subtract" onSelect={selectTagGroup} onOpenTagSettings={onOpenTagSettings} />
            <EventAudiencePicker events={state.events} selections={excludeEventCohorts} activeLoading={eventLoading} mode="subtract" cohortCounts={metadata.eventCounts} countsStatus={metadata.eventsStatus} countsError={metadata.eventsError} onSelect={selectEventCohort} />
            <div className="invite-stage-actions"><button className="button ghost" type="button" onClick={() => goToStage("add")}>Back</button><div className="invite-stage-progress"><strong>{resolvedAudience.countLoading ? "…" : audienceTotal.toLocaleString()}</strong><span>people remaining</span></div><button className="button primary" type="button" title="Continue to message" disabled={!audienceTotal || resolvedAudience.countLoading} onClick={() => goToStage("message")}>Continue <ArrowRight size={15} aria-hidden="true" /></button></div>
          </>
        ) : null}

        {stage === "message" ? (
          <>
            <div className="invite-stage-head"><div><p className="eyebrow">Step 3</p><h3>Write the invitation</h3><p>This message will be emailed to {audienceTotal.toLocaleString()} selected {audienceTotal === 1 ? "person" : "people"}.</p></div></div>
            <InviteMarkdownEditor value={message} templateId={templateId} onChange={onMessageChange} onTemplateChange={onTemplateChange} />
            <div className="invite-stage-actions"><button className="button ghost" type="button" onClick={() => goToStage("subtract")}>Back</button><button className="button primary" type="button" disabled={!audienceTotal || resolvedAudience.countLoading || !confirmationEvents.length} onClick={() => goToStage("confirm")}><Send size={16} aria-hidden="true" /> Review invitations</button></div>
          </>
        ) : null}

        {stage === "confirm" ? (
          <section className="invite-confirmation" aria-labelledby="invite-confirmation-title">
            <div className="invite-confirmation-heading">
              {confirmationEvents.length > 1
                ? <EventArtworkDeck events={confirmationEvents.slice(-3)} />
                : confirmationEvents[0] ? <EventArtwork event={confirmationEvents[0]} large /> : null}
              <div>
                <p className="eyebrow">Final confirmation</p>
                <h3 id="invite-confirmation-title">{confirmationEvents.length === 1 ? confirmationEvents[0].title : `${confirmationEvents.length} events`}</h3>
                {confirmationEvents.length > 1 ? <p>{confirmationEvents.map((event) => event.title).join(" · ")}</p> : null}
              </div>
            </div>

            <div className="invite-confirmation-count">
              <strong>{confirmationInvitationCount.toLocaleString()}</strong>
              <span>invitation{confirmationInvitationCount === 1 ? "" : "s"} will be sent</span>
              {confirmationEvents.length > 1 ? <small>{audienceTotal.toLocaleString()} people × {confirmationEvents.length} events</small> : <small>{audienceTotal.toLocaleString()} selected {audienceTotal === 1 ? "person" : "people"}</small>}
            </div>

            <div className="invite-confirmation-rules">
              <ConfirmationRuleList title="Added" tone="add" items={additionSummary} emptyText="No groups added." />
              <ConfirmationRuleList title="Subtracted" tone="subtract" items={subtractionSummary} emptyText="No groups subtracted." />
            </div>

            <div className="invite-confirmation-message">
              <div className="invite-confirmation-message-heading">
                <strong>Email preview</strong>
                {confirmationEvents.length > 1 ? <span>Showing the first of {confirmationEvents.length} event emails</span> : null}
              </div>
              <div className="invite-email-preview">
                <div className="invite-email-intro">
                  <span>You’re invited to</span>
                  <strong>{confirmationPreviewEvent?.title || "Selected event"}</strong>
                </div>
                <div className="invite-email-details">
                  <div><Clock3 size={17} aria-hidden="true" /><span><strong>{confirmationEventDate}</strong>{confirmationPreviewEvent?.endsAt ? <small>Ends {formatDateTime(confirmationPreviewEvent.endsAt)}</small> : null}</span></div>
                  <div><MapPin size={17} aria-hidden="true" /><span><strong>{confirmationPreviewEvent?.location || "Location provided by the organizer"}</strong></span></div>
                </div>
                <div className={`markdown-preview invite-email-message ${message.trim() ? "" : "empty"}`}>
                  {message.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message}</ReactMarkdown> : <p>No custom message.</p>}
                </div>
                <div className="invite-email-actions">
                  <span className="invite-email-accept">Accept Invite</span>
                  <span className="invite-email-view">View Event</span>
                </div>
                <p className="invite-email-decline">Can’t make it? Recipients can decline the invite to stop receiving emails about this event.</p>
              </div>
              <div className="invite-delivery-note">
                <MailPlus size={18} aria-hidden="true" />
                <div><strong>We’ll email each person this invitation with their unique registration link.</strong><span>Anyone already registered, accepted, waitlisted, declined, or invited is automatically excluded.</span></div>
              </div>
            </div>

            <div className="invite-stage-actions">
              <button className="button ghost" type="button" onClick={() => goToStage("message")}>Back to message</button>
              <button className="button primary" type="button" disabled={!confirmationInvitationCount || confirmationStatus !== "idle"} onClick={confirmAndSend}>{confirmationStatus === "sending" ? <RefreshCw className="animate-spin" size={16} aria-hidden="true" /> : confirmationStatus === "sent" ? <CircleCheck size={16} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}{confirmationStatus === "sending" ? "Sending invitations…" : confirmationStatus === "sent" ? "Invitations sent" : `Confirm & send ${confirmationInvitationCount.toLocaleString()}`}</button>
            </div>
          </section>
        ) : null}
          </section>
        </div>

        <section className="invite-directory">
          <div className="invite-directory-head">
            <div><p className="eyebrow">People directory</p><h3>{directoryQuery.trim() ? "Search results" : "Selected recipients"}</h3>{!directoryQuery.trim() && existingAudienceTotal ? <small>{matchedAudienceTotal.toLocaleString()} matched · {existingAudienceTotal.toLocaleString()} already in this event</small> : null}</div>
            <label className="invite-directory-search"><Search size={17} aria-hidden="true" /><input type="search" value={directoryQuery} placeholder="Search everyone by name" onChange={(event) => setDirectoryQuery(event.target.value)} />{directoryQuery ? <button className="plain" type="button" aria-label="Clear search" onClick={() => setDirectoryQuery("")}><X size={15} /></button> : null}</label>
          </div>
          <div className="table-wrap invite-directory-table-wrap" ref={directoryScrollRef}>
            <table className="invite-directory-table">
              <thead><tr><th>Guest</th><th>Tags</th><th>EA</th><th>ER</th><th>Actions</th></tr></thead>
              <tbody>
                {renderedDirectoryRows.map(({ person, eventCounts, alreadyInTargetEvent, existingTargetStatuses = [], existingTargetEventCount = 0 }) => {
                  const loadedTargetGuests = targetEvents.flatMap((event) => event.guests.filter((guest) => guest.personId === person.id));
                  const targetStatuses = existingTargetStatuses.length
                    ? existingTargetStatuses
                    : unique(loadedTargetGuests.map((guest) => guest.status).filter(Boolean));
                  const targetEventCount = existingTargetEventCount || loadedTargetGuests.length;
                  const rowAlreadyInTargetEvent = alreadyInTargetEvent || targetEventCount > 0;
                  const existingStatusLabel = targetStatuses.length === 1
                    ? statusLabels[targetStatuses[0]] || targetStatuses[0]
                    : targetEventCount > 1 ? `In ${targetEventCount} events` : "Already added";
                  const manuallySelected = directorySelectedPeople.includes(person.id);
                  const directoryLocked = stage === "message" || stage === "confirm";
                  const directoryActionLabel = stage === "subtract" ? "Subtract" : "Add";
                  return (
                  <tr className={rowAlreadyInTargetEvent ? "invite-directory-row-ineligible" : ""} key={person.id}>
                    <td><PersonButton person={person} onAvatarClick={onAvatarClick} onClick={() => { onMergePeople([person]); onOpenPerson(person.id); }} /></td>
                    <td><InvitePersonTags person={person} definitions={state.tagDefinitions} /></td>
                    <td className="invite-count-cell">{eventCounts?.attended || 0}</td>
                    <td className="invite-count-cell">{eventCounts?.registered || 0}</td>
                    <td><button className={`button small invite-row-action ${manuallySelected || directoryLocked ? "active" : ""}`} type="button" title={rowAlreadyInTargetEvent ? "Already part of the selected event" : manuallySelected && !directoryLocked ? "Click to undo" : undefined} disabled={rowAlreadyInTargetEvent || directoryLocked} onClick={() => toggleDirectoryPerson(person)}>{rowAlreadyInTargetEvent || manuallySelected || directoryLocked ? <CircleCheck size={14} /> : null}{rowAlreadyInTargetEvent ? existingStatusLabel : directoryLocked ? "Selected" : manuallySelected ? (stage === "subtract" ? "Subtracted" : "Added") : `${stage === "subtract" ? "−" : "+"} ${directoryActionLabel}`}</button></td>
                  </tr>
                )})}
                {!directoryQuery.trim() && resolvedAudience.nextCursor != null ? <tr><td colSpan={5}><div className="empty-state compact invite-directory-sentinel" ref={audienceLoadMoreRef}>{resolvedAudience.loadingMore ? <><span className="loading-spinner" /> Loading more recipients…</> : `Scroll for more · ${renderedDirectoryRows.length.toLocaleString()} loaded`}</div></td></tr> : null}
                {!directoryRows.length ? <tr><td colSpan={5}><div className="empty-state">{directorySearch.loading ? "Searching every indexed name..." : directorySearch.error || resolvedAudience.error || (resolvedAudience.loading ? "Loading selected recipients…" : directoryQuery ? `No people named “${directoryQuery}”.` : "Add a tag or person to start your invitation list.")}</div></td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </section>
  );
}

function ConfirmationRuleList({ title, tone, items, emptyText }) {
  return (
    <section className={`invite-confirmation-rule-list invite-confirmation-rule-list-${tone}`}>
      <div className="invite-confirmation-rule-heading">
        {tone === "add" ? <UserPlus size={15} aria-hidden="true" /> : <UserMinus size={15} aria-hidden="true" />}
        <strong>{title}</strong>
        <span>{items.length}</span>
      </div>
      {items.length ? (
        <div className="invite-confirmation-rule-items">
          {items.map((item, index) => (
            <div key={`${item.label}-${item.detail}-${index}`}>
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </div>
          ))}
        </div>
      ) : <p>{emptyText}</p>}
    </section>
  );
}

function TagAudienceBubbles({ groups, superTags = [], selected, selectedSuperTags = [], loading, activeLoading, mode, onSelect, onOpenTagSettings }) {
  const [manualQuery, setManualQuery] = useState("");
  if (loading) return <div className="invite-bubble-loading"><span className="loading-spinner" /> Loading tag groups...</div>;
  const normalizedManualQuery = manualQuery.trim().toLocaleLowerCase();
  const manualGroups = groups.filter((group) => !group.automatic)
    .filter((group) => !normalizedManualQuery || group.name.toLocaleLowerCase().includes(normalizedManualQuery));
  const sections = [
    { id: "manual", title: "Manual tags", description: "Tags created and assigned by your team", groups: manualGroups, searchable: true },
    { id: "supertag", title: "Supertags", description: "Reusable audiences combined from tag and event name rules", groups: superTags.map((group) => ({ ...group, superTag: true })) },
    { id: "automatic", title: "Automatic tags", description: "Tags maintained automatically from guest activity", groups: groups.filter((group) => group.automatic) },
  ].filter((section) => section.id === "supertag" || section.groups.length || section.searchable);
  return sections.length ? (
    <div className="invite-tag-sections">
      {sections.map((section) => (
        <section className={`invite-tag-section ${section.id}`} key={section.id}>
          <div className="invite-tag-section-head">
            <div><strong>{section.title}</strong><span>{section.description}</span></div>
            {section.id === "manual" || section.id === "supertag" ? (
              <button className="invite-tag-settings-link" type="button" onClick={onOpenTagSettings}>
                <span>{section.groups.length} {section.id === "supertag" ? section.groups.length === 1 ? "supertag" : "supertags" : section.groups.length === 1 ? "tag" : "tags"}</span>
                <Pencil size={12} aria-hidden="true" />
                <span>Edit</span>
              </button>
            ) : <small>{section.groups.length} {section.groups.length === 1 ? "tag" : "tags"}</small>}
          </div>
          {section.searchable ? (
            <label className="invite-manual-tag-search">
              <Search size={14} aria-hidden="true" />
              <input type="search" placeholder="Search manual tags" value={manualQuery} onChange={(event) => setManualQuery(event.target.value)} />
              {manualQuery ? <button type="button" aria-label="Clear manual tag search" onClick={() => setManualQuery("")}><X size={13} aria-hidden="true" /></button> : null}
            </label>
          ) : null}
          <div className="invite-tag-bubbles">
            {section.groups.map((group) => {
              const active = (group.superTag ? selectedSuperTags : selected).includes(group.name);
              const busy = activeLoading === `${mode}:${group.name}`;
              const superTagRule = group.superTag
                ? group.rules.map((rule) => rule.source === "event"
                  ? `Checked in · event contains “${rule.phrase}”`
                  : rule.source === "tag_exact" ? `Tag is “${rule.phrase}”` : `Tag contains “${rule.phrase}”`).join(" · ")
                : "";
              return (
                <button className={`invite-tag-bubble ${active ? "active" : ""} ${mode === "subtract" ? "subtract" : ""}`} style={tagChipStyle(group.color)} type="button" aria-pressed={active} disabled={Boolean(activeLoading)} key={group.id} onClick={() => onSelect(group, mode)}>
                  <span className="invite-tag-dot" />
                  <span><strong>{tagDisplayName(group.name)}</strong><small>{group.count.toLocaleString()} people</small>{superTagRule ? <small className="invite-tag-rule">{superTagRule}</small> : group.automatic && automaticTagDescriptions[group.ruleKey] ? <small className="invite-tag-rule">{automaticTagDescriptions[group.ruleKey]}</small> : null}</span>
                  {busy ? <RefreshCw className="animate-spin" size={15} /> : active ? <CircleCheck size={16} /> : mode === "subtract" ? <UserMinus size={16} /> : <Plus size={16} />}
                </button>
              );
            })}
          </div>
          {section.searchable && !section.groups.length ? <div className="empty-state compact">No manual tags match “{manualQuery}”.</div> : null}
          {section.id === "supertag" && !section.groups.length ? <div className="empty-state compact">Create supertags in Tag settings to combine related tag and event audiences.</div> : null}
        </section>
      ))}
    </div>
  ) : <div className="empty-state compact">No tag groups have people yet.</div>;
}

function EventAudiencePicker({ events, selections, activeLoading, mode, cohortCounts = {}, countsStatus = "idle", countsError = "", onSelect }) {
  const [query, setQuery] = useState("");
  const [cohort, setCohort] = useState("attended");
  const [visibleCount, setVisibleCount] = useState(20);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const pastEvents = [...sortEvents(events)].reverse().filter((event) => !isUpcoming(event));
  const filteredEvents = pastEvents.filter((event) => !normalizedQuery || `${event.title} ${event.location || ""} ${event.date || ""}`.toLocaleLowerCase().includes(normalizedQuery));
  const visibleEvents = filteredEvents.slice(0, visibleCount);
  const selectedEntries = Object.entries(selections || {}) as Array<[string, any]>;
  useEffect(() => setVisibleCount(20), [normalizedQuery, cohort]);
  const loadMoreEvents = (event) => {
    const gallery = event.currentTarget;
    if (gallery.scrollHeight - gallery.clientHeight - gallery.scrollTop > 180 || visibleCount >= filteredEvents.length) return;
    setVisibleCount((current) => Math.min(current + 15, filteredEvents.length));
  };
  return (
    <section className="invite-event-groups">
      <div className="invite-event-browser">
        <div className="invite-event-browser-head">
          <div className="invite-event-groups-head"><strong>Past event groups</strong><span>Choose a historical audience.</span></div>
          <small>{filteredEvents.length.toLocaleString()} historical event{filteredEvents.length === 1 ? "" : "s"}</small>
        </div>
        <label className="invite-event-search"><Search size={15} aria-hidden="true" /><input type="search" value={query} placeholder="Search historical events" onChange={(event) => setQuery(event.target.value)} />{query ? <button type="button" aria-label="Clear event search" onClick={() => setQuery("")}><X size={14} /></button> : null}</label>
        <div className="invite-event-filter-row">
          <div className="invite-event-cohort-tabs" aria-label="Event group type">
            <button className={cohort === "attended" ? "active" : ""} type="button" onClick={() => setCohort("attended")}>Attended</button>
            <button className={cohort === "registered" ? "active" : ""} type="button" onClick={() => setCohort("registered")}>Registered</button>
            <button className={cohort === "invited" ? "active" : ""} type="button" onClick={() => setCohort("invited")}>Invited</button>
          </div>
          <small>{countsStatus === "loading" ? "Loading audience counts…" : countsStatus === "refreshing" ? "Refreshing audience counts…" : countsError || "Showing 15 at a time"}</small>
        </div>
        <div className="invite-event-gallery" onScroll={loadMoreEvents}>
          {visibleEvents.map((event) => {
            const active = selections?.[event.id]?.cohort === cohort;
            const busy = activeLoading === `${mode}:${event.id}:${cohort}`;
            const count = eventCohortCount(event, cohort, cohortCounts[event.id]);
            return (
              <button className={`invite-event-tile ${active ? "active" : ""}`} type="button" disabled={Boolean(activeLoading)} aria-pressed={active} key={event.id} onClick={() => onSelect(event, cohort, mode)}>
                <EventArtwork event={event} />
                <span className="invite-event-tile-copy"><strong>{event.title}</strong><small>{formatDate(event.date)}</small><span>{count !== null ? count.toLocaleString() : "—"} <small>{cohort}</small></span></span>
                <span className="invite-event-tile-action">{busy ? <RefreshCw className="animate-spin" size={15} /> : active ? <CircleCheck size={16} /> : mode === "subtract" ? <UserMinus size={16} /> : <Plus size={16} />}</span>
              </button>
            );
          })}
          {!visibleEvents.length ? <div className="empty-state compact">No historical events match “{query}”.</div> : null}
          {visibleEvents.length < filteredEvents.length ? <div className="invite-event-gallery-more" aria-hidden="true"><span className="loading-spinner" /> Scroll for more events</div> : null}
        </div>
      </div>
      {selectedEntries.length ? (
        <div className="invite-event-selected" aria-label="Selected event groups">
          {selectedEntries.map(([eventId, selection]) => {
            const event = events.find((item) => item.id === eventId);
            if (!event) return null;
            return <button type="button" key={eventId} onClick={() => onSelect(event, selection.cohort, mode)}><CircleCheck size={13} /><span>{event.title}</span><small>{selection.cohort}</small><X size={12} /></button>;
          })}
        </div>
      ) : null}
    </section>
  );
}

function eventCohortCount(event, cohort, indexedCounts: any = null) {
  if (Number.isFinite(Number(indexedCounts?.[cohort]))) return Number(indexedCounts[cohort]);
  const stats = event.guestStats;
  if (cohort === "attended" && Number.isFinite(Number(stats?.checkedIn))) return Number(stats.checkedIn);
  if (cohort === "registered" && Number.isFinite(Number(stats?.registered))) return Number(stats.registered);
  if (cohort === "invited" && Number.isFinite(Number(stats?.invited))) return Number(stats.invited);
  if (!event.guestsLoaded) return null;
  return event.guests.filter((guest) => {
    if (cohort === "attended") return guest.status === "checked_in" || Boolean(guest.checkedInAt);
    if (cohort === "invited") return hasInvitationEvidence(guest);
    return isRegisteredGuest(guest);
  }).length;
}

function InvitePersonTags({ person, definitions }) {
  const tags = orderedPersonTags(person);
  if (!tags.length) return <span className="person-email">No tags</span>;
  return <div className="invite-person-tags">{tags.slice(0, 2).map((tag) => {
    const definition = tagDefinitionForName(definitions, tag);
    return <span className="tag-chip" style={tagChipStyle(definition.color)} key={tag}>{tagDisplayName(tag)}</span>;
  })}{tags.length > 2 ? <span className="tag-chip tag-chip-more">+{tags.length - 2}</span> : null}</div>;
}

function ManualAudienceSearch({ mode, selected, request, onMergePeople, onChange }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) { setResults([]); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    const timeout = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: normalized, scope: "name", limit: "8" });
        const response = await request(`/api/search/people?${params.toString()}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to search people.");
        if (!controller.signal.aborted) setResults(data.people || []);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, UNIVERSAL_PEOPLE_SEARCH_DEBOUNCE_MS);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [query]);
  return (
    <div className="manual-audience-search">
      <div className="manual-audience-search-head"><strong>{mode === "add" ? "Add someone manually" : "Subtract someone manually"}</strong><span>{selected.length} selected</span></div>
      <label><Search size={16} /><input type="search" value={query} placeholder="Search by name" onChange={(event) => setQuery(event.target.value)} /></label>
      {query ? <div className="manual-audience-results">{results.map(({ person }) => {
        const active = selected.includes(person.id);
        return <button className={active ? "active" : ""} type="button" key={person.id} onClick={() => { onMergePeople([person]); onChange(active ? selected.filter((id) => id !== person.id) : [...selected, person.id]); setQuery(""); }}><Avatar person={person} /><span><strong>{person.name}</strong><small>{person.email}</small></span>{active ? <CircleCheck size={16} /> : mode === "add" ? <Plus size={16} /> : <UserMinus size={16} />}</button>;
      })}{loading ? <div className="manual-audience-loading">Searching...</div> : null}</div> : null}
    </div>
  );
}

function InviteMarkdownEditor({ value, templateId, onChange, onTemplateChange }) {
  const [mode, setMode] = useState("write");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const formatSelection = ({ before = "", after = "", placeholder = "text", linePrefix = "" }) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = value.slice(start, end) || placeholder;
    const formatted = linePrefix ? selected.split("\n").map((line) => `${linePrefix}${line}`).join("\n") : `${before}${selected}${after}`;
    const next = `${value.slice(0, start)}${formatted}${value.slice(end)}`.slice(0, MAX_INVITE_MESSAGE_LENGTH);
    onChange(next);
    window.requestAnimationFrame(() => textarea.focus());
  };
  const actions = [
    { label: "Bold", icon: Bold, format: { before: "**", after: "**", placeholder: "bold text" } },
    { label: "Italic", icon: Italic, format: { before: "_", after: "_", placeholder: "italic text" } },
    { label: "Link", icon: Link2, format: { before: "[", after: "](https://)", placeholder: "link text" } },
    { label: "List", icon: List, format: { linePrefix: "- ", placeholder: "list item" } },
  ];
  return (
    <div className="invite-message-editor">
      <div className="invite-message-options"><label>Template<select value={templateId} onChange={(event) => onTemplateChange(event.target.value)}><option value="">Custom message</option>{inviteMessageTemplates.map((template) => <option value={template.id} key={template.id}>{template.label}</option>)}</select></label><div className="guest-note-tabs"><button className={mode === "write" ? "active" : ""} type="button" onClick={() => setMode("write")}>Write</button><button className={mode === "preview" ? "active" : ""} type="button" onClick={() => setMode("preview")}>Preview</button></div></div>
      {mode === "write" ? <div className="guest-note-editor invite-message-textarea"><div className="markdown-toolbar">{actions.map(({ label, icon: Icon, format }) => <button type="button" title={label} aria-label={label} key={label} onClick={() => formatSelection(format)}><Icon size={15} /></button>)}<span>Markdown</span></div><textarea ref={textareaRef} rows={10} maxLength={MAX_INVITE_MESSAGE_LENGTH} value={value} placeholder="Write a personal invitation..." onChange={(event) => onChange(event.target.value)} /></div> : <div className={`markdown-preview invite-message-preview ${value.trim() ? "" : "empty"}`}>{value.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown> : <p>Your invitation preview will appear here.</p>}</div>}
      <div className="invite-message-count">{value.length}/{MAX_INVITE_MESSAGE_LENGTH}</div>
    </div>
  );
}

function LegacyInviteTab({
  state,
  audience,
  targetEvent,
  targetEvents,
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
          <h2>{targetEvents.length > 1 ? `${targetEvents.length} events` : targetEvent?.title || "Select an event"}</h2>
        </div>
        <div className="invite-send-summary">
          <span><strong>{audience.length}</strong> recipients</span>
          <button className="button primary" type="button" disabled={!audience.length || !targetEvents.length} onClick={onSend}>
            <Send size={16} aria-hidden="true" />
            {targetEvents.length > 1 ? `Send to ${targetEvents.length} events` : "Send invites"}
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

function AnalyticsTab({ event, analytics, loading = false, uniquePeople = false, onOpenPerson, onOpenRespondents, onFilter }) {
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
  const invitationOutcomes = analytics.invitationOutcomes || { total: 0, checkedIn: 0, noShow: 0, noResponse: 0, declined: 0, referralTotal: 0, referralCheckedIn: 0, referralNoShow: 0, referralNoResponse: 0, referralDeclined: 0 };
  const acceptedInvitations = invitationOutcomes.checkedIn + invitationOutcomes.noShow;
  const invitationOutcomeItems = [
    { id: "no-response", label: "No response", value: invitationOutcomes.noResponse, filter: "invited_no_response", referrals: invitationOutcomes.referralNoResponse, referralFilter: "invited_referral_no_response", segments: null },
    {
      id: "accepted",
      label: "Accepted",
      value: acceptedInvitations,
      filter: "invited_accepted",
      referrals: invitationOutcomes.referralCheckedIn + invitationOutcomes.referralNoShow,
      referralFilter: "invited_referral_accepted",
      segments: [
        { id: "checked-in", label: "Checked in", value: invitationOutcomes.checkedIn, filter: "invited_checked_in" },
        { id: "no-show", label: "No-show", value: invitationOutcomes.noShow, filter: "invited_no_show" },
      ],
    },
    { id: "declined", label: "Declined", value: invitationOutcomes.declined, filter: "invited_declined", referrals: invitationOutcomes.referralDeclined, referralFilter: "invited_referral_declined", segments: null },
  ];
  const invitationFunnel = [
    { id: "total", label: "Total invitations", value: invitationOutcomes.total, filter: "invited", referrals: invitationOutcomes.referralTotal, referralFilter: "invited_referrals", rate: invitationOutcomes.total ? 100 : 0, width: invitationOutcomes.total ? 100 : 0, segments: null },
    ...invitationOutcomeItems.map((outcome) => {
      const rate = invitationOutcomes.total ? Math.round((outcome.value / invitationOutcomes.total) * 100) : 0;
      return { ...outcome, rate, width: invitationOutcomes.total ? Math.max(outcome.value ? 18 : 8, rate) : 0 };
    }),
  ];
  const registrationReferralTotal = Number(analytics.referredCheckedIn) || 0;
  const registrationTotal = Number(analytics.registrations) || 0;
  const registrationReferralRate = registrationTotal ? Math.round((registrationReferralTotal / registrationTotal) * 100) : 0;
  const registrationFunnel = [
    ...analytics.funnel.map((stage) => {
      if (stage.id === "registered") {
        return { ...stage, filter: "registered", overlay: { label: "New registrations", value: Number(analytics.newRegistrations) || 0, filter: "first_registers" } };
      }
      if (stage.id === "accepted") {
        return { ...stage, filter: "accepted", overlay: { ...stage.overlay, label: "New registrations", filter: "accepted_first_registers" } };
      }
      return { ...stage, filter: "checked_in", overlay: { ...stage.overlay, filter: "new_faces" } };
    }),
    {
      id: "referrals",
      label: "Referrals",
      value: registrationReferralTotal,
      rate: registrationReferralRate,
      width: registrationTotal ? Math.max(registrationReferralTotal ? 8 : 0, registrationReferralRate) : 0,
      filter: "referrals",
      overlay: { label: "New referrals", value: Number(analytics.newReferrals) || 0, filter: "new_referrals" },
    },
  ];
  return (
    <section className="analytics-tab panel" role="tabpanel" aria-label="Analytics">
      <header className="event-tab-heading">
        <div><p className="eyebrow">Event analytics</p><h2>{event.title}</h2></div>
        <span className="analytics-sample">{analytics.registrations} {uniquePeople ? "unique registrants" : "registrations"}</span>
      </header>

      <div className="analytics-overview-grid">
        <article className="analytics-card invitation-funnel-card">
          <div className="chart-heading"><div><p className="eyebrow">Invitations</p><h3><Send size={17} aria-hidden="true" /> Invitation outcomes</h3></div></div>
          <ol className="funnel-chart invitation-funnel-chart">
            {invitationFunnel.map((stage) => (
              <li className={`invitation-stage-${stage.id}`} key={stage.id} aria-label={`${stage.label}: ${stage.value}`}>
                <span className="invitation-stage-content">
                  <span className="invitation-stage-copy">
                    <button className="analytics-funnel-filter invitation-stage-primary" type="button" onClick={() => onFilter(stage.filter)}>
                      <strong>{stage.value}</strong><small>{stage.label}</small>
                    </button>
                    {stage.referrals ? (
                      <button className="analytics-funnel-filter invitation-referrals" type="button" onClick={() => onFilter(stage.referralFilter)}>
                        <Gem size={11} aria-hidden="true" /><strong>{stage.referrals}</strong><small>Referrals</small>
                      </button>
                    ) : null}
                  </span>
                  <button className="analytics-funnel-filter invitation-stage-bar-row" type="button" aria-label={`View ${stage.label}: ${stage.value}`} onClick={() => onFilter(stage.filter)}>
                    <span className="invitation-stage-track" aria-hidden="true">
                      <i style={{ width: `${stage.width}%` }} />
                    </span>
                    <em>{stage.rate}%</em>
                  </button>
                  {stage.segments ? (
                    <span className="invitation-stage-breakdown">
                      {stage.segments.map((segment) => (
                        <button className="analytics-funnel-filter" type="button" key={segment.id} onClick={() => onFilter(segment.filter)}>
                          <strong>{segment.value}</strong>
                          <small>{segment.label}</small>
                        </button>
                      ))}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        </article>

        <article className="analytics-card funnel-card">
          <div className="chart-heading"><div><p className="eyebrow">Conversion</p><h3><BarChart3 size={17} aria-hidden="true" /> Registration funnel</h3></div></div>
          <ol className="funnel-chart registration-funnel-chart">
            {registrationFunnel.map((stage) => (
              <li className={`registration-stage-${stage.id}`} key={stage.id} aria-label={`${stage.label}: ${stage.value}${stage.overlay ? `; ${stage.overlay.label}: ${stage.overlay.value}` : ""}`}>
                <span className="registration-stage-content">
                  <span className="registration-stage-copy">
                    <button className="analytics-funnel-filter registration-stage-primary" type="button" onClick={() => onFilter(stage.filter)}>
                      <strong>{stage.value}</strong><small>{stage.label}</small>
                    </button>
                    {stage.overlay ? (
                      <button className="analytics-funnel-filter registration-stage-secondary" type="button" onClick={() => onFilter(stage.overlay.filter)}>
                        <strong>{stage.overlay.value}</strong>
                        <small>{stage.overlay.label}</small>
                      </button>
                    ) : null}
                  </span>
                  <button className="analytics-funnel-filter registration-stage-bar-row" type="button" aria-label={`View ${stage.label}: ${stage.value}`} onClick={() => onFilter(stage.filter)}>
                    <span className="registration-stage-track" aria-hidden="true">
                      <i style={{ width: `${stage.width}%` }} />
                    </span>
                    <em>{stage.rate}%</em>
                  </button>
                </span>
              </li>
            ))}
          </ol>
        </article>
      </div>

      <section className="answer-analytics">
        <div className="event-tab-heading compact">
          <div><p className="eyebrow">First Registers</p><h2>Registration answers</h2></div>
          <span className="analytics-sample">{analytics.newRegistrations} first registers</span>
        </div>
        {analytics.questions.length ? (
          <div className="question-grid">
            {analytics.questions.map((question) => (
              <article className="question-chart" key={question.id}>
                {question.kind === "categorical" ? (
                  <button
                    className="question-chart-head question-chart-head-button"
                    type="button"
                    aria-label={`View all ${question.responseCount} respondents for ${question.label}`}
                    onClick={() => onOpenRespondents(question)}
                  >
                    <h3>{question.label}</h3>
                    <span><Users size={14} aria-hidden="true" />{question.responseCount} responses</span>
                  </button>
                ) : (
                  <div className="question-chart-head"><h3>{question.label}</h3><span>{question.responseCount} responses</span></div>
                )}
                {question.kind === "categorical" ? (
                  <div className="bar-chart">
                    {question.options.map((option) => (
                      <button
                        className="bar-row"
                        type="button"
                        aria-label={`View ${option.count} respondents who selected ${option.label}`}
                        key={option.label}
                        onClick={() => onOpenRespondents(question, option)}
                      >
                        <span title={option.label}>{option.label}</span>
                        <div><i style={{ width: `${option.percent}%` }} /></div>
                        <strong>{option.count}</strong>
                      </button>
                    ))}
                  </div>
                ) : (
                  <InfiniteQuestionResponses question={question} onOpenPerson={onOpenPerson} />
                )}
              </article>
            ))}
          </div>
        ) : <div className="empty-state">No registration answers from first registers are available for this event.</div>}
      </section>
    </section>
  );
}

function InfiniteQuestionResponses({ question, onOpenPerson }) {
  const responses = Array.isArray(question.responses) ? question.responses : [];
  const responseKey = responses.map((response) => response.id).join("\u0000");
  const paginationKey = `${question.id}\u0000${responseKey}`;
  const [pagination, setPagination] = useState({ key: paginationKey, visibleCount: QUESTION_RESPONSE_BATCH_SIZE });
  const visibleCount = pagination.key === paginationKey ? pagination.visibleCount : QUESTION_RESPONSE_BATCH_SIZE;
  const shownResponses = responses.slice(0, visibleCount);
  const hasMore = visibleCount < responses.length;

  const loadMore = () => {
    setPagination((current) => ({
      key: paginationKey,
      visibleCount: Math.min(
        responses.length,
        (current.key === paginationKey ? current.visibleCount : QUESTION_RESPONSE_BATCH_SIZE) + QUESTION_RESPONSE_BATCH_SIZE,
      ),
    }));
  };

  return (
    <div
      className="text-response-list"
      tabIndex={hasMore ? 0 : undefined}
      aria-label={`${question.label} responses. Showing ${shownResponses.length} of ${responses.length}.`}
      onScroll={(event) => {
        if (!hasMore) return;
        const list = event.currentTarget;
        if (list.scrollHeight - list.scrollTop - list.clientHeight <= 48) loadMore();
      }}
    >
      {shownResponses.map((response) => (
        <button
          className="text-response-item"
          type="button"
          aria-label={`Open guest who answered: ${response.value}`}
          key={response.id}
          onClick={() => onOpenPerson(response.personId)}
        >
          <span>{response.value}</span>
          <Eye size={14} aria-hidden="true" />
        </button>
      ))}
      {hasMore ? (
        <button className="text-response-more" type="button" onClick={loadMore}>
          Show 10 more <span>{shownResponses.length} of {responses.length}</span>
        </button>
      ) : null}
    </div>
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

function ProfilePanel({ state, person, trace, lumaCheckInGuestKey, reinvitingGuestKey, onGuestAction, onTraceActivity, onSelectEvent, onAvatarClick, onClose }) {
  const [activityFilters, setActivityFilters] = useState(() => activityFilterOptions.map((option) => option.status));
  const [collapsedAnswerEvents, setCollapsedAnswerEvents] = useState<Set<string>>(() => new Set());
  const activityMenuRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    setCollapsedAnswerEvents(new Set());
  }, [person?.id]);

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
        {currentRecord ? (
          <>
            <ProfileContext record={currentRecord} />
            <ProfileGuestActions
              record={currentRecord}
              person={person}
              lumaCheckInGuestKey={lumaCheckInGuestKey}
              reinvitingGuestKey={reinvitingGuestKey}
              onAction={onGuestAction}
            />
          </>
        ) : null}

        {person.crmNotes?.trim() ? (
          <details className="profile-disclosure" open>
            <summary>✍️ Notes</summary>
            <section className="profile-section">
              <article className="profile-note-card">
                <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
                  {person.crmNotes}
                </ReactMarkdown>
                {person.crmNotesUpdatedAt ? (
                  <time dateTime={person.crmNotesUpdatedAt}>Updated {formatProfileDateTime(person.crmNotesUpdatedAt)}</time>
                ) : null}
              </article>
            </section>
          </details>
        ) : null}

        {answerGroups.length || answerGroupsLoading ? (
          <details className="profile-disclosure" open>
            <summary>Registration answers</summary>
            <section className="profile-section">
              {answerGroups.length ? answerGroups.map((group) => (
                  <article
                    className={collapsedAnswerEvents.has(group.event.id) ? "answer-card collapsed" : "answer-card"}
                    key={group.event.id}
                  >
                    <div className="answer-card-head">
                      <button
                        className="answer-card-event plain"
                        type="button"
                        aria-label={`Open ${group.event.title}`}
                        onClick={() => onSelectEvent(group.event.id, { preserveProfile: true })}
                      >
                        <strong>{group.event.title}</strong>
                        <span>{formatDate(group.event.date)} <ArrowRight size={12} aria-hidden="true" /></span>
                      </button>
                      <button
                        className="answer-card-toggle icon-button"
                        type="button"
                        aria-expanded={!collapsedAnswerEvents.has(group.event.id)}
                        aria-label={`${collapsedAnswerEvents.has(group.event.id) ? "Expand" : "Collapse"} answers for ${group.event.title}`}
                        title={`${collapsedAnswerEvents.has(group.event.id) ? "Expand" : "Collapse"} answers`}
                        onClick={() => {
                          setCollapsedAnswerEvents((current) => {
                            const next = new Set(current);
                            if (next.has(group.event.id)) next.delete(group.event.id);
                            else next.add(group.event.id);
                            return next;
                          });
                        }}
                      >
                        <ChevronDown
                          className={collapsedAnswerEvents.has(group.event.id) ? "answer-card-chevron collapsed" : "answer-card-chevron"}
                          size={15}
                          aria-hidden="true"
                        />
                      </button>
                    </div>
                    {!collapsedAnswerEvents.has(group.event.id) ? (
                      <dl className="answer-list">
                        {group.answers.map((answer) => (
                          <div className="answer-row" key={answer.id + answer.label}>
                            <dt>{answer.label}</dt>
                            <dd><RegistrationAnswerValue value={answer.value} /></dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
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

function RegistrationAnswerValue({ value }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      allowedElements={["a", "p", "br"]}
      unwrapDisallowed
      skipHtml
      components={{
        a: ({ href, children }) => {
          const safeHref = safeExternalHttpUrl(href);
          return safeHref ? (
            <a href={safeHref} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ) : <>{children}</>;
        },
      }}
    >
      {String(value ?? "")}
    </ReactMarkdown>
  );
}

function safeExternalHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function ProfileContext({ record }) {
  const referrer = record.guest.referrer;
  return (
    <div className="profile-context">
      {record.guest.registeredAt ? <ProfileFact label="Registration time" value={formatProfileDateTime(record.guest.registeredAt)} tone="registration" /> : null}
      {referrerLabel(referrer) ? <ProfileFact label="Referrer" value={<ReferrerValue referrer={referrer} />} tone="referrer" /> : null}
    </div>
  );
}

function ProfileGuestActions({ record, person, lumaCheckInGuestKey, reinvitingGuestKey, onAction }) {
  const actions = actionsForStatus(record.guest.status, record.event);
  if (!actions.length) return null;
  const actionKey = `${record.event.id}:${person.id}`;
  return (
    <div className="profile-guest-actions" aria-label={`Registration actions for ${person.name}`}>
      {actions.map(([label, status]) => {
        const actionBusy = lumaCheckInGuestKey === actionKey || (label === "Reinvite" && reinvitingGuestKey === actionKey);
        const ActionIcon = actionBusy ? RefreshCw : guestActionIcons[label];
        return (
          <button
            className={`guest-action guest-action-${status}`}
            type="button"
            key={status}
            disabled={actionBusy}
            onClick={() => onAction(person.id, status, label, record.event.id)}
          >
            <ActionIcon className={actionBusy ? "animate-spin" : undefined} aria-hidden="true" size={14} strokeWidth={2.25} />
            <span>{actionBusy && label === "Reinvite" ? "Sending..." : label}</span>
          </button>
        );
      })}
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

function ReferrerValue({ referrer }) {
  const label = referrerPrimaryLabel(referrer);
  const fullLabel = referrerLabel(referrer);
  if (!label) return <span className="referrer-empty">-</span>;

  const href = typeof referrer === "object" && referrer ? safeExternalHttpUrl(referrer.url) : "";
  const avatarUrl = typeof referrer === "object" && referrer ? safeExternalHttpUrl(referrer.avatarUrl || referrer.avatar_url) : "";
  const tintColor = typeof referrer === "object" && referrer && /^#[0-9a-f]{3,8}$/i.test(referrer.tintColor || referrer.tint_color || "")
    ? referrer.tintColor || referrer.tint_color
    : "";
  const logoStyle = {
    ...(tintColor ? { backgroundColor: tintColor } : {}),
    width: 18,
    height: 18,
    minWidth: 18,
    flex: "0 0 18px",
  };
  const content = (
    <>
      {avatarUrl ? (
        <span className="referrer-logo" style={logoStyle} aria-hidden="true">
          <img
            src={avatarUrl}
            alt=""
            style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }}
            onError={(event) => void (event.currentTarget.parentElement?.setAttribute("hidden", ""))}
          />
        </span>
      ) : null}
      <span className="referrer-value-label" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {href ? <ExternalLink size={11} aria-hidden="true" /> : null}
    </>
  );

  return href ? (
    <a className="referrer-value" href={href} target="_blank" rel="noopener noreferrer" title={fullLabel} aria-label={fullLabel}>
      {content}
    </a>
  ) : (
    <span className="referrer-value" title={fullLabel} aria-label={fullLabel}>{content}</span>
  );
}

function hasPrivateReferrerDetails(referrer) {
  return Boolean(referrer && typeof referrer === "object" && Number(referrer.detailsVersion) >= 1);
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

function EventArtworkDeck({ events }) {
  return (
    <div className="event-artwork-deck" aria-label={`Artwork from ${events.length} selected events`}>
      {events.map((event, index) => (
        <div className="event-artwork-deck-card" style={{ "--deck-index": index } as CSSProperties} key={event.id}>
          <EventArtwork event={event} large />
        </div>
      ))}
    </div>
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
  const tags = orderedPersonTags(person);
  if (!tags.length) return null;

  return (
    <div className="profile-tags" aria-label="Guest tags">
      {tags.map((tag) => {
        const definition = tagDefinitionForName(definitions, tag);
        return (
          <span className="tag-chip" style={tagChipStyle(definition.color)} key={tag}>
            {tagDisplayName(tag)}
          </span>
        );
      })}
    </div>
  );
}

function BulkTagMenu({ definitions, people, allMatching = false, submitting, onApply }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState("add");
  const [query, setQuery] = useState("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  const inputRef = useRef(null);
  const [popoverPosition, setPopoverPosition] = useState({ left: 0, top: 0 });
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const presenceByTagId = new Map(
    definitions.map((definition) => [
      definition.id,
      people.filter((person) => (Array.isArray(person.manualTags) ? person.manualTags : [])
        .some((tag) => tag.toLocaleLowerCase() === definition.name.toLocaleLowerCase())).length,
    ]),
  );
  const options = definitions.filter((definition) => {
    if (definition.managed) return false;
    if (normalizedQuery && !definition.name.toLocaleLowerCase().includes(normalizedQuery)) return false;
    if (allMatching) return true;
    const presence = Number(presenceByTagId.get(definition.id)) || 0;
    return mode === "remove" ? presence > 0 : presence < people.length;
  });

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event) => {
      if (!triggerRef.current?.contains(event.target) && !popoverRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const placePopover = () => {
      const trigger = triggerRef.current.getBoundingClientRect();
      const width = Math.min(300, window.innerWidth - 32);
      const height = popoverRef.current?.offsetHeight || 320;
      const below = window.innerHeight - trigger.bottom;
      setPopoverPosition({
        left: Math.max(16, Math.min(trigger.left, window.innerWidth - width - 16)),
        top: below >= height + 12 ? trigger.bottom + 6 : Math.max(8, trigger.top - height - 6),
      });
    };
    placePopover();
    window.requestAnimationFrame(placePopover);
    window.addEventListener("resize", placePopover);
    return () => window.removeEventListener("resize", placePopover);
  }, [open, options.length]);

  useEffect(() => {
    if (!people.length) setOpen(false);
  }, [people.length]);

  const selectMode = (nextMode) => {
    setMode(nextMode);
    setSelectedTagIds([]);
    setQuery("");
  };

  const toggleTag = (tagId) => {
    setSelectedTagIds((current) => current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId]);
  };

  const applyTags = async () => {
    if (!selectedTagIds.length || submitting) return;
    const saved = await onApply(selectedTagIds, mode === "remove");
    if (!saved) return;
    setSelectedTagIds([]);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className="bulk-tag-control" ref={triggerRef}>
      <button
        className={`bulk-tag-trigger ${open ? "active" : ""}`}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={submitting}
        onClick={() => setOpen((current) => !current)}
      >
        <Tag size={15} aria-hidden="true" />
        <span>Tags</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? createPortal(
        <div className="bulk-tag-popover" ref={popoverRef} style={popoverPosition} role="dialog" aria-label="Bulk edit tags">
          <div className="bulk-tag-mode" role="group" aria-label="Tag action">
            <button className={mode === "add" ? "active" : ""} type="button" onClick={() => selectMode("add")}>Add</button>
            <button className={mode === "remove" ? "active" : ""} type="button" onClick={() => selectMode("remove")}>Remove</button>
          </div>
          <label className="bulk-tag-search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={inputRef}
              type="search"
              aria-label="Find a tag"
              placeholder="Find a tag"
              value={query}
              disabled={submitting}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="bulk-tag-options" role="group" aria-label={`${mode === "add" ? "Add" : "Remove"} tags`}>
            {options.map((definition) => {
              const selected = selectedTagIds.includes(definition.id);
              const presence = Number(presenceByTagId.get(definition.id)) || 0;
              return (
                <button
                  className={`bulk-tag-option ${selected ? "selected" : ""}`}
                  type="button"
                  role="checkbox"
                  aria-checked={selected}
                  disabled={submitting}
                  key={definition.id}
                  onClick={() => toggleTag(definition.id)}
                >
                  <span className="tag-option-color" style={{ backgroundColor: definition.color }} aria-hidden="true" />
                  <span>{tagDisplayName(definition.name)}</span>
                  <small>{allMatching ? "All matching" : `${presence}/${people.length}`}</small>
                  <CircleCheck size={16} aria-hidden="true" />
                </button>
              );
            })}
            {!options.length ? (
              <div className="bulk-tag-empty">
                {normalizedQuery
                  ? "No matching tags"
                  : mode === "remove"
                    ? "No removable tags"
                    : "All tags already applied"}
              </div>
            ) : null}
          </div>
          <div className="bulk-tag-footer">
            <span>{selectedTagIds.length} selected</span>
            <button className="button primary" type="button" disabled={!selectedTagIds.length || submitting} onClick={() => void applyTags()}>
              {submitting ? <RefreshCw className="animate-spin" size={14} aria-hidden="true" /> : mode === "remove" ? <X size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
              {mode === "remove" ? "Remove" : "Add"}
            </button>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function PersonTags({ person, definitions, open, saving, onOpen, onClose, onChange, onCreate }) {
  const tags = orderedPersonTags(person);
  const automaticTags = new Set((Array.isArray(person.automaticTags) ? person.automaticTags : []).map((tag) => tag.toLocaleLowerCase()));
  const visibleTags = tags.slice(0, 2);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [pickerPosition, setPickerPosition] = useState({ left: 0, top: 0 });
  const triggerRef = useRef(null);
  const pickerRef = useRef(null);
  const inputRef = useRef(null);
  const normalizedQuery = cleanTagName(query).toLocaleLowerCase();
  const selectedTagNames = new Set(tags.map((tag) => tag.toLocaleLowerCase()));
  const matchingDefinitions = definitions
    .map((tag, index) => ({ tag, index }))
    .filter(({ tag }) => tag.name.toLocaleLowerCase().includes(normalizedQuery))
    .sort((left, right) => {
      const leftName = left.tag.name.toLocaleLowerCase();
      const rightName = right.tag.name.toLocaleLowerCase();
      const leftPriority = selectedTagNames.has(leftName) ? (automaticTags.has(leftName) ? 1 : 0) : 2;
      const rightPriority = selectedTagNames.has(rightName) ? (automaticTags.has(rightName) ? 1 : 0) : 2;
      return leftPriority - rightPriority || left.index - right.index;
    })
    .map(({ tag }) => tag);
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
    setActiveIndex(0);
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
    const saved = await onChange(nextTags, { tagId: option.tag.id, removed: selected });
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
            return (
              <span className="tag-chip" style={tagChipStyle(definition.color)} key={tag}>
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
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
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
  if (!response.ok || data.ok === false) {
    const error: any = new Error(withRequestId(data.error || data.message || "Luma request failed.", data.requestId));
    error.code = data.code;
    throw error;
  }
  return data;
}

function normalizeLumaSessionTokenInput(value) {
  const token = String(value || "").trim();
  const headerMatch = token.match(/^x-luma-auth-session\s*:\s*(.+)$/i);
  return (headerMatch?.[1] || token).trim();
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
    const previousGuestsByPersonId = new Map(event.guests.map((guest) => [guest.personId, guest]));
    const guestsByPersonId = new Map((append ? event.guests : []).map((guest) => [guest.personId, guest]));
    const nextDisplayOrder = append
      ? Math.max(-1, ...event.guests.map((guest) => Number.isFinite(guest._displayOrder) ? guest._displayOrder : -1)) + 1
      : 0;
    (lumaData.guests || []).forEach((guest, index) => {
      const existingGuest: any = previousGuestsByPersonId.get(guest.personId);
      guestsByPersonId.set(guest.personId, {
        ...existingGuest,
        ...guest,
        ...(guest.eventCounts == null && existingGuest?.eventCounts
          ? { eventCounts: existingGuest.eventCounts }
          : {}),
        _displayOrder: Number.isFinite(existingGuest?._displayOrder) ? existingGuest._displayOrder : nextDisplayOrder + index,
      });
    });
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

function mergeLumaMultiEventGuests(current, lumaData, { append = false } = {}) {
  const selectedIds = new Set(Array.isArray(lumaData.eventIds) ? lumaData.eventIds : []);
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

  const incomingGuestsByEvent = new Map();
  const existingDisplayOrders = current.events
    .filter((event) => selectedIds.has(event.id))
    .flatMap((event) => event.guests.map((guest) => guest._displayOrder))
    .filter(Number.isFinite);
  const nextDisplayOrder = append ? Math.max(-1, ...existingDisplayOrders) + 1 : 0;
  const incomingPersonOrder = new Map();
  (lumaData.guests || []).forEach((guest) => {
    if (!incomingPersonOrder.has(guest.personId)) {
      incomingPersonOrder.set(guest.personId, nextDisplayOrder + incomingPersonOrder.size);
    }
    if (!incomingGuestsByEvent.has(guest.eventId)) incomingGuestsByEvent.set(guest.eventId, []);
    incomingGuestsByEvent.get(guest.eventId).push({ ...guest, _displayOrder: incomingPersonOrder.get(guest.personId) });
  });
  const events = current.events.map((event) => {
    if (!selectedIds.has(event.id)) return event;
    const guestsByPersonId = new Map((append ? event.guests : []).map((guest) => [guest.personId, guest]));
    (incomingGuestsByEvent.get(event.id) || []).forEach((guest) => {
      const existingGuest: any = guestsByPersonId.get(guest.personId);
      guestsByPersonId.set(guest.personId, {
        ...guest,
        _displayOrder: Number.isFinite(existingGuest?._displayOrder) ? existingGuest._displayOrder : guest._displayOrder,
      });
    });
    const guests = [...guestsByPersonId.values()];
    return {
      ...event,
      guests,
      guestsLoaded: true,
      guestQueryLoading: false,
      guestSnapshotReady: true,
      guestSnapshotWarming: false,
      guestHistoryLoaded: true,
      guestHistoryLoading: false,
      guestPageInfo: null,
      guestQuery: lumaData.query || null,
    };
  });
  const people = [...peopleById.values()];

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

  const existingEventsById = new Map(current.events.map((event) => [event.id, event]));
  const events = lumaData.events.map((event) => mergeIndexedEventState(existingEventsById.get(event.id), event));
  const preferredEventId = preferredEventIdForView(events, current.filters.event);
  const currentSelectedEvent = events.find((event) => event.id === current.selectedEventId);
  const keepCurrentSelection = Boolean(currentSelectedEvent && eventMatchesView(currentSelectedEvent, current.filters.event));
  const selectedEventId = keepCurrentSelection ? current.selectedEventId : preferredEventId;

  return normalizeState({
    ...current,
    source: "luma",
    loadedAt: lumaData.loadedAt,
    events,
    people,
    selectedEventId,
    selectedEventIds: keepCurrentSelection
      ? (current.selectedEventIds || []).filter((eventId) => events.some((event) => event.id === eventId))
      : selectedEventId ? [selectedEventId] : [],
    selectedPersonId: people.some((person) => person.id === current.selectedPersonId) ? current.selectedPersonId : people[0]?.id || "",
    invite: {
      ...current.invite,
      targetEventId: events.some((event) => event.id === current.invite.targetEventId) ? current.invite.targetEventId : preferredEventIdForView(events, "upcoming"),
      sourceEventId: events.some((event) => event.id === current.invite.sourceEventId) ? current.invite.sourceEventId : events[0]?.id || "",
    },
  });
}

function mergeLumaEventCatalogState(current, lumaData) {
  const incomingEvents = Array.isArray(lumaData.events) ? lumaData.events : [];
  const incomingEventIds = new Set(incomingEvents.map((event) => event.id));
  const events = lumaData.truncated
    ? [...incomingEvents, ...current.events.filter((event) => event.source !== "luma" || !incomingEventIds.has(event.id))]
    : incomingEvents;
  return mergeLumaState(current, {
    ...lumaData,
    events,
    people: current.people,
  });
}

function mergeIndexedEventState(existing, incoming) {
  if (!existing || existing.source !== "luma") return incoming;
  const runtimeKeys = [
    "guests",
    "guestsLoaded",
    "guestLoadTruncated",
    "guestStats",
    "guestAnalyticsQuestions",
    "analyticsLoaded",
    "analyticsLoading",
    "guestSnapshotReady",
    "guestSnapshotWarming",
    "guestHistoryLoaded",
    "guestHistoryLoading",
    "guestPageInfo",
    "guestQuery",
    "guestQueryLoading",
  ];
  const runtimeState = Object.fromEntries(
    runtimeKeys
      .filter((key) => existing[key] !== undefined)
      .map((key) => [key, existing[key]]),
  );
  return { ...existing, ...incoming, ...runtimeState };
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
    next.selectedEventId = preferredEventIdForView(next.events, next.filters.event);
  }
  next.selectedEventIds = unique(Array.isArray(next.selectedEventIds) ? next.selectedEventIds : [])
    .filter((eventId) => next.events.some((event) => event.id === eventId));
  if (!next.selectedEventIds.length && next.selectedEventId) next.selectedEventIds = [next.selectedEventId];
  if (!next.selectedEventIds.includes(next.selectedEventId)) next.selectedEventIds.push(next.selectedEventId);
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

function visibleEvents(state, now = Date.now()) {
  const query = state.filters.globalSearch.trim().toLowerCase();
  const events = sortEvents(state.events)
    .filter((event) => {
      if (state.filters.event === "upcoming") return isUpcoming(event, now);
      if (state.filters.event === "past") return !isUpcoming(event, now);
      return true;
    })
    .filter((event) => {
      if (!query) return true;
      return [event.title, event.category, event.location].some((value) => value.toLowerCase().includes(query));
    });
  return state.filters.event === "past" ? events.reverse() : events;
}

function initialEventWindow(events, filter, selectedEventId = "") {
  if (filter !== "all") return { start: 0, end: Math.min(events.length, EVENT_PAGE_SIZE) };
  const selectedIndex = selectedEventId ? events.findIndex((event) => event.id === selectedEventId) : -1;
  if (selectedIndex >= 0) {
    const start = Math.max(0, Math.min(selectedIndex - 4, events.length - EVENT_PAGE_SIZE));
    return { start, end: Math.min(events.length, start + EVENT_PAGE_SIZE) };
  }
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

function universalSearchResults(state, query, indexedPeople = null) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return { people: [], events: [], groups: [] };

  return {
    people: (indexedPeople === null
      ? state.people
          .map((person) => ({ person, text: personSearchText(state, person), eventId: mostRecentPersonEventId(state, person.id) }))
          .filter(({ text }) => text.includes(normalized))
          .slice(0, 8)
      : indexedPeople.map(({ person, eventId }) => ({ person, eventId, text: personSearchText(state, person) })))
      .map(({ person, eventId, text }) => ({
        type: "person",
        kind: "Person",
        id: person.id,
        eventId,
        person,
        title: person.name,
        subtitle: person.email || "No email",
        tags: orderedPersonTags(person).map((tag) => tagDefinitionForName(state.tagDefinitions, tag)),
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
    ...orderedPersonTags(person),
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

function eventGuests(state, event, dateSortDirection: "asc" | "desc" = "desc") {
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
        || (selectedStatus === "registered" && isRegisteredGuest(guest))
        || (selectedStatus === "invited" && hasInvitationEvidence(guest))
        || (selectedStatus === "first_registers" && isRegisteredGuest(guest) && isFirstRegistration(guest))
        || (selectedStatus === "accepted_first_registers" && isFirstRegister(guest))
        || (selectedStatus === "new_faces" && guest.status === "checked_in" && isFirstRegistration(guest))
        || (selectedStatus === "new_referrals" && guest.isReferred && guest.isNewReferral && registeredStatuses.includes(guest.status))
        || (selectedStatus !== "invited" && guest.status === selectedStatus);
      const matchesSearch = !query || searchableGuestText(person, guest).includes(query);
      return matchesStatus && matchesSearch;
    })
    .sort((left, right) => compareGuestDisplayRowsForFilter(left, right, state.filters.guestStatus, dateSortDirection));
}

function selectedWorkspaceEvents(state) {
  const selectedIds = unique(Array.isArray(state.selectedEventIds) ? state.selectedEventIds : []);
  const events = selectedIds.map((eventId) => getEvent(state, eventId)).filter(Boolean);
  if (events.length) return events;
  const selectedEvent = getEvent(state, state.selectedEventId);
  return selectedEvent ? [selectedEvent] : [];
}

function workspaceEventGuests(state, events, dateSortDirection: "asc" | "desc" = "desc") {
  const guestsByPerson = new Map();
  events.forEach((event) => {
    eventGuests(state, event, dateSortDirection).forEach((row) => {
      const existing = guestsByPerson.get(row.person.id);
      const eventMatches = [...(existing?.eventMatches || []), { event, guest: row.guest }];
      guestsByPerson.set(row.person.id, {
        ...row,
        sourceEvent: event,
        eventCount: eventMatches.length,
        eventMatches,
      });
    });
  });
  return [...guestsByPerson.values()].sort((left, right) => compareGuestDisplayRowsForFilter(left, right, state.filters.guestStatus, dateSortDirection));
}

function compareGuestDisplayRowsForFilter(left, right, filter, dateSortDirection: "asc" | "desc" = "desc") {
  if (filter === "invited") {
    const cohortOrder = invitationCohortDisplayRank(left) - invitationCohortDisplayRank(right);
    if (cohortOrder) return cohortOrder;
  }
  return compareGuestDisplayRows(left, right, dateSortDirection);
}

function invitationCohortDisplayRank(row) {
  const guests = row.eventMatches?.map(({ guest }) => guest) || [row.guest];
  if (guests.some((guest) => acceptedStatuses.includes(guest?.status))) return 0;
  if (guests.some((guest) => guest?.status === "invited")) return 1;
  return 2;
}

function compareGuestDisplayRows(left, right, dateSortDirection: "asc" | "desc" = "desc") {
  const leftOrder = left.guest?._displayOrder;
  const rightOrder = right.guest?._displayOrder;
  if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder) && leftOrder !== rightOrder) return leftOrder - rightOrder;
  if (Number.isFinite(leftOrder) !== Number.isFinite(rightOrder)) return Number.isFinite(leftOrder) ? -1 : 1;
  const dateOrder = dateSortDirection === "asc"
    ? left.statusTimestamp - right.statusTimestamp
    : right.statusTimestamp - left.statusTimestamp;
  return dateOrder
    || left.person.name.localeCompare(right.person.name)
    || left.person.id.localeCompare(right.person.id);
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
  if (typeof referrer === "string") return referrer.trim();
  return unique([referrer.name, referrer.email, referrer.source, referrer.url].filter(Boolean)).join(" - ");
}

function referrerPrimaryLabel(referrer) {
  if (!referrer) return "";
  if (typeof referrer === "string") return referrer.trim();
  return [referrer.name, referrer.source, referrer.email, referrer.url].find(Boolean) || "";
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
    newRegistrations: 0,
    newReferrals: 0,
    newFaces: 0,
    referredRegistrations: 0,
    referredAccepted: 0,
    referredCheckedIn: 0,
    referredReturning: 0,
    referredFirstRegisters: 0,
    invitationOutcomes: { total: 0, checkedIn: 0, noShow: 0, noResponse: 0, declined: 0, referralTotal: 0, referralCheckedIn: 0, referralNoShow: 0, referralNoResponse: 0, referralDeclined: 0 },
    funnel: [
      { id: "registered", label: "Total registrations", value: 0, rate: 0, width: 100 },
      { id: "accepted", label: "Accepted", value: 0, rate: 0, width: 0, overlay: { label: "First Registers", value: 0, width: 0 } },
      { id: "checked-in", label: "Checked in", value: 0, rate: 0, width: 0, overlay: { label: "New Faces", value: 0, width: 0 } },
    ],
    questions: [],
  };
  if (!event) return empty;

  const registrationRows = event.guests
    .filter(isRegisteredGuest)
    .map((guest) => ({
      guest,
      person: getPerson(state, guest.personId),
      history: personHistoryForGuest(state, guest),
    }))
    .filter((row) => row.person);
  const firstRegistrationRows = registrationRows.filter(({ guest }) => isFirstRegistrationAtEvent(state, guest, event));
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
    newRegistrations: firstRegistrationRows.length,
    newReferrals: 0,
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
  const invitationOutcomes = invitationOutcomeCounts(event.guestStats, event.guests.map((guest) => ({
    ...guest,
    isReferred: personHasExactTag(getPerson(state, guest.personId), REFERRED_PERSON_TAG),
  })));
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
    newRegistrations: counts.newRegistrations,
    newReferrals: counts.newReferrals,
    newFaces: counts.newFaces,
    referredRegistrations: counts.referredRegistrations,
    referredAccepted: counts.referredAccepted,
    referredCheckedIn: counts.referredCheckedIn,
    referredReturning: counts.referredReturning,
    referredFirstRegisters: counts.referredFirstRegisters,
    invitationOutcomes,
    funnel: [
      { id: "registered", label: "Total registrations", value: registrations, rate: registrations ? 100 : 0, width: registrations ? 100 : 0, referral: counts.referredRegistrations ? { value: counts.referredRegistrations } : null },
      {
        id: "accepted",
        label: "Accepted",
        value: counts.accepted,
        rate: rate(counts.accepted),
        width: width(counts.accepted),
        overlay: { label: "First Registers", value: counts.firstRegisters, width: subsetWidth(counts.firstRegisters, counts.accepted) },
        referral: counts.referredRegistrations && counts.accepted ? { value: counts.referredAccepted } : null,
      },
      {
        id: "checked-in",
        label: "Checked in",
        value: counts.checkedIn,
        rate: rate(counts.checkedIn),
        width: width(counts.checkedIn),
        overlay: { label: "New Faces", value: counts.newFaces, width: subsetWidth(counts.newFaces, counts.checkedIn) },
        referral: counts.referredRegistrations && counts.checkedIn ? { value: counts.referredCheckedIn } : null,
      },
    ],
    questions,
  };
}

function eventAnalyticsReady(event) {
  return Boolean(event?.analyticsLoaded && event?.guestStats);
}

function eventHeaderStatsReady(event) {
  const stats = event?.guestStats;
  if (!stats) return false;
  return [
    stats.checkedIn,
    stats.accepted ?? stats.confirmed,
    stats.registered,
    stats.pending,
    stats.declined,
    stats.invitedNoResponse,
    stats.invited,
    stats.waitlisted,
    stats.firstRegisters,
    stats.newRegistrations,
    stats.newFaces,
    stats.newReferrals,
  ].every((value) => Number.isFinite(Number(value)));
}

function buildWorkspaceAnalytics(state, events, uniqueStats = null) {
  if (events.length <= 1) return buildEventAnalytics(state, events[0]);
  const analytics = events.map((event) => buildEventAnalytics(state, event));
  const sum = (key) => analytics.reduce((total, item) => total + (Number(item[key]) || 0), 0);
  const registrations = uniqueStats ? Number(uniqueStats.registered) || 0 : sum("registrations");
  const firstRegisters = uniqueStats ? Number(uniqueStats.firstRegisters) || 0 : sum("firstRegisters");
  const newRegistrations = uniqueStats ? Number(uniqueStats.newRegistrations) || 0 : sum("newRegistrations");
  const newFaces = uniqueStats ? Number(uniqueStats.newFaces) || 0 : sum("newFaces");
  const newReferrals = uniqueStats ? Number(uniqueStats.newReferrals) || 0 : sum("newReferrals");
  const accepted = uniqueStats ? Number(uniqueStats.accepted) || 0 : sum("returningAccepted") + firstRegisters;
  const returningAccepted = Math.max(0, accepted - firstRegisters);
  const checkedIn = uniqueStats
    ? Number(uniqueStats.checkedIn) || 0
    : analytics.reduce((total, item) => total + (item.funnel.find((stage) => stage.id === "checked-in")?.value || 0), 0);
  const invitationOutcomes = uniqueStats
    ? invitationOutcomeCounts(uniqueStats, [])
    : {
        total: sumInvitationOutcome(analytics, "total"),
        checkedIn: sumInvitationOutcome(analytics, "checkedIn"),
        noShow: sumInvitationOutcome(analytics, "noShow"),
        noResponse: sumInvitationOutcome(analytics, "noResponse"),
        declined: sumInvitationOutcome(analytics, "declined"),
        referralTotal: sumInvitationOutcome(analytics, "referralTotal"),
        referralCheckedIn: sumInvitationOutcome(analytics, "referralCheckedIn"),
        referralNoShow: sumInvitationOutcome(analytics, "referralNoShow"),
        referralNoResponse: sumInvitationOutcome(analytics, "referralNoResponse"),
        referralDeclined: sumInvitationOutcome(analytics, "referralDeclined"),
      };
  const referredRegistrations = uniqueStats ? Number(uniqueStats.referredRegistrations) || 0 : sum("referredRegistrations");
  const referredAccepted = uniqueStats ? Number(uniqueStats.referredAccepted) || 0 : sum("referredAccepted");
  const referredCheckedIn = uniqueStats ? Number(uniqueStats.referredCheckedIn) || 0 : sum("referredCheckedIn");
  const rate = (value) => registrations ? Math.round((value / registrations) * 100) : 0;
  const width = (value) => registrations ? Math.max(value ? 18 : 0, Math.round((value / registrations) * 100)) : 0;
  const subsetWidth = (value, parent) => parent ? Math.min(100, Math.max(value ? 24 : 0, Math.round((value / parent) * 100))) : 0;
  return {
    registrations,
    returningAccepted,
    firstRegisters,
    newRegistrations,
    newReferrals,
    newFaces,
    referredRegistrations,
    referredAccepted,
    referredCheckedIn,
    referredReturning: uniqueStats ? Number(uniqueStats.referredReturning) || 0 : sum("referredReturning"),
    referredFirstRegisters: uniqueStats ? Number(uniqueStats.referredFirstRegisters) || 0 : sum("referredFirstRegisters"),
    invitationOutcomes,
    funnel: [
      { id: "registered", label: "Total registrations", value: registrations, rate: registrations ? 100 : 0, width: registrations ? 100 : 0, referral: referredRegistrations ? { value: referredRegistrations } : null },
      {
        id: "accepted",
        label: "Accepted",
        value: accepted,
        rate: rate(accepted),
        width: width(accepted),
        overlay: { label: "First Registers", value: firstRegisters, width: subsetWidth(firstRegisters, accepted) },
        referral: referredRegistrations && accepted ? { value: referredAccepted } : null,
      },
      {
        id: "checked-in",
        label: "Checked in",
        value: checkedIn,
        rate: rate(checkedIn),
        width: width(checkedIn),
        overlay: { label: "New Faces", value: newFaces, width: subsetWidth(newFaces, checkedIn) },
        referral: referredRegistrations && checkedIn ? { value: referredCheckedIn } : null,
      },
    ],
    questions: mergeWorkspaceAnalyticsQuestions(analytics.flatMap((item) => item.questions || [])),
  };
}

function sumInvitationOutcome(analytics, key) {
  return analytics.reduce((total, item) => total + (Number(item.invitationOutcomes?.[key]) || 0), 0);
}

function mergeWorkspaceAnalyticsQuestions(questions) {
  const grouped = new Map();
  questions.forEach((question, questionIndex) => {
    const key = `${question.kind}:${question.label}`;
    const current = grouped.get(key) || {
      ...question,
      id: key,
      responseCount: 0,
      options: [],
      responses: [],
    };
    current.responseCount += Number(question.responseCount) || 0;
    if (question.kind === "categorical") {
      const counts = new Map(current.options.map((option) => [option.label, option.count]));
      (question.options || []).forEach((option) => counts.set(option.label, (counts.get(option.label) || 0) + option.count));
      current.options = [...counts.entries()].map(([label, count]) => ({ label, count, percent: 0 }));
    } else {
      current.responses.push(...(question.responses || []).map((response, responseIndex) => ({
        ...response,
        id: `${questionIndex}-${responseIndex}-${response.id || "response"}`,
      })));
    }
    grouped.set(key, current);
  });
  return [...grouped.values()].map((question) => {
    if (question.kind !== "categorical") return question;
    const total = question.options.reduce((sum, option) => sum + option.count, 0);
    return {
      ...question,
      options: sortRegistrationQuestionOptions(question.options
        .map((option) => ({ ...option, percent: total ? Math.round((option.count / total) * 100) : 0 }))),
    };
  });
}

function personHasExactTag(person, tagName) {
  return Array.isArray(person?.tags) && person.tags.some((tag) => tag === tagName);
}

function computeInviteAudience(state) {
  const statuses = state.invite.sourceStatuses || sourceStatusDefaults;
  const exclude = new Set(state.invite.excludePeople || []);
  Object.values(state.invite.excludeTagPeople || {}).forEach((personIds) => {
    if (Array.isArray(personIds)) personIds.forEach((personId) => exclude.add(personId));
  });
  (Object.values(state.invite.excludeEventCohorts || {}) as any[]).forEach((selection) => {
    if (Array.isArray(selection?.personIds)) selection.personIds.forEach((personId) => exclude.add(personId));
  });
  const peopleById = new Map(state.people.map((person) => [person.id, person]));
  state.people.forEach((person) => {
    if (person.groups.some((groupId) => state.invite.excludeGroups.includes(groupId))) exclude.add(person.id);
    if (orderedPersonTags(person).some((tag) => (state.invite.excludeTags || []).includes(tag))) exclude.add(person.id);
  });
  (state.invite.excludeEventIds || []).forEach((eventId) => {
    const event = getEvent(state, eventId);
    event?.guests.forEach((guest) => {
      if (statuses.includes(guest.status)) exclude.add(guest.personId);
    });
  });

  const recipients = new Map();
  (state.invite.includePeople || []).forEach((personId) => {
    addRecipient(recipients, peopleById.get(personId), "Selected person");
  });
  (state.invite.includeEventIds || []).forEach((eventId) => {
    const event = getEvent(state, eventId);
    event?.guests.forEach((guest) => {
      if (statuses.includes(guest.status)) {
        addRecipient(recipients, peopleById.get(guest.personId), `${event.title}: ${statusLabels[guest.status]}`);
      }
    });
  });
  (Object.entries(state.invite.includeEventCohorts || {}) as Array<[string, any]>).forEach(([eventId, selection]) => {
    const event = getEvent(state, eventId);
    (selection?.personIds || []).forEach((personId) => {
      addRecipient(recipients, peopleById.get(personId), `${event?.title || "Selected event"}: ${selection.cohort}`);
    });
  });

  state.people.forEach((person) => {
    orderedPersonTags(person).forEach((tag) => {
      if ((state.invite.includeTags || []).includes(tag)) addRecipient(recipients, person, `${tagDisplayName(tag)} tag`);
    });
    person.groups.forEach((groupId) => {
      if (state.invite.includeGroups.includes(groupId)) {
        const group = getGroup(state, groupId);
        addRecipient(recipients, person, group ? `${group.name} group` : "Selected group");
      }
    });
  });

  const includedRecipients = [...recipients.values()]
    .filter(({ person }) => !exclude.has(person.id));
  const historyByPerson = buildPersonHistoryIndex(state, new Set(includedRecipients.map(({ person }) => person.id)));
  return includedRecipients
    .map((item) => ({ ...item, history: historyByPerson.get(item.person.id) || emptyPersonHistory() }))
    .sort((a, b) => {
      const aLast = a.history.lastAttended ? new Date(a.history.lastAttended.date).getTime() : 0;
      const bLast = b.history.lastAttended ? new Date(b.history.lastAttended.date).getTime() : 0;
      return bLast - aLast || a.person.name.localeCompare(b.person.name);
    });
}

function buildPersonHistoryIndex(state, personIds) {
  const recordsByPerson = new Map([...personIds].map((personId) => [personId, []]));
  [...sortEvents(state.events)].reverse().forEach((event) => {
    event.guests.forEach((guest) => {
      const records = recordsByPerson.get(guest.personId);
      if (records) records.push({ event, guest });
    });
  });
  return new Map([...recordsByPerson].map(([personId, records]) => [personId, personHistoryFromRecords(records)]));
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

  return personHistoryFromRecords(records);
}

function personHistoryFromRecords(records) {
  const attendedRecords = records.filter(({ guest }) => guest.status === "checked_in" || Boolean(guest.checkedInAt));
  const registeredRecords = records.filter(({ guest }) => isRegisteredGuest(guest));
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

function emptyPersonHistory() {
  return {
    records: [],
    attendedCount: 0,
    registeredCount: 0,
    noShowCount: 0,
    totalInvited: 0,
    firstEvent: null,
    lastAttended: null,
    attendanceRate: 0,
    categories: {},
  };
}

function eventStats(event) {
  const stats = {
    confirmed: 0,
    accepted: 0,
    registered: 0,
    pending: 0,
    declined: 0,
    waitlisted: 0,
    checkedIn: 0,
    invited: 0,
    invitedNoResponse: 0,
    toDecide: 0,
    firstRegisters: 0,
    newRegistrations: 0,
    newFaces: 0,
  };
  event.guests.forEach((guest) => {
    if (["going", "checked_in"].includes(guest.status)) stats.confirmed += 1;
    if (acceptedStatuses.includes(guest.status)) stats.accepted += 1;
    if (isRegisteredGuest(guest)) stats.registered += 1;
    if (guest.status === "registered") stats.pending += 1;
    if (guest.status === "declined") stats.declined += 1;
    if (guest.status === "waitlisted") stats.waitlisted += 1;
    if (guest.status === "checked_in") stats.checkedIn += 1;
    if (hasInvitationEvidence(guest)) stats.invited += 1;
    if (guest.status === "invited") stats.invitedNoResponse += 1;
    if (isGuestToDecide(guest)) stats.toDecide += 1;
    if (isFirstRegister(guest)) stats.firstRegisters += 1;
    if (isRegisteredGuest(guest) && isFirstRegistration(guest)) stats.newRegistrations += 1;
    if (guest.status === "checked_in" && isFirstRegistration(guest)) stats.newFaces += 1;
  });
  return stats;
}

function hasInvitationEvidence(guest) {
  return Boolean(guest?.invitedAt) || guest?.status === "invited";
}

function isRegisteredGuest(guest) {
  return registeredStatuses.includes(guest?.status)
    || (guest?.status === "declined" && Boolean(guest?.registeredAt));
}

function guestAfterStatusChange(guest, status, changedAt) {
  const wasCheckedIn = guest?.status === "checked_in";
  return {
    ...guest,
    status,
    operatorDecision: status,
    updatedAt: changedAt,
    ...(status === "registered" && !guest?.registeredAt ? { registeredAt: changedAt } : {}),
    ...(status === "going" ? {
      approvedAt: changedAt,
      ...(wasCheckedIn ? { checkedInAt: null } : {}),
    } : {}),
  };
}

function adjustGuestStatusStats(stats, before, after) {
  if (!stats) return stats;
  const predicates = {
    confirmed: (guest) => ["going", "checked_in"].includes(guest?.status),
    accepted: (guest) => acceptedStatuses.includes(guest?.status),
    registered: (guest) => isRegisteredGuest(guest),
    pending: (guest) => guest?.status === "registered",
    declined: (guest) => guest?.status === "declined",
    waitlisted: (guest) => guest?.status === "waitlisted",
    checkedIn: (guest) => guest?.status === "checked_in",
    invited: (guest) => hasInvitationEvidence(guest),
    toDecide: (guest) => isGuestToDecide(guest),
    firstRegisters: (guest) => isFirstRegister(guest),
    newRegistrations: (guest) => isRegisteredGuest(guest) && isFirstRegistration(guest),
    newFaces: (guest) => guest?.status === "checked_in" && isFirstRegistration(guest),
    newReferrals: (guest) => Boolean(guest?.isReferred && guest?.isNewReferral && registeredStatuses.includes(guest?.status)),
    referredRegistrations: (guest) => Boolean(guest?.isReferred && isRegisteredGuest(guest)),
    referredAccepted: (guest) => Boolean(guest?.isReferred && acceptedStatuses.includes(guest?.status)),
    referredCheckedIn: (guest) => Boolean(guest?.isReferred && guest?.status === "checked_in"),
    referredFirstRegisters: (guest) => Boolean(guest?.isReferred && isFirstRegister(guest)),
  };
  Object.entries(predicates).forEach(([key, matches]) => {
    if (!Number.isFinite(Number(stats[key]))) return;
    const delta = Number(matches(after)) - Number(matches(before));
    if (delta) stats[key] = Math.max(0, Number(stats[key]) + delta);
  });
  return adjustInvitationOutcomeStats(stats, before, after);
}

function invitationOutcomeStatKey(guest) {
  if (!hasInvitationEvidence(guest)) return "";
  if (guest?.status === "no_show") return "invitedNoShow";
  if (guest?.status === "declined") return "invitedDeclined";
  if (guest?.status === "invited") return "invitedNoResponse";
  if (guest?.status === "checked_in" || Boolean(guest?.checkedInAt)) return "invitedCheckedIn";
  return "";
}

function adjustInvitationOutcomeStats(stats, before, after) {
  if (!stats) return stats;
  const beforeInvited = hasInvitationEvidence(before);
  const afterInvited = hasInvitationEvidence(after);
  if (Number.isFinite(Number(stats.invitationTotal))) {
    stats.invitationTotal = Math.max(0, Number(stats.invitationTotal) + Number(afterInvited) - Number(beforeInvited));
  }
  const beforeReferred = beforeInvited && Boolean(before?.isReferred);
  const afterReferred = afterInvited && Boolean(after?.isReferred);
  if (Number.isFinite(Number(stats.invitedReferralTotal))) {
    stats.invitedReferralTotal = Math.max(0, Number(stats.invitedReferralTotal) + Number(afterReferred) - Number(beforeReferred));
  }
  const beforeKey = invitationOutcomeStatKey(before);
  const afterKey = invitationOutcomeStatKey(after);
  if (beforeKey !== afterKey) {
    if (beforeKey && Number.isFinite(Number(stats[beforeKey]))) stats[beforeKey] = Math.max(0, Number(stats[beforeKey]) - 1);
    if (afterKey && Number.isFinite(Number(stats[afterKey]))) stats[afterKey] = Math.max(0, Number(stats[afterKey]) + 1);
  }
  const beforeReferralKey = beforeReferred && beforeKey ? beforeKey.replace("invited", "invitedReferral") : "";
  const afterReferralKey = afterReferred && afterKey ? afterKey.replace("invited", "invitedReferral") : "";
  if (beforeReferralKey !== afterReferralKey) {
    if (beforeReferralKey && Number.isFinite(Number(stats[beforeReferralKey]))) stats[beforeReferralKey] = Math.max(0, Number(stats[beforeReferralKey]) - 1);
    if (afterReferralKey && Number.isFinite(Number(stats[afterReferralKey]))) stats[afterReferralKey] = Math.max(0, Number(stats[afterReferralKey]) + 1);
  }
  return stats;
}

function updatedWorkspaceStats(stats, before, after, toDecideDelta) {
  const next = { ...stats };
  if (toDecideDelta && Number.isFinite(Number(next.toDecide))) {
    next.toDecide = Math.max(0, Number(next.toDecide) + toDecideDelta);
  }
  return adjustInvitationOutcomeStats(next, before, after);
}

function isGuestToDecide(guest) {
  return guest?.status === "registered"
    || (guest?.status === "waitlisted" && guest?.operatorDecision !== "waitlisted");
}

function aggregateEventStats(events) {
  const keys = ["confirmed", "accepted", "registered", "pending", "declined", "waitlisted", "checkedIn", "invited", "invitedNoResponse", "toDecide", "firstRegisters", "newFaces", "newReferrals"];
  return events.reduce((totals, event) => {
    const stats = event.guestStats || eventStats(event);
    keys.forEach((key) => void (totals[key] += Number(stats[key]) || 0));
    return totals;
  }, Object.fromEntries(keys.map((key) => [key, 0])));
}

function eventSelectionTiming(events, now = Date.now()) {
  if (events.every((event) => isUpcoming(event, now))) return "upcoming";
  if (events.every((event) => !isUpcoming(event, now))) return "past";
  return "mixed";
}

function formatEventSelectionRange(events) {
  const ordered = [...events].sort((left, right) => new Date(left.startsAt || left.date).getTime() - new Date(right.startsAt || right.date).getTime());
  if (!ordered.length) return "Selected events";
  const first = formatDate(ordered[0].date);
  const last = formatDate(ordered.at(-1).date);
  return first === last ? first : `${first} – ${last}`;
}

function isFirstRegister(guest) {
  return acceptedStatuses.includes(guest.status) && isFirstRegistration(guest);
}

function isFirstRegistration(guest) {
  return isRegisteredGuest(guest)
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

function actionsForStatus(status, event = null) {
  if (status === "checked_in") return [["Undo", "going"]];
  if (status === "no_show") return [["Check in", "checked_in"]];
  if (status === "registered" && eventHasStarted(event)) return [["Check in", "checked_in"]];
  if (status === "registered") return [["Approve", "going"], ["Waitlist", "waitlisted"], ["Decline", "declined"]];
  if (status === "waitlisted") return [["Approve", "going"], ["Decline", "declined"]];
  if (status === "going") return [["Check in", "checked_in"], ["Waitlist", "waitlisted"], ["Decline", "declined"]];
  if (status === "invited") return [["Approve", "going"], ["Decline", "declined"]];
  if (status === "declined") return [["Approve", "going"], ["Waitlist", "waitlisted"]];
  return [];
}

function eventHasStarted(event, now = new Date()) {
  const startsAt = new Date(event?.startsAt || "").getTime();
  if (Number.isFinite(startsAt)) return startsAt <= now.getTime();
  const eventDate = String(event?.date || "").slice(0, 10);
  return Boolean(eventDate) && eventDate < localDateKey(now);
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
  return [...events].sort((a, b) => eventSortTime(a) - eventSortTime(b));
}

function eventSortTime(event) {
  const startsAt = new Date(event?.startsAt || "").getTime();
  if (Number.isFinite(startsAt)) return startsAt;
  const date = new Date(`${String(event?.date || "").slice(0, 10)}T12:00:00`).getTime();
  return Number.isFinite(date) ? date : Number.MAX_SAFE_INTEGER;
}

function eventMatchesView(event, view, now = Date.now()) {
  if (view === "upcoming") return isUpcoming(event, now);
  if (view === "past") return !isUpcoming(event, now);
  return true;
}

function preferredEventIdForView(events, view, now = Date.now()) {
  const ordered = sortEvents(events);
  if (view === "past") return ordered.filter((event) => !isUpcoming(event, now)).at(-1)?.id || "";
  const nearestUpcoming = ordered.find((event) => isUpcoming(event, now))?.id || "";
  if (view === "upcoming") return nearestUpcoming || ordered.at(-1)?.id || "";
  return nearestUpcoming || ordered.at(-1)?.id || "";
}

function isUpcoming(event, now = Date.now()) {
  const endsAt = new Date(event?.endsAt || "").getTime();
  if (Number.isFinite(endsAt)) return endsAt > now;
  const eventDate = String(event.date || "").slice(0, 10);
  return Boolean(eventDate) && eventDate >= localDateKey(new Date(now));
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

function orderedPersonTags(person: any): string[] {
  const rawTags: unknown[] = Array.isArray(person?.tags) ? person.tags : [];
  const rawAutomaticTags: unknown[] = Array.isArray(person?.automaticTags) ? person.automaticTags : [];
  const tags = [...new Set(rawTags.filter((tag): tag is string => typeof tag === "string"))];
  const automaticTags = new Set<string>(
    rawAutomaticTags
      .filter((tag): tag is string => typeof tag === "string")
      .map((tag) => tag.toLocaleLowerCase()),
  );
  const referredTag = REFERRED_PERSON_TAG.toLocaleLowerCase();
  const priority = (tag: string) => {
    const normalizedTag = tag.toLocaleLowerCase();
    if (normalizedTag === referredTag) return 0;
    return automaticTags.has(normalizedTag) ? 2 : 1;
  };
  return tags
    .map((tag, index) => ({ tag, index }))
    .sort((left, right) => priority(left.tag) - priority(right.tag) || left.index - right.index)
    .map(({ tag }) => tag);
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
  const bareName = value.replace(/^(?:🚀|⚡|🎪|🤞|🙏|👻|💀)\s+/u, "");
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
