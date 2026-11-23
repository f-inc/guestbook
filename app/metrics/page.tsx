import { headers } from "next/headers";
import Link from "next/link";
import { requireGuestbookKey } from "../api/session-auth";
import { parseDrilldown, readMetricPeople, stageLabels } from "./read";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function MetricsPeople({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  try {
    requireGuestbookKey(
      new Request("https://guestbook.invalid/metrics", { headers: await headers() }),
    );
  } catch {
    return (
      <main style={{ padding: 40 }}>
        <h1>Sign in to Guestbook</h1>
        <p>
          This list requires your existing Guestbook session. Sign in, then return to this link.
        </p>
        <Link href="/">Open Guestbook</Link>
      </main>
    );
  }
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw))
    for (const part of Array.isArray(value) ? value : value === undefined ? [] : [value])
      params.append(key, part);
  try {
    const input = parseDrilldown(params);
    const data = await readMetricPeople(input);
    const pageHref = (page: number) => {
      const query = new URLSearchParams(params);
      query.set("page", String(page));
      return `/metrics?${query}`;
    };
    const repeats = ["registrations", "accepted", "checkedIn"].includes(input.stage);
    return (
      <main style={{ maxWidth: 1100, margin: "48px auto", padding: 24 }}>
        <Link href="/">Guestbook</Link>
        <h1>{stageLabels[input.stage]}</h1>
        <p>
          {data.total.toLocaleString("en-US")}{" "}
          {repeats
            ? "event records (repeat people can appear at different events)"
            : "unique people"}{" "}
          · {input.query.from} through{" "}
          {new Date(Date.parse(input.query.to) - 86400000).toISOString().slice(0, 10)} · Pacific
          time
        </p>
        {!repeats && (
          <p>
            People who checked into a non-Open Campus event in these dates, including returning visitors, followed
            through later Open Campus outcomes. Available indexed history can be incomplete.
          </p>
        )}
        {input.expected !== null && input.expected !== data.total && (
          <p role="status">
            The chart showed {input.expected}; the current index now has {data.total}. Refresh Event
            metrics to update the count.
          </p>
        )}
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 24 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Person</th>
              <th style={{ textAlign: "left" }}>Matching event</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, index) => (
              <tr key={`${row.eventId}/${row.personId}/${index}`}>
                <td style={{ padding: "14px 0", borderBottom: "1px solid #ddd" }}>
                  <Link href={`/?people=1&profile=${encodeURIComponent(row.personId)}`}>
                    {row.name}
                  </Link>
                </td>
                <td style={{ borderBottom: "1px solid #ddd" }}>
                  <Link
                    href={`/?event=${encodeURIComponent(row.eventId)}&profile=${encodeURIComponent(row.personId)}`}
                  >
                    {row.eventTitle}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.total && <p>No matching people in the current index.</p>}
        <nav style={{ display: "flex", gap: 24, marginTop: 24 }}>
          {input.page > 1 && <Link href={pageHref(input.page - 1)}>Previous</Link>}
          <span>Page {input.page}</span>
          {input.page * 50 < data.total && <Link href={pageHref(input.page + 1)}>Next</Link>}
        </nav>
      </main>
    );
  } catch {
    return (
      <main style={{ padding: 40 }}>
        <h1>Could not open this metric list</h1>
        <p>
          The link may be invalid or the indexed read limit was exceeded. Refresh the metric and try
          again.
        </p>
        <Link href="/">Open Guestbook</Link>
      </main>
    );
  }
}
