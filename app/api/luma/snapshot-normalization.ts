import { lumaEventDate } from "./event-date";
import { orderAvatarCandidates } from "../../avatar-order";
import { extractLumaReferrer } from "./referrer";
import { extractGuestPhoneNumber } from "./guest-phone";

const approvalToStatus = {
  approved: "going",
  pending_approval: "registered",
  invited: "invited",
  declined: "declined",
  waitlist: "waitlisted",
  session: "going",
};

export function normalizeEvent(event) {
  const eventStatus = String(event.status || "").toLowerCase();
  return {
    id: event.id,
    title: event.name || "Untitled event",
    date: lumaEventDate(event),
    startsAt: event.start_at || null,
    endsAt: event.end_at || null,
    visibility: event.visibility || null,
    location: formatLocation(event),
    category: firstTag(event) || event.calendar?.name || "Luma",
    capacity: event.max_capacity || event.guest_capacity || event.guest_count || 1,
    lumaUrl: event.url || "",
    imageUrl: extractEventImageUrl(event),
    cancelled: ["cancelled", "canceled"].includes(eventStatus),
    guests: [],
    guestsLoaded: false,
    source: "luma",
  };
}

export function normalizeGuest(event, guest) {
  const registrationAnswers = normalizeRegistrationAnswers(guest.registration_answers);
  const phoneNumber = extractGuestPhoneNumber(guest, registrationAnswers);
  const lumaUserId = firstString(guest.user_id, guest.user_api_id, guest.user?.id, guest.user?.user_id, guest.user?.api_id);
  const lumaGuestId = firstString(guest.id, guest.api_id, guest.guest_id, guest.guest_api_id);
  const personId = lumaUserId || firstString(guest.user_email, guest.email, guest.user?.email, lumaGuestId) || "guest-" + Math.random().toString(36).slice(2, 10);
  const checkedInAt = extractCheckedInAt(guest);
  const checkedIn = Boolean(checkedInAt);
  const profileDescription = extractProfileDescription(guest, registrationAnswers);
  const socialLinks = mergeSocialLinks(extractSocialLinks(guest), extractSocialLinksFromAnswers(registrationAnswers));
  const referrer = extractReferrer(guest);
  const avatarCandidates = extractAvatarCandidates(guest);
  const searchText = [profileDescription, extractRegistrationAnswerText(registrationAnswers), phoneNumber, socialLinks.map((link) => link.display).join(" "), referrerText(referrer)].filter(Boolean).join(" ");
  const status = checkedIn
    ? "checked_in"
    : approvalToStatus[guest.approval_status] || "registered";
  const registeredAt = firstString(guest.registered_at, guest.joined_at, status === "invited" ? "" : guest.created_at);

  return {
    person: {
      id: personId,
      lumaUserId,
      name: firstString(guest.user_name, guest.name, guest.user?.name) || [guest.user_first_name, guest.user_last_name].filter(Boolean).join(" ") || firstString(guest.user_email, guest.email, guest.user?.email) || "Unnamed guest",
      email: firstString(guest.user_email, guest.email, guest.user?.email),
      title: extractGuestTitle(guest, registrationAnswers),
      profileDescription,
      bio: profileDescription,
      avatarUrl: avatarCandidates[0] || "",
      avatarCandidates,
      profileUrl: extractProfileUrl(guest) || lumaProfileUrl(lumaUserId),
      socialLinks,
      referrer,
      groups: [],
      notes: profileDescription,
      source: "luma",
    },
    personId,
    lumaGuestId,
    lumaApprovalStatus: guest.approval_status,
    phoneNumber,
    profileDescription,
    avatarUrl: avatarCandidates[0] || "",
    avatarCandidates,
    profileUrl: extractProfileUrl(guest) || lumaProfileUrl(lumaUserId),
    socialLinks,
    referrer,
    registrationAnswers,
    searchText,
    source: "luma",
    status,
    registeredAt,
    invitedAt: firstString(guest.invited_at, guest.invite_sent_at, status === "invited" ? guest.created_at : ""),
    createdAt: firstString(guest.created_at),
    updatedAt: firstString(guest.updated_at),
    approvedAt: firstString(guest.approved_at),
    checkedInAt,
  };
}

function extractCheckedInAt(guest) {
  const ticketCheckIns = Array.isArray(guest.event_tickets) ? guest.event_tickets.map((ticket) => ticket?.checked_in_at) : [];
  const candidates = [guest.checked_in_at, guest.event_ticket?.checked_in_at, ...ticketCheckIns]
    .map((value) => firstString(value))
    .filter(Boolean);

  return candidates.reduce((earliest, candidate) => {
    if (!earliest) return candidate;
    const earliestTime = Date.parse(earliest);
    const candidateTime = Date.parse(candidate);
    if (!Number.isFinite(candidateTime)) return earliest;
    return !Number.isFinite(earliestTime) || candidateTime < earliestTime ? candidate : earliest;
  }, "");
}

function normalizeRegistrationAnswers(answers = []) {
  return answers
    .map((answer, index) => {
      const label = firstString(answer.label, answer.question_label, answer.question_text, answer.question?.label, answer.question?.title, answer.question?.text, answer.question);
      const rawValue = answer.value ?? answer.answer ?? answer.response;
      const values = answerValueSelections(rawValue);
      const value = values.join(" ");
      return {
        id: firstString(answer.id, answer.question_id, answer.question?.id) || "answer-" + index,
        label: label || "Question",
        value,
        values,
        questionType: firstString(answer.question_type, answer.type, answer.question?.type),
      };
    })
    .filter((answer) => answer.label || answer.value);
}

function extractProfileDescription(guest, registrationAnswers = []) {
  const direct = [
    guest.user_bio,
    guest.user_description,
    guest.profile_description,
    guest.profile?.description,
    guest.profile?.bio,
    guest.user?.description,
    guest.user?.bio,
    guest.user?.profile?.bio,
    guest.user?.profile?.description,
  ].find((value) => typeof value === "string" && value.trim());
  if (direct) return direct.trim();

  const answer = registrationAnswers.find((item) => {
    const label = String(item.label || "").toLowerCase();
    return label.includes("bio") || label.includes("about") || label.includes("description") || label.includes("profile");
  });
  return answer?.value || "";
}

function extractRegistrationAnswerText(answers = []) {
  return answers
    .map((answer) => [answer.label, stringifyAnswerValue(answer.value)].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(" ");
}

function extractGuestTitle(guest, registrationAnswers = []) {
  const companyAnswer = registrationAnswers.find((answer) => answer.questionType === "company" || answer.label.toLowerCase().includes("company"));
  const rawCompanyAnswer = (guest.registration_answers || []).find((answer) => answer.question_type === "company" || String(answer.label || "").toLowerCase().includes("company"));
  const jobTitle = firstString(guest.user_title, guest.user?.title, guest.profile?.title, rawCompanyAnswer?.value?.job_title, rawCompanyAnswer?.value?.title, rawCompanyAnswer?.value?.role);
  const company = firstString(guest.user_company, guest.user?.company, guest.profile?.company, rawCompanyAnswer?.value?.company_name, rawCompanyAnswer?.value?.company, rawCompanyAnswer?.value?.organization);
  return [jobTitle, company].filter(Boolean).join(" at ") || companyAnswer?.value || "Luma guest";
}

function extractAvatarUrl(guest) {
  return extractAvatarCandidates(guest)[0] || "";
}

function extractAvatarCandidates(guest) {
  return orderAvatarCandidates(uniqueUrls(
    guest.user_avatar_url,
    guest.avatar_url,
    guest.profile_picture_url,
    guest.photo_url,
    guest.image_url,
    guest.user?.avatar_url,
    guest.user?.profile_picture_url,
    guest.user?.photo_url,
    guest.user?.image_url,
    guest.user?.avatar?.url,
    guest.profile?.avatar_url,
    guest.profile?.profile_picture_url,
    guest.profile?.photo_url,
    guest.profile?.image_url,
    guest.profile_picture?.url,
    guest.linkedin_avatar_url,
    guest.linkedin_photo_url,
    guest.linkedin_profile_picture_url,
    guest.user?.linkedin_avatar_url,
    guest.user?.linkedin_photo_url,
    guest.profile?.linkedin_avatar_url,
    guest.profile?.linkedin_photo_url,
    guest.twitter_profile_image_url,
    guest.twitter_avatar_url,
    guest.x_profile_image_url,
    guest.x_avatar_url,
    guest.user?.twitter_profile_image_url,
    guest.user?.twitter_avatar_url,
    guest.profile?.twitter_profile_image_url,
    guest.profile?.twitter_avatar_url,
  ));
}

function extractEventImageUrl(event) {
  return firstUrlLike(event.cover_url, event.cover_image_url, event.image_url, event.thumbnail_url, event.event_image_url, event.cover?.url, event.cover?.image_url, event.calendar?.avatar_url);
}

function extractProfileUrl(guest) {
  return firstUrlLike(guest.user_url, guest.profile_url, guest.luma_profile_url, guest.user?.url, guest.user?.profile_url, guest.user?.luma_profile_url, guest.profile?.url);
}

function lumaProfileUrl(lumaUserId) {
  return lumaUserId?.startsWith("usr-") ? `https://luma.com/user/${encodeURIComponent(lumaUserId)}` : "";
}

function extractReferrer(guest) {
  return extractLumaReferrer(guest);
}

function extractSocialLinks(guest) {
  const containers = [guest, guest.user, guest.profile, guest.user?.profile].filter(Boolean);
  const configs = [
    { type: "website", label: "Website", keys: ["website", "website_url", "personal_website", "homepage_url"] },
    { type: "linkedin", label: "LinkedIn", keys: ["linkedin", "linkedin_url", "linkedin_handle", "linkedin_profile"] },
    { type: "x", label: "X", keys: ["twitter", "twitter_url", "twitter_handle", "x", "x_url", "x_handle"] },
    { type: "instagram", label: "Instagram", keys: ["instagram", "instagram_url", "instagram_handle"] },
    { type: "github", label: "GitHub", keys: ["github", "github_url", "github_handle"] },
    { type: "tiktok", label: "TikTok", keys: ["tiktok", "tiktok_url", "tiktok_handle"] },
    { type: "youtube", label: "YouTube", keys: ["youtube", "youtube_url", "youtube_handle"] },
  ];

  return configs
    .map((config) => {
      const raw = firstStringFromContainers(containers, config.keys);
      const url = normalizeSocialUrl(config.type, raw);
      if (!url) return null;
      return {
        type: config.type,
        label: config.label,
        url,
        display: displaySocialValue(config.type, raw, url),
      };
    })
    .filter(Boolean);
}

function extractSocialLinksFromAnswers(registrationAnswers = []) {
  return registrationAnswers
    .map((answer) => {
      const type = socialTypeForQuestion(answer.label);
      if (!type || !answer.value) return null;
      const url = normalizeSocialUrl(type, answer.value);
      if (!url) return null;
      return {
        type,
        label: socialLabel(type),
        url,
        display: displaySocialValue(type, answer.value, url),
      };
    })
    .filter(Boolean);
}

function socialTypeForQuestion(label = "") {
  const normalized = label.toLowerCase();
  if (normalized.includes("linkedin")) return "linkedin";
  if (normalized.includes("twitter") || /\bx\b/.test(normalized)) return "x";
  if (normalized.includes("instagram")) return "instagram";
  if (normalized.includes("github")) return "github";
  if (normalized.includes("tiktok")) return "tiktok";
  if (normalized.includes("youtube")) return "youtube";
  if (normalized.includes("website") || normalized.includes("portfolio") || normalized.includes("personal site")) return "website";
  return "";
}

function socialLabel(type) {
  return {
    website: "Website",
    linkedin: "LinkedIn",
    x: "X",
    instagram: "Instagram",
    github: "GitHub",
    tiktok: "TikTok",
    youtube: "YouTube",
  }[type];
}

function normalizeSocialUrl(type, rawValue) {
  const raw = stringifyLinkValue(rawValue);
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  const handle = raw.replace(/^@/, "").replace(/^\/+/, "").trim();
  if (!handle) return "";
  if (type === "website") return handle.includes(".") ? "https://" + handle : "";
  if (type === "linkedin") {
    const linkedinHandle = handle.replace(/^in\//i, "");
    return linkedinHandle.includes("linkedin.com") ? "https://" + linkedinHandle : "https://www.linkedin.com/in/" + encodeURIComponent(linkedinHandle);
  }
  if (type === "x") return handle.includes("twitter.com") || handle.includes("x.com") ? "https://" + handle : "https://x.com/" + encodeURIComponent(handle);
  if (type === "instagram") return handle.includes("instagram.com") ? "https://" + handle : "https://www.instagram.com/" + encodeURIComponent(handle);
  if (type === "github") return handle.includes("github.com") ? "https://" + handle : "https://github.com/" + encodeURIComponent(handle);
  if (type === "tiktok") return handle.includes("tiktok.com") ? "https://" + handle : "https://www.tiktok.com/@" + encodeURIComponent(handle);
  if (type === "youtube") return handle.includes("youtube.com") || handle.includes("youtu.be") ? "https://" + handle : "https://www.youtube.com/@" + encodeURIComponent(handle);
  return "";
}

function displaySocialValue(type, rawValue, url) {
  const raw = stringifyLinkValue(rawValue);
  if (type === "linkedin" && /^\/?in\//i.test(raw)) return url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
  if (raw && !/^https?:\/\//i.test(raw) && type !== "website") return raw.startsWith("@") ? raw : "@" + raw.replace(/^@/, "");
  return url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}

function mergeSocialLinks(...groups) {
  const links = new Map();
  groups.flat().filter(Boolean).forEach((link) => {
    const key = link.type + ":" + link.url.toLowerCase();
    if (!links.has(key)) links.set(key, link);
  });
  return [...links.values()];
}

function firstStringFromContainers(containers, keys) {
  for (const container of containers) {
    for (const key of keys) {
      const value = stringifyLinkValue(container?.[key]);
      if (value) return value;
    }
  }
  return "";
}

function stringifyLinkValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") return firstString(value.url, value.href, value.handle, value.username, value.value);
  return String(value).trim();
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function firstUrlLike(...values) {
  return values.map(stringifyLinkValue).find((value) => value && (/^https?:\/\//i.test(value) || value.includes("."))) || "";
}

function uniqueUrls(...values) {
  return [...new Set(values.map(stringifyLinkValue).filter((value) => /^https?:\/\//i.test(value)))];
}

function referrerText(referrer) {
  if (!referrer) return "";
  return [referrer.name, referrer.email, referrer.url, referrer.source].filter(Boolean).join(" ");
}

function stringifyAnswerValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.map(stringifyAnswerValue).filter(Boolean).join(" ");
  if (typeof value === "object") return Object.values(value).map(stringifyAnswerValue).filter(Boolean).join(" ");
  return String(value);
}

function answerValueSelections(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return [...new Set(value.flatMap(answerValueSelections).filter(Boolean))];
  if (typeof value === "object") return [...new Set(Object.values(value).flatMap(answerValueSelections).filter(Boolean))];
  const selection = stringifyAnswerValue(value);
  return selection ? [selection] : [];
}

function formatLocation(event) {
  if (event.geo_address_json?.full_address) return event.geo_address_json.full_address;
  if (event.geo_address_json?.address) return event.geo_address_json.address;
  if (event.geo_address_json?.city_state) return event.geo_address_json.city_state;
  if (event.meeting_url) return "Online";
  return event.location_type || "Location TBD";
}

function firstTag(event) {
  const tag = event.tags?.[0];
  return tag?.name || tag?.tag_name || tag || null;
}
