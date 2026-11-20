import { API_LOG_DAYS, RECENT_CALLS, type KeyCalls } from "@/lib/api-log";

// To the second, since calls come close together. Always UTC.
const stamp = (at: Date) => at.toISOString().slice(0, 19).replace("T", " ");

// The API call log for one account's keys: the latest calls for each key, as stacked rows on a phone and a four-column
// list from md up. Used on the Buyer API and Seller API pages and on the desk's API page.
export function RecentCalls({ groups, csvHref, className = "mt-10" }: { groups: KeyCalls[]; csvHref?: string | null; className?: string }) {
  return (
    <section aria-labelledby="recent-calls-heading" className={className}>
      <h2 id="recent-calls-heading" className="eyebrow">Recent calls</h2>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        The last {RECENT_CALLS} calls for each key, newest first, kept for {API_LOG_DAYS} days. The path leaves out the query&apos;s values. Status is the key
        check&apos;s answer: 200 when the key was accepted, or the refusal. Times are UTC.
      </p>
      {csvHref && (
        <a href={csvHref} className="mt-3 inline-flex h-10 items-center rounded-lg border border-border px-4 text-[13px] font-medium text-foreground hover:bg-hover">
          Download {API_LOG_DAYS} days as CSV
        </a>
      )}
      {groups.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No keys yet.</p>}
      <div className="mt-4 space-y-4">
        {groups.map(({ key, calls }) => (
          <div key={key.id} className="rounded-xl border border-border">
            <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-3 text-sm">
              <span className="min-w-0 break-words text-foreground">{key.name} · {key.prefix}…</span>
              <span className="text-xs text-muted-foreground">{key.revokedAt ? "Revoked" : "Live"}</span>
            </p>
            {calls.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">No calls in the last {API_LOG_DAYS} days.</p>
            ) : (
              <>
                <p aria-hidden className="hidden gap-3 px-4 pt-2 text-xs text-muted-foreground md:grid md:grid-cols-[150px_64px_minmax(0,1fr)_56px]">
                  <span>Time</span>
                  <span>Method</span>
                  <span>Path</span>
                  <span className="text-right">Status</span>
                </p>
                <ul className="divide-y divide-border">
                  {calls.map((call) => (
                    <li key={call.id} className="px-4 py-2.5 text-[13px] md:grid md:grid-cols-[150px_64px_minmax(0,1fr)_56px] md:items-baseline md:gap-3">
                      <div className="flex items-baseline justify-between gap-3 md:contents">
                        <span className="tabular-nums text-muted-foreground">{stamp(call.createdAt)}</span>
                        <span className={`tabular-nums font-medium md:order-last md:text-right ${call.status >= 400 ? "text-bad" : "text-foreground"}`}>
                          <span className="sr-only">Status </span>
                          {call.status}
                        </span>
                      </div>
                      <div className="mt-0.5 flex min-w-0 gap-2 md:contents">
                        <span className="shrink-0 font-medium text-foreground">{call.method}</span>
                        <span className="min-w-0 break-all font-mono text-[12px] text-foreground">{call.path}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
