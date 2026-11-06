"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// One entry, already redacted for this viewer and formatted on the server, so the page and the CSV agree.
export type TimelineRow = { id: string; when: string; whenIso: string; title: string; detail: string; owner: string; who: string };
export type TimelineUpcoming = { key: string; label: string; owner: string; due: string | null; next: boolean; late: boolean };

// The closing's shared log, oldest first, then the steps still open with the next one marked.
export function DealTimeline({ entries, upcoming, csvHref, live }: { entries: TimelineRow[]; upcoming: TimelineUpcoming[]; csvHref: string | null; live: boolean }) {
  return (
    <section aria-labelledby="timeline-heading" className="mt-10 glass p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="timeline-heading" className="eyebrow">Deal timeline</h2>
        {csvHref && (
          <a className="text-[13px] font-medium text-link" href={csvHref}>
            Download the log (CSV)
          </a>
        )}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Steps, files, wires, messages and date changes on this closing, oldest first. Each line says whose it is.
        {live ? " It refreshes every 30 seconds while this tab is open." : ""}
      </p>
      <ol className="mt-5 border-l border-border">
        {entries.map((entry) => (
          <li key={entry.id} className="relative pb-5 pl-5">
            <span aria-hidden="true" className="absolute -left-[5px] top-1.5 size-2.5 rounded-full bg-border" />
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <p className="text-sm font-medium text-foreground">{entry.title}</p>
              <time dateTime={entry.whenIso} className="text-xs text-muted-foreground tabular-nums">
                {entry.when}
              </time>
            </div>
            <p className="text-xs text-muted-foreground">{byLine(entry.owner, entry.who)}</p>
            {entry.detail && <p className="mt-1 break-words text-sm text-foreground/85 tabular-nums">{entry.detail}</p>}
          </li>
        ))}
        {upcoming.map((step) => (
          <li key={`open-${step.key}`} className="relative pb-5 pl-5">
            <span aria-hidden="true" className={`absolute -left-[6px] top-1.5 size-3 rounded-full border-2 ${step.next ? "border-link bg-link" : "border-border bg-card"}`} />
            <div className={step.next ? "rounded-lg border border-link/40 bg-link/5 px-3 py-2" : ""}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className="text-sm font-medium text-foreground">
                  {step.next ? <span className="mr-2 text-[13px] font-medium text-link">Next</span> : null}
                  {step.label}
                </p>
                {step.due && (
                  <p className={`text-xs tabular-nums ${step.late ? "text-bad" : "text-muted-foreground"}`}>
                    {step.late ? "Late · was due" : "Due"} {step.due}
                  </p>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{step.owner} to move · open</p>
            </div>
          </li>
        ))}
      </ol>
      {entries.length === 0 && upcoming.length === 0 && <p className="text-sm text-muted-foreground">Nothing on the log yet.</p>}
      {live && <LiveRefresh />}
    </section>
  );
}

function byLine(owner: string, who: string) {
  if (who === "The desk") return owner === "Desk" ? "Desk" : `${owner} · by the desk`;
  return `${owner} · by ${who}`;
}

const EVERY_MS = 30_000;

// Re-reads the page's server data every 30 seconds while the tab is in view, and once on coming back to it.
function LiveRefresh() {
  const router = useRouter();
  useEffect(() => {
    let last = Date.now();
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      last = Date.now();
      router.refresh();
    };
    const timer = window.setInterval(tick, EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - last >= EVERY_MS) tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);
  return null;
}
