export type LumaApiKey = {
  envName: string;
  value: string;
  order: number;
};

export type LumaSessionToken = {
  envName: string;
  value: string;
  order: number;
};

type Environment = Record<string, string | undefined>;

export type LumaCredentialSource =
  | { type: "api-key"; value: LumaApiKey }
  | { type: "session-token"; value: LumaSessionToken };

type CachedCredentialSource = {
  type: LumaCredentialSource["type"];
  envName: string;
  order: number;
  expiresAt: number;
};

const EVENT_CREDENTIAL_STORE = "__guestbookLumaEventCredentialSources";
const EVENT_CREDENTIAL_CACHE_MAX = 1_000;
const EVENT_CREDENTIAL_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;

export function lumaApiKeys(environment: Environment = process.env): LumaApiKey[] {
  const candidates = Object.entries(environment)
    .flatMap(([envName, rawValue]) => {
      const match = envName.match(/^LUMA_API_KEY(?:_(\d+))?$/);
      const value = rawValue?.trim() || "";
      if (!match || !value) return [];
      return [{
        envName,
        value,
        order: match[1] ? Number(match[1]) : 0,
      }];
    })
    .sort((left, right) => left.order - right.order || left.envName.localeCompare(right.envName));

  const seenValues = new Set<string>();
  return candidates.filter((candidate) => {
    if (seenValues.has(candidate.value)) return false;
    seenValues.add(candidate.value);
    return true;
  });
}

export function lumaSessionTokens(environment: Environment = process.env): LumaSessionToken[] {
  return numberedCredentials("LUMA_SESSION_TOKEN", environment);
}

export function rememberLumaEventApiKey(eventId: unknown, apiKey: LumaApiKey) {
  rememberLumaEventCredential(eventId, { type: "api-key", value: apiKey });
}

export function knownLumaEventApiKey(eventId: unknown, environment: Environment = process.env) {
  const source = knownLumaEventCredential(eventId, environment);
  return source?.type === "api-key" ? source.value : null;
}

export function rememberLumaEventSessionToken(eventId: unknown, sessionToken: LumaSessionToken) {
  rememberLumaEventCredential(eventId, { type: "session-token", value: sessionToken });
}

export function knownLumaEventSessionToken(eventId: unknown, environment: Environment = process.env) {
  const source = knownLumaEventCredential(eventId, environment);
  return source?.type === "session-token" ? source.value : null;
}

export function rememberLumaEventCredential(eventId: unknown, source: LumaCredentialSource, now = Date.now()) {
  if (typeof eventId !== "string" || !eventId) return;
  const store = eventCredentialStore();
  const existing = store.get(eventId);
  const candidate = {
    type: source.type,
    envName: source.value.envName,
    order: source.value.order,
    expiresAt: now + EVENT_CREDENTIAL_CACHE_TTL_MS,
  } satisfies CachedCredentialSource;
  if (existing && existing.expiresAt > now && credentialPriority(existing) <= credentialPriority(candidate)) return;
  store.delete(eventId);
  store.set(eventId, candidate);
  pruneCredentialStore(store, now);
}

export function knownLumaEventCredential(eventId: unknown, environment: Environment = process.env, now = Date.now()): LumaCredentialSource | null {
  if (typeof eventId !== "string" || !eventId) return null;
  const store = eventCredentialStore();
  const cached = store.get(eventId);
  if (!cached) return null;
  if (cached.expiresAt <= now) {
    store.delete(eventId);
    return null;
  }
  const values = cached.type === "api-key" ? lumaApiKeys(environment) : lumaSessionTokens(environment);
  const value = values.find((credential) => credential.envName === cached.envName);
  if (!value) {
    store.delete(eventId);
    return null;
  }
  store.delete(eventId);
  store.set(eventId, cached);
  return cached.type === "api-key"
    ? { type: "api-key", value }
    : { type: "session-token", value };
}

export function clearLumaEventCredentialCache() {
  eventCredentialStore().clear();
}

export function lumaEventCredentialCacheSize() {
  return eventCredentialStore().size;
}

export function mergeLumaEvents(eventGroups: unknown[][]) {
  const eventsById = new Map<string, any>();
  for (const events of eventGroups) {
    for (const event of events) {
      const eventId = event && typeof event === "object" && typeof (event as any).id === "string"
        ? (event as any).id
        : "";
      if (eventId && !eventsById.has(eventId)) eventsById.set(eventId, event);
    }
  }
  return [...eventsById.values()].sort((left, right) => eventTimestamp(right) - eventTimestamp(left));
}

function eventCredentialStore(): Map<string, CachedCredentialSource> {
  const root = globalThis as typeof globalThis & { [EVENT_CREDENTIAL_STORE]?: Map<string, CachedCredentialSource> };
  root[EVENT_CREDENTIAL_STORE] ||= new Map<string, CachedCredentialSource>();
  return root[EVENT_CREDENTIAL_STORE];
}

function credentialPriority(source: Pick<CachedCredentialSource, "type" | "order">) {
  return (source.type === "api-key" ? 0 : 1) * 1_000_000 + source.order;
}

function pruneCredentialStore(store: Map<string, CachedCredentialSource>, now: number) {
  for (const [eventId, source] of store) {
    if (source.expiresAt <= now) store.delete(eventId);
  }
  while (store.size > EVENT_CREDENTIAL_CACHE_MAX) {
    const oldestEventId = store.keys().next().value;
    if (!oldestEventId) break;
    store.delete(oldestEventId);
  }
}

function numberedCredentials(prefix: string, environment: Environment) {
  const matcher = new RegExp(`^${prefix}(?:_(\\d+))?$`);
  const candidates = Object.entries(environment)
    .flatMap(([envName, rawValue]) => {
      const match = envName.match(matcher);
      const value = rawValue?.trim() || "";
      if (!match || !value) return [];
      return [{ envName, value, order: match[1] ? Number(match[1]) : 0 }];
    })
    .sort((left, right) => left.order - right.order || left.envName.localeCompare(right.envName));

  const seenValues = new Set<string>();
  return candidates.filter((candidate) => {
    if (seenValues.has(candidate.value)) return false;
    seenValues.add(candidate.value);
    return true;
  });
}

function eventTimestamp(event: any) {
  const value = event?.start_at || event?.startAt || event?.date;
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
