export type RequestsUrlState = { search: string; offset: number; requestId: string };

export function parseRequestsUrl(search: string): RequestsUrlState {
  const params = new URLSearchParams(search);
  const offset = Number(params.get("offset") || 0);
  return {
    search: (params.get("q") || "").trim().slice(0, 500),
    offset: Number.isSafeInteger(offset) && offset >= 0 && offset <= 1_000_000 ? offset : 0,
    requestId: (params.get("request") || "").trim().slice(0, 500),
  };
}

export function requestsUrl(currentUrl: string, state: RequestsUrlState) {
  const url = new URL(currentUrl);
  for (const [name, value] of [["request", state.requestId], ["q", state.search], ["offset", state.offset ? String(state.offset) : ""]]) {
    if (value) url.searchParams.set(name, value);
    else url.searchParams.delete(name);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
