"use client";

import { useActionState, useState } from "react";
import { changeCalendarFeed, type FeedState } from "@/actions/calendar";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/submit-button";

const empty: FeedState = { url: "", error: "", notice: "" };

// One private link a calendar app subscribes to. The link is shown once, when it is made, and only its hash is kept,
// so a lost link is replaced rather than shown again.
export function CalendarFeedControl({ active }: { active: boolean }) {
  const [state, action] = useActionState(changeCalendarFeed, empty);
  const [copied, setCopied] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(state.url);
      setCopied("yes");
      window.setTimeout(() => setCopied(""), 1800);
    } catch {
      setCopied("error");
    }
  }
  // The page's own reading lags a step behind the form, so the last answer wins.
  const on = state.notice ? false : active || Boolean(state.url);
  return (
    <section id="calendar" aria-labelledby="calendar-heading" className="glass mt-6 scroll-mt-6 space-y-3 p-6">
      <h2 id="calendar-heading" className="text-[15px] font-semibold tracking-tight text-foreground">Calendar feed</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        A private link to subscribe to in Google, Apple or Outlook. It carries bid deadlines on listings you saved, bid on or sell, sale event dates, your closing dates and papers to sign, and answers the desk is waiting on. Titles and dates only, never an amount. Anyone with the link can read it, so keep it to yourself.
      </p>
      {state.notice && <p role="status" className="rounded-xl border border-link/25 bg-link/5 px-4 py-3 text-sm text-foreground">{state.notice}</p>}
      {state.error && <p role="alert" className="rounded-xl border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">{state.error}</p>}
      {state.url && (
        <div role="status" className="space-y-3 rounded-xl border border-link/40 p-4">
          <p className="text-sm text-foreground">Copy this link now. It is shown once.</p>
          <input readOnly value={state.url} aria-label="Calendar feed link" onFocus={(event) => event.currentTarget.select()} className="desk-input font-mono text-xs" />
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={copy} className="min-h-10 rounded-lg border border-link/50 px-4 text-[13px] font-medium text-foreground">
              {copied === "yes" ? "Link copied" : "Copy link"}
            </button>
            {/^https?:\/\//.test(state.url) && (
              <a href={state.url.replace(/^https?:\/\//, "webcal://")} className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-[13px] font-medium text-foreground">
                Open in a calendar app
              </a>
            )}
          </div>
          {copied === "error" && <p className="text-sm text-bad">Copy is blocked in this browser. Select the link instead.</p>}
          <p className="text-xs text-muted-foreground">In Google Calendar, add it under Other calendars, From URL. Calendar apps check it every hour or so.</p>
        </div>
      )}
      {on ? (
        <div className="flex flex-wrap gap-2">
          {!state.url && <p className="w-full text-sm text-foreground">Your feed is on. If you lost the link, make a new one. The old one stops working.</p>}
          <form action={action}>
            <input type="hidden" name="intent" value="make" />
            <ConfirmSubmit
              title="Make a new calendar link?"
              consequence="The current link stops working at once, and calendars subscribed to it stop updating. Subscribe again with the new link."
              confirmLabel="Make a new link"
              pendingLabel="Making…"
              variant="outline"
              className="h-10 text-[13px] font-medium"
            >
              Make a new link
            </ConfirmSubmit>
          </form>
          <form action={action}>
            <input type="hidden" name="intent" value="off" />
            <ConfirmSubmit
              title="Turn off the calendar feed?"
              consequence="The link stops working at once, and calendars subscribed to it stop updating. You can make a new link later."
              confirmLabel="Turn it off"
              pendingLabel="Turning off…"
              tone="danger"
              variant="ghost"
              className="h-10 text-[13px] font-medium"
            >
              Turn off
            </ConfirmSubmit>
          </form>
        </div>
      ) : (
        <form action={action}>
          <input type="hidden" name="intent" value="make" />
          <SubmitButton className="h-11 text-[13px] font-medium" pendingLabel="Making…">Make a feed link</SubmitButton>
        </form>
      )}
    </section>
  );
}
