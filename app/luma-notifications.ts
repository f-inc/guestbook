export type LumaConnection = {
  apiKeyCount: number;
  sessions: { name: string; status: "connected" | "invalid" | "unavailable" }[];
  checkedAt: string;
};

export type ConnectionNotification = { id: string; title: string; message: string };
export const LUMA_NOTIFICATIONS_STORAGE_KEY = "guestbook.lumaNotifications";

export const connectionCheckFailed: ConnectionNotification = {
  id: "luma-check",
  title: "Couldn’t check the Luma connection",
  message: "Try checking again. Existing notifications stay here until their issues are resolved.",
};

export function reconcileLumaNotifications(previous: ConnectionNotification[], connection: LumaConnection): ConnectionNotification[] {
  const notifications: ConnectionNotification[] = [];
  if (!connection.sessions.length) notifications.push({
    id: "luma-session-missing",
    title: "Connect your Luma session",
    message: "Add your session in Settings → Luma connection to discover events you manage personally.",
  });
  for (const session of connection.sessions) {
    if (session.status === "connected") continue;
    const id = `luma-session:${session.name}`;
    const existing = previous.find((notification) => notification.id === id);
    notifications.push(session.status === "unavailable" && existing ? existing : {
      id,
      title: session.status === "invalid" ? "Reconnect your Luma session" : "Couldn’t verify your Luma session",
      message: session.status === "invalid"
        ? "Your Luma session has expired or was rejected. Update it in Settings → Luma connection."
        : "Luma couldn’t verify the session. Your saved session has been kept. Try checking again.",
    });
  }
  return notifications;
}

export function readLumaNotifications(value: string | null): ConnectionNotification[] {
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item.id === "string" && typeof item.title === "string" && typeof item.message === "string")
      .map(({ id, title, message }) => ({ id, title, message }));
  } catch {
    return [];
  }
}
