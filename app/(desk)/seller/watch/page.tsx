import Link from "next/link";
import { addNoteToWatch, deleteNoteFromWatch, setNoteWatchAlerts } from "@/actions/note-watch";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { buttonVariants } from "@/components/ui/button";
import { requireRole } from "@/lib/auth";
import { prettyDate, q } from "@/lib/format";
import { changeText, demandText, LIMIT_TEXT, MAX_WATCHED, rangeText, WATCH_DISCLAIMER, watchedNotes } from "@/lib/note-watch";
import { WatchForm } from "./watch-form";

export const metadata = { title: "Note watch" };
export const dynamic = "force-dynamic";

const ACTION = "h-10 w-full px-4 text-[13px] font-medium sm:w-auto";

// The holder's own watched notes. Each is private to them until it is listed: the desk sees only how many there are.
export default async function NoteWatchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireRole(["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER"]);
  const [params, notes] = await Promise.all([searchParams, watchedNotes(user.id)]);
  const full = notes.length >= MAX_WATCHED;
  return (
    <div>
      <PageIntro
        eyebrow="Note watch"
        title="Notes you aren't ready to sell."
        lede="Save a note you hold. Once a month the desk reads what it would price at and how many buyers' boxes fit it, and emails you what changed. List it when you're ready."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />

      <section aria-labelledby="watched-heading" className="mt-6 space-y-3">
        <h2 id="watched-heading" className="eyebrow">
          Your notes · {notes.length} of {MAX_WATCHED}
        </h2>
        {notes.length === 0 && <p className="glass p-5 text-sm text-muted-foreground">No notes on watch yet. Add one below.</p>}
        <ul className="space-y-3">
          {notes.map((note) => {
            const range = rangeText(note);
            const change = changeText(note);
            return (
              <li key={note.id} id={`note-${note.id}`} className="glass scroll-mt-6 p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <h3 className="min-w-0 break-words text-[15px] font-medium text-foreground">{note.label}</h3>
                  <span className="figure inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap text-muted-foreground">
                    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
                    {note.listingId ? "Listed" : note.alertsOn ? "Monthly email on" : "Monthly email off"}
                  </span>
                </div>
                <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
                  <div className="min-w-0">
                    <dt className="text-[13px] text-muted-foreground">Indicative range</dt>
                    <dd className="mt-0.5 text-foreground tabular-nums">{range ? range.money : "Not read yet"}</dd>
                    {range && <dd className="text-[13px] text-muted-foreground tabular-nums">{range.share}</dd>}
                  </div>
                  <div className="min-w-0">
                    <dt className="text-[13px] text-muted-foreground">Buyer demand</dt>
                    <dd className="mt-0.5 text-foreground tabular-nums">{demandText(note.lastDemand)}</dd>
                    {note.lastDemand != null && <dd className="text-[13px] text-muted-foreground">whose boxes fit it</dd>}
                  </div>
                  <div className="min-w-0">
                    <dt className="text-[13px] text-muted-foreground">Last read</dt>
                    <dd className="mt-0.5 text-foreground tabular-nums">{note.lastValuedAt ? prettyDate(note.lastValuedAt) : "Not yet"}</dd>
                  </div>
                </dl>
                <p className="mt-3 text-sm text-muted-foreground">{change ?? (note.lastValuedAt ? "First reading. The next one says what moved." : "The reading comes with the next daily run.")}</p>
                {note.listingId ? (
                  <div className="mt-4 grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center">
                    <Link href={`/seller/listings/${note.listingId}`} className={buttonVariants({ className: ACTION })}>
                      Open the listing
                    </Link>
                    <DeleteForm id={note.id} label={note.label} />
                  </div>
                ) : (
                  <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
                    <Link href={`/seller/watch/${note.id}/list`} className={buttonVariants({ className: ACTION })}>
                      List it
                    </Link>
                    <Link href={`/seller/watch/${note.id}`} className={buttonVariants({ variant: "outline", className: ACTION })}>
                      Edit
                    </Link>
                    <form action={setNoteWatchAlerts} className="contents">
                      <input type="hidden" name="noteId" value={note.id} />
                      <SubmitButton variant="outline" name="alerts" value={note.alertsOn ? "off" : "on"} className={ACTION} pendingLabel="Saving…">
                        {note.alertsOn ? "Stop alerts" : "Start alerts"}
                      </SubmitButton>
                    </form>
                    <DeleteForm id={note.id} label={note.label} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {notes.length > 0 && <p className="text-xs leading-relaxed text-muted-foreground">{WATCH_DISCLAIMER} A listed note leaves the monthly email.</p>}
      </section>

      <section id="add" aria-labelledby="add-heading" className="mt-10 scroll-mt-6 space-y-3">
        <h2 id="add-heading" className="eyebrow">Add a note</h2>
        {full ? (
          <p className="glass p-5 text-sm text-muted-foreground">{LIMIT_TEXT}</p>
        ) : (
          <WatchForm action={addNoteToWatch} submitLabel="Watch this note" pendingLabel="Reading…" />
        )}
      </section>
    </div>
  );
}

function DeleteForm({ id, label }: { id: string; label: string }) {
  return (
    <form action={deleteNoteFromWatch} className="contents">
      <input type="hidden" name="noteId" value={id} />
      <ConfirmSubmit
        title={`Delete ${label}?`}
        consequence="It comes off your watch with its readings, and the monthly email stops covering it. A listing made from it stays as it is."
        confirmLabel="Delete it"
        pendingLabel="Deleting…"
        tone="danger"
        variant="outline"
        className={ACTION}
      >
        Delete
      </ConfirmSubmit>
    </form>
  );
}
