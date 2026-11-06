import Link from "next/link";
import { notFound } from "next/navigation";
import { addEventListing, cancelSaleEvent, editSaleEvent, removeEventListing } from "@/actions/sale-events";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { bidModeLabel } from "@/components/listing-timeline";
import { Notice } from "@/components/notice";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { eventSetsTerms } from "@/lib/auction";
import { requireRole } from "@/lib/auth";
import { q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { currentSaleEvent, EVENT_STATUS_LABEL, FINAL_MAX_DAYS, FINAL_MIN_DAYS, FINAL_USUAL_DAYS, inputValue, joinBlock, leaveBlock, roundText, when } from "@/lib/sale-events";

export const metadata = { title: "Sale event" };

const LIVE = ["OPEN", "REVIEWED", "ACCEPTED"];

export default async function AdminEventPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole(["ADMIN"]);
  const { id } = await params;
  const query = await searchParams;
  // A round whose date passed moves before the page shows it. A failure here leaves it for the daily job.
  const { event } = await currentSaleEvent(id).catch(async () => ({ event: await prisma.saleEvent.findUnique({ where: { id } }) }));
  if (!event) notFound();
  const now = new Date();
  const [listings, candidates, openEvents] = await Promise.all([
    prisma.listing.findMany({
      where: { saleEventId: event.id },
      include: { seller: { select: { name: true, companyName: true } }, notes: { select: { id: true } }, inquiries: { where: { type: "OFFER" }, select: { status: true, createdAt: true, buyerId: true } } },
      orderBy: { approvedAt: "desc" },
    }),
    prisma.listing.findMany({
      where: { status: "APPROVED" },
      select: {
        id: true,
        title: true,
        status: true,
        saleEventId: true,
        seller: { select: { name: true, companyName: true } },
        inquiries: { where: { type: "OFFER", status: { in: ["OPEN", "REVIEWED", "ACCEPTED"] } }, select: { id: true } },
      },
      orderBy: { approvedAt: "desc" },
      take: 300,
    }),
    prisma.saleEvent.findMany({ where: { status: { in: ["PLANNED", "INDICATIONS", "BEST_AND_FINAL"] } }, select: { id: true, status: true } }),
  ]);
  const openStatus = new Map(openEvents.map((item) => [item.id, item.status]));
  // Live listings that could join: not already in an open event, and with no bids under their own terms.
  const eligible = candidates.filter((listing) => !joinBlock({
    event,
    listing,
    currentEventStatus: listing.saleEventId ? openStatus.get(listing.saleEventId) ?? null : null,
    liveBids: listing.inquiries.length,
    consent: "recorded",
    now,
  }));
  const taking = event.status === "PLANNED" || event.status === "INDICATIONS";
  const takingNow = taking && event.indicationsAt.getTime() > now.getTime();
  const sellers = new Set(listings.map((listing) => listing.sellerId)).size;
  const liveTotal = listings.reduce((sum, listing) => sum + listing.inquiries.filter((bid) => LIVE.includes(bid.status)).length, 0);
  const open = eventSetsTerms(event.status);
  const datesFixed = event.status === "BEST_AND_FINAL" || liveTotal > 0;
  const holder = (seller: { name: string; companyName: string | null }) => seller.companyName || seller.name;

  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0">
        <Link href="/admin/events" className="text-[13px] font-medium text-link">All events</Link>
        <Notice notice={q(query, "notice")} error={q(query, "error")} />
        <header className="mt-4">
          <p className="eyebrow">Sale event · {EVENT_STATUS_LABEL[event.status] ?? event.status}</p>
          <h1 className="mt-2 font-semibold tracking-tight text-[28px] leading-tight text-foreground">{event.name}</h1>
          {event.summary && <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">{event.summary}</p>}
          <dl className="mt-4 grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Indications due</dt>
              <dd className="mt-1 text-sm font-medium text-foreground tabular-nums">{when(event.indicationsAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Best and final due</dt>
              <dd className="mt-1 text-sm font-medium text-foreground tabular-nums">{when(event.bestFinalAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">On the calendar</dt>
              <dd className="mt-1 text-sm font-medium text-foreground tabular-nums">
                {listings.length} listing{listings.length === 1 ? "" : "s"} · {sellers} seller{sellers === 1 ? "" : "s"} · {liveTotal} live bid{liveTotal === 1 ? "" : "s"}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-sm text-foreground">{roundText(event)}</p>
        </header>

        <section aria-labelledby="event-listings" className="mt-8">
          <h2 id="event-listings" className="eyebrow">Listings</h2>
          <ul className="mt-3 divide-y divide-border border border-border rounded-xl">
            {listings.length === 0 && <li className="px-5 py-8 text-sm text-muted-foreground">No listings yet. Indications open when the first one joins.</li>}
            {listings.map((listing) => {
              const live = listing.inquiries.filter((bid) => LIVE.includes(bid.status));
              const indications = listing.inquiries.filter((bid) => bid.createdAt.getTime() < event.indicationsAt.getTime()).length;
              const finals = live.filter((bid) => bid.createdAt.getTime() >= event.indicationsAt.getTime()).length;
              const block = leaveBlock({ eventStatus: event.status, liveBids: live.length });
              return (
                <li key={listing.id} className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill status={listing.status} />
                      <span className="text-xs text-muted-foreground">{bidModeLabel(listing.bidMode)}</span>
                    </div>
                    <Link href={`/admin/listings/${listing.id}`} className="mt-1 block font-medium text-foreground hover:text-link">{listing.title}</Link>
                    <p className="mt-1 text-sm text-muted-foreground tabular-nums">
                      {holder(listing.seller)} · {listing.notes.length} loan{listing.notes.length === 1 ? "" : "s"} · {indications} indication{indications === 1 ? "" : "s"} · {finals} best-and-final bid{finals === 1 ? "" : "s"} open
                    </p>
                  </div>
                  {open && (block ? (
                    <p className="max-w-56 text-xs text-muted-foreground md:text-right">{block}</p>
                  ) : (
                    <form action={removeEventListing}>
                      <input type="hidden" name="eventId" value={event.id} />
                      <input type="hidden" name="listingId" value={listing.id} />
                      <ConfirmSubmit
                        title="Take this listing out of the event?"
                        consequence={`${listing.title} goes back to open offers with no deadline, and its seller is told.`}
                        confirmLabel="Take it out"
                        pendingLabel="Saving…"
                        variant="outline"
                        className="h-9 text-[13px] font-medium"
                      >
                        Take out
                      </ConfirmSubmit>
                    </form>
                  ))}
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <aside className="space-y-6">
        {takingNow ? (
          <form action={addEventListing} className="space-y-4 border border-border p-5 rounded-xl">
            <h2 className="eyebrow">Add a listing</h2>
            {eligible.length === 0 ? (
              <p className="text-sm text-muted-foreground">No live listing can join right now. A listing joins when it is live, outside another open event, and has no bids under its own terms.</p>
            ) : (
              <>
                <input type="hidden" name="eventId" value={event.id} />
                <label className="block">
                  <span className="text-[13px] text-muted-foreground">Live listing</span>
                  <select name="listingId" required className="desk-input mt-2">
                    {eligible.map((listing) => (
                      <option key={listing.id} value={listing.id}>{listing.title} · {holder(listing.seller)}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[13px] text-muted-foreground">How the seller agreed</span>
                  <input name="consent" required minLength={3} maxLength={300} className="desk-input mt-2" placeholder="The seller’s email and its date" />
                </label>
                <p className="text-xs leading-relaxed text-muted-foreground">The seller is emailed with what you record here. Their bid terms become the event&apos;s.</p>
                <ConfirmSubmit
                  title="Enter this listing in the event?"
                  consequence={`Its bid terms become the event's: sealed indications until ${when(event.indicationsAt)}, then one best-and-final bid each until ${when(event.bestFinalAt)}. Awards wait for that date. The seller is emailed with the agreement you recorded.`}
                  typed={[["Seller's agreement", "consent", "text"]]}
                  confirmLabel="Enter the listing"
                  pendingLabel="Adding…"
                  className="h-10 w-full text-[13px] font-medium"
                >
                  Add to the event
                </ConfirmSubmit>
              </>
            )}
          </form>
        ) : (
          open && <p className="border border-border p-5 text-sm text-muted-foreground rounded-xl">Indications are due, so no more listings join this event.</p>
        )}

        {open && (
          <form action={editSaleEvent} className="space-y-4 border border-border p-5 rounded-xl">
            <h2 className="eyebrow">Details</h2>
            <input type="hidden" name="eventId" value={event.id} />
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Name</span>
              <input name="name" required minLength={3} maxLength={120} defaultValue={event.name} className="desk-input mt-2" />
            </label>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Summary for buyers</span>
              <textarea name="summary" maxLength={1000} defaultValue={event.summary} className="desk-input mt-2 min-h-24" />
            </label>
            {datesFixed ? (
              <>
                <input type="hidden" name="indicationsAt" value={inputValue(event.indicationsAt)} />
                <input type="hidden" name="bestFinalAt" value={inputValue(event.bestFinalAt)} />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {event.status === "BEST_AND_FINAL" ? "Best and final is open, so the dates stay as printed." : "Bids are in, so the dates stay as printed."}
                </p>
              </>
            ) : (
              <>
                <label className="block">
                  <span className="text-[13px] text-muted-foreground">Indications due (UTC)</span>
                  <input name="indicationsAt" type="datetime-local" required defaultValue={inputValue(event.indicationsAt)} className="desk-input mt-2" />
                </label>
                <label className="block">
                  <span className="text-[13px] text-muted-foreground">Best and final due (UTC)</span>
                  <input name="bestFinalAt" type="datetime-local" required defaultValue={inputValue(event.bestFinalAt)} className="desk-input mt-2" aria-describedby="edit-final-hint" />
                </label>
                <p id="edit-final-hint" className="text-xs leading-relaxed text-muted-foreground">
                  {FINAL_MIN_DAYS} to {FINAL_MAX_DAYS} days after indications. {FINAL_USUAL_DAYS[0]} to {FINAL_USUAL_DAYS[1]} days is usual. Moved dates go to every seller in the event.
                </p>
              </>
            )}
            <SubmitButton variant="outline" className="h-10 w-full text-[13px] font-medium" pendingLabel="Saving…">Save the event</SubmitButton>
          </form>
        )}

        {open && (
          <form action={cancelSaleEvent} className="space-y-3 border border-border p-5 rounded-xl">
            <h2 className="eyebrow">Cancel</h2>
            <input type="hidden" name="eventId" value={event.id} />
            {liveTotal > 0 ? (
              <p className="text-sm text-muted-foreground">Bids are in, so the event runs to its dates. Take out the listings without bids instead.</p>
            ) : (
              <ConfirmSubmit
                title="Cancel this event?"
                consequence={`${event.name} comes off the calendar. ${listings.length} listing${listings.length === 1 ? "" : "s"} go back to open offers, and each seller is told. This can't be undone.`}
                confirmLabel="Cancel the event"
                pendingLabel="Canceling…"
                tone="danger"
                variant="outline"
                className="h-10 w-full text-[13px] font-medium"
              >
                Cancel the event
              </ConfirmSubmit>
            )}
          </form>
        )}
      </aside>
    </div>
  );
}
