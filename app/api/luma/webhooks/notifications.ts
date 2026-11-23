import { Client } from "pg";

export const INBOX_CHANNEL = "guestbook_webhook_inbox";
export const CHANGE_CHANNEL = "guestbook_index_changed";
type Listener = { change: (channel: string, payload: string) => void; ready: () => void; disconnected: () => void };

// LISTEN needs a dedicated session. Never silently change a transaction-pool URL.
export function notificationDatabaseUrl(env: Record<string, string | undefined> = process.env) {
  const value = env.DB_NOTIFY_URL || env.DB_URL;
  if (!value) throw new Error("DB_NOTIFY_URL is required for database notifications.");
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.port === "6543" || url.searchParams.get("pgbouncer") === "true") {
    throw new Error("DB_NOTIFY_URL must use a direct or session-mode PostgreSQL connection.");
  }
  for (const key of ["connection_limit", "pool_timeout", "pgbouncer", "schema"]) url.searchParams.delete(key);
  return url.toString();
}

export function notificationClient() {
  let connectionString = notificationDatabaseUrl();
  const ca = process.env.DB_NOTIFY_CA_CERT;
  if (ca) {
    const url = new URL(connectionString);
    // pg's URL SSL options override its explicit SSL object. Use the supplied
    // trust anchor with hostname/certificate verification kept mandatory.
    for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(key);
    connectionString = url.toString();
  }
  return new Client({ connectionString, ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}), connectionTimeoutMillis: 10_000,
    keepAlive: true, application_name: "guestbook-notifications" });
}

export class DatabaseNotifications {
  private listeners = new Set<Listener>();
  private client: Client | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private attempt = 0;
  constructor(private createClient: () => Client = notificationClient) {}

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    if (this.connected) queueMicrotask(() => { if (this.listeners.has(listener)) listener.ready(); });
    else if (!this.client && !this.retry) void this.connect();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        if (this.retry) clearTimeout(this.retry);
        this.retry = null;
        const client = this.client;
        this.client = null;
        this.connected = false;
        void client?.end().catch(() => {});
      }
    };
  }

  private async connect() {
    if (!this.listeners.size) return;
    let client: Client;
    try { client = this.createClient(); }
    catch { this.scheduleReconnect(); return; }
    this.client = client;
    const lost = () => {
      if (this.client !== client) return;
      this.client = null;
      this.connected = false;
      for (const listener of this.listeners) listener.disconnected();
      void client.end().catch(() => {});
      this.scheduleReconnect();
    };
    client.on("error", lost);
    client.on("end", lost);
    client.on("notification", (message) => {
      if (this.client !== client) return;
      for (const listener of this.listeners) listener.change(message.channel, message.payload || "");
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${INBOX_CHANNEL}`);
      await client.query(`LISTEN ${CHANGE_CHANNEL}`);
      if (this.client !== client) return;
      this.connected = true;
      this.attempt = 0;
      // Subscribe before reading current state: catches changes during reconnect.
      for (const listener of this.listeners) listener.ready();
    } catch { lost(); }
  }

  private scheduleReconnect() {
    if (!this.listeners.size || this.retry) return;
    for (const listener of this.listeners) listener.disconnected();
    this.retry = setTimeout(() => { this.retry = null; void this.connect(); }, Math.min(30_000, 1000 * 2 ** Math.min(this.attempt++, 5)));
    this.retry.unref?.();
  }
}

const root = globalThis as typeof globalThis & { __guestbookNotifications?: DatabaseNotifications };
export const databaseNotifications = root.__guestbookNotifications ??= new DatabaseNotifications();
