import type { Metadata } from "next";
import { Check } from "lucide-react";
import { Logo } from "@/components/logo";
import { prettyDate } from "@/lib/format";
import { guestRoleNoun, openGuestPass, type GuestOpening } from "@/lib/guest-access";
import { requestMeta } from "@/lib/request-meta";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// The token is in this page's URL, so it must not travel in a Referer header, and the page stays out of search.
export const metadata: Metadata = { title: "Guest access", referrer: "no-referrer", robots: { index: false, follow: false } };

// The link in a guest pass (lib/guest-access.ts): an outside party reads one closing or one data room, as the side that
// invited them sees it, without an account. Nothing here reads or sets a session. A link that ended, or one that
// never was, says only that.
export default async function GuestPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { ipAddress } = await requestMeta();
  const opening = await openGuestPass(token, { ip: ipAddress });
  return (
    <main id="desk" className="mx-auto min-h-screen w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <Logo />
      {opening.state === "ended" || opening.state === "limited" ? (
        <Closed limited={opening.state === "limited"} />
      ) : (
        <>
          <p className="eyebrow mt-10">Guest access · {opening.state === "closing" ? "closing" : "data room"}</p>
          <h1 className="mt-3 break-words font-semibold tracking-tight text-[28px] text-foreground">{opening.view.title}</h1>
          {opening.state === "closing" && <p className="mt-2 text-sm text-muted-foreground">{opening.view.parties}</p>}
          <Invitation opening={opening} />
          {opening.state === "closing" ? <ClosingView token={token} view={opening.view} /> : <RoomView token={token} view={opening.view} />}
        </>
      )}
    </main>
  );
}

function Closed({ limited }: { limited: boolean }) {
  return (
    <>
      <p className="eyebrow mt-12">Guest access</p>
      <h1 className="mt-3 font-semibold tracking-tight text-[28px] text-foreground">{limited ? "Too many requests." : "This link has ended."}</h1>
      <p className="mt-4 text-sm text-muted-foreground">{limited ? "Wait a minute and try again." : "Ask whoever sent it for a new one."}</p>
    </>
  );
}

const sideText = (side: string) => (side === "SELLER" ? "the seller" : side === "DESK" ? "the desk" : "the buyer");

// Who invited the guest and what they can see, said plainly before anything else.
function Invitation({ opening }: { opening: Extract<GuestOpening, { state: "closing" | "room" }> }) {
  const side = sideText(opening.side);
  const reads = opening.state === "closing"
    ? `You can read this closing as ${side} sees it: its steps, its documents, the trailing documents and the deal log.`
    : `You can read and download the files in this data room that ${side} may open, under the same rules.`;
  return (
    <div className="mt-6 border border-link/30 bg-link/5 p-4 text-sm leading-relaxed text-foreground rounded-xl">
      <p>
        <span className="break-words">{opening.inviter}</span> invited <span className="break-words">{opening.name}</span> as {opening.side === "DESK" ? "its" : "their"} {guestRoleNoun(opening.role)}. {reads}
      </p>
      <p className="mt-2 text-muted-foreground">
        Nothing else on UPB Capital opens to this link: no bids, no wire instructions and no other party&apos;s identity records. It ends {prettyDate(opening.expiresAt)}, or sooner if {opening.side === "DESK" ? "the desk" : `${side} or the desk`} ends it. Each file you download carries your name and is logged.
      </p>
    </div>
  );
}

type ClosingData = Extract<GuestOpening, { state: "closing" }>["view"];
type RoomData = Extract<GuestOpening, { state: "room" }>["view"];

function ClosingView({ token, view }: { token: string; view: ClosingData }) {
  const base = `/guest/${token}`;
  const status = view.status === "COMPLETE"
    ? `Closed${view.closedAt ? ` ${prettyDate(view.closedAt)}` : ""}.`
    : view.target ? `Open · target close ${prettyDate(view.target)}.` : "Open.";
  return (
    <>
      <p className="mt-6 text-sm font-medium text-foreground">{status}</p>
      <section aria-labelledby="steps-heading" className="mt-6">
        <h2 id="steps-heading" className="eyebrow">Steps</h2>
        <ol className="mt-3 space-y-2">
          {view.steps.map((step, index) => (
            <li key={step.key} className="flex items-start gap-3 border border-border p-3 rounded-xl">
              <span aria-hidden className={cn("grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-semibold", step.done ? "bg-good/12 text-good" : "bg-muted text-muted-foreground")}>
                {step.done ? <Check className="size-3.5" strokeWidth={2.5} /> : index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <p className="text-sm font-medium text-foreground">{step.label}</p>
                  <p className={cn("text-[13px] font-medium", step.done ? "text-good" : "text-muted-foreground")}>{step.done ? "Complete" : "Open"}</p>
                </div>
                {step.done && step.completedAt && <p className="text-xs text-muted-foreground">{prettyDate(step.completedAt)}</p>}
                {!step.done && step.due && <p className="text-xs text-muted-foreground">Due {prettyDate(step.due)}</p>}
              </div>
            </li>
          ))}
        </ol>
      </section>
      <section aria-labelledby="documents-heading" className="mt-8">
        <h2 id="documents-heading" className="eyebrow">Documents</h2>
        <p className="mt-2 text-sm text-muted-foreground">The closing papers as they stand, filled from the deal, and the files the parties added to each step.</p>
        <ul className="mt-3 space-y-2 text-sm">
          {view.papers.map((paper) => (
            <li key={paper.kind}>
              <a className="inline-flex min-h-10 items-center break-words text-link" rel="nofollow" href={`${base}/paper/${paper.kind}`}>{paper.label}</a>
            </li>
          ))}
          {view.files.map((file) => (
            <li key={file.id} className="min-w-0">
              <a className="inline-flex min-h-10 items-center break-all text-link" rel="nofollow" href={`${base}/file/${file.id}`}>{file.name}</a>
              <span className="block text-xs text-muted-foreground">{file.step} · added {prettyDate(file.at)}</span>
            </li>
          ))}
        </ul>
      </section>
      {view.trailing.length > 0 && (
        <section aria-labelledby="trailing-heading" className="mt-8">
          <h2 id="trailing-heading" className="eyebrow">Trailing documents</h2>
          <ul className="mt-3 space-y-2">
            {view.trailing.map((doc) => (
              <li key={doc.id} className="border border-border p-3 rounded-xl">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <p className="min-w-0 break-words text-sm font-medium text-foreground">{doc.label}</p>
                  <p className="text-[13px] font-medium text-muted-foreground">{doc.status}</p>
                </div>
                <p className="break-words text-xs text-muted-foreground">
                  {doc.loan ? `${doc.loan} · ` : ""}From the {doc.from.toLowerCase()} · due {prettyDate(doc.dueAt)}
                  {doc.sentAt ? ` · sent ${prettyDate(doc.sentAt)}` : ""}
                  {doc.receivedAt ? ` · received ${prettyDate(doc.receivedAt)}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="log-heading" className="mt-8">
        <h2 id="log-heading" className="eyebrow">Deal log</h2>
        <p className="mt-2 text-sm text-muted-foreground">Steps, files, dates and custody on this closing, oldest first. Wire records and messages between the parties are left out.</p>
        <ol className="mt-4 border-l border-border">
          {view.timeline.entries.map((entry) => (
            <li key={entry.id} className="relative pb-5 pl-5">
              <span aria-hidden="true" className="absolute -left-[5px] top-1.5 size-2.5 rounded-full bg-border" />
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className="text-sm font-medium text-foreground">{entry.title}</p>
                <time dateTime={entry.whenIso} className="text-xs text-muted-foreground tabular-nums">{entry.when}</time>
              </div>
              <p className="text-xs text-muted-foreground">{entry.owner} · {entry.who}</p>
              {entry.detail && <p className="mt-1 break-words text-sm text-foreground/85">{entry.detail}</p>}
            </li>
          ))}
          {view.timeline.upcoming.map((step) => (
            <li key={step.key} className="relative pb-5 pl-5">
              <span aria-hidden="true" className={cn("absolute -left-[5px] top-1.5 size-2.5 rounded-full border", step.next ? "border-link bg-link" : "border-border bg-background")} />
              <p className="text-sm text-foreground">{step.label}{step.next ? " · next" : ""}</p>
              <p className={cn("text-xs", step.late ? "text-bad" : "text-muted-foreground")}>{step.owner}{step.due ? ` · due ${step.due}` : ""}{step.late ? " · late" : ""}</p>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

function RoomView({ token, view }: { token: string; view: RoomData }) {
  return (
    <section aria-labelledby="files-heading" className="mt-8">
      <h2 id="files-heading" className="eyebrow">Files</h2>
      {view.files.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No files are open to this link yet.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {view.files.map((file) => (
            <li key={file.id} className="min-w-0 border border-border p-3 rounded-xl">
              <a className="inline-flex min-h-10 items-center break-all text-sm text-link" rel="nofollow" href={`/api/documents/${file.id}?guest=${token}`}>{file.name}</a>
              <span className="block text-xs text-muted-foreground">{file.label}{file.loan ? ` · ${file.loan}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
