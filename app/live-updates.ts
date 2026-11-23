// Fetch-based SSE preserves the existing header authentication; credentials
// never enter URLs. Reconnect only after a transport ends/fails, never poll.
export async function subscribeToLiveUpdates(
  request: (url: string, init?: RequestInit) => Promise<Response>,
  onEvent: (type: string, data: { eventId?: string | null }) => void,
  signal: AbortSignal,
) {
  let failures = 0;
  while (!signal.aborted) {
    try {
      const response = await request("/api/luma/changes", { signal, cache: "no-store", headers: { Accept: "text/event-stream" } });
      if (!response.ok || !response.body) {
        if (response.status === 401 || response.status === 403) { onEvent("unauthorized", {}); return; }
        throw new Error("Live connection unavailable.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.length > 64_000) throw new Error("Live message too large.");
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const message = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const type = message.split("\n").find((line) => line.startsWith("event: "))?.slice(7);
            const data = message.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
            if (type && data) {
              if (type === "ready") failures = 0;
              onEvent(type, JSON.parse(data));
            }
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch { if (signal.aborted) return; }
    if (signal.aborted) return;
    onEvent("disconnected", {});
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)) + Math.random() * 500);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
}
