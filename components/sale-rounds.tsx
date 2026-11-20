import { saveFinalRoundFile, saveSaleRounds, saveShortlist } from "@/actions/sale-rounds";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/submit-button";
import { isPrivateDocument } from "@/lib/acl";
import { getCurrentUser } from "@/lib/auth";
import { money } from "@/lib/format";
import { docLabel } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { ROUND_GAP_DAYS, canRunRounds, canSetRounds, roundLabel, roundOneBook, roundsLine, twoRounds, type RoundListing, type RoundState } from "@/lib/sale-rounds";
import { inputValue, when } from "@/lib/sale-events";
import { trackLine, trackRecordsFor, type TrackRecord } from "@/lib/seller-decisions";

// A two-round sale on the page (lib/sale-rounds.ts holds the rules): the tag a bid carries, the line under a
// listing's title, the round state beside the bid form, and the panel where the seller and the desk run it.

// "Indicative, non-binding" or "Final bid" beside a bid. Nothing on a one-round sale.
export function RoundTag({ round }: { round: number | null | undefined }) {
  const label = roundLabel(round);
  if (!label) return null;
  return (
    <span className={`ml-1 inline-flex items-center rounded-md border px-1.5 py-0.5 align-middle text-[11px] font-medium ${round === 1 ? "border-warn/40 bg-warn/10 text-foreground" : "border-border text-foreground"}`}>
      {label}
    </span>
  );
}

// Under the listing's title: both dates, in UTC.
export function RoundsLine({ listing, className = "mt-3" }: { listing: RoundListing; className?: string }) {
  const line = roundsLine(listing);
  if (!line) return null;
  return <p className={`${className} max-w-3xl border border-link/30 bg-link/5 px-3 py-2 text-sm leading-relaxed text-foreground rounded-lg tabular-nums`}>Two rounds · {line}</p>;
}

// Beside the bid form: which round is open and where this viewer stands in it.
export function RoundRail({ state }: { state: RoundState }) {
  return (
    <div role="status" className="rounded-xl border border-link/30 bg-link/5 p-4">
      <p className="eyebrow">Two rounds</p>
      <p className="mt-1 text-sm font-medium text-foreground tabular-nums">{state.title}</p>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground tabular-nums">{state.line}</p>
    </div>
  );
}

const STATUS_TEXT: Record<string, string> = { OPEN: "open", REVIEWED: "open", ACCEPTED: "accepted", DECLINED: "closed", WITHDRAWN: "replaced or withdrawn", EXPIRED: "lapsed" };

// The seller's terms and the desk's listing page: the setting, round one's bids and the shortlist, and the files
// held for the final round. Bidders show by letter to the seller and by name to the desk.
export async function SaleRounds({ listingId, from, canEdit }: { listingId: string; from: "seller" | "admin"; canEdit: boolean }) {
  const viewer = await getCurrentUser();
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: {
      id: true, status: true, sellerId: true, brokerId: true, bidMode: true, bidDeadline: true, roundOneEndsAt: true, shortlistedAt: true, saleEventId: true, authorizationKey: true,
      documents: { where: { type: { not: "PHOTO" } }, orderBy: { createdAt: "asc" }, select: { id: true, type: true, noteId: true, storedName: true, originalName: true, finalRoundOnly: true } },
    },
  });
  if (!viewer || !listing) return null;
  const desk = from === "admin";
  const two = twoRounds(listing);
  const termsOpen = ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED"].includes(listing.status);
  const bids = await prisma.inquiry.count({ where: { listingId: listing.id, type: "OFFER" } });
  const sets = canEdit && canSetRounds(viewer, listing);
  const runs = canEdit && canRunRounds(viewer, listing);
  // A one-round listing shows this only to someone who can still switch two rounds on.
  if (!two && (!termsOpen || listing.saleEventId || !sets || bids > 0)) return null;
  const book = two ? await roundOneBook(listing.id, viewer) : null;
  // Each bidder's record beside their letter, as on the seller's other bid lists. The desk has its bid sheet.
  const records: Map<string, TrackRecord> = book && !desk ? await trackRecordsFor(book.rows) : new Map();
  const roomFiles = listing.documents.filter((document) => !isPrivateDocument(document, listing));
  const choosing = book?.stage === "SHORTLIST" && listing.status === "APPROVED";
  const choices = book ? book.rows.filter((row) => row.live) : [];
  return (
    <section id="sale-rounds" aria-labelledby="sale-rounds-heading" className={desk ? "mt-6 scroll-mt-6 rounded-xl border border-border p-5" : "mt-5 scroll-mt-6"}>
      <p id="sale-rounds-heading" className={desk ? "eyebrow" : "text-[13px] font-semibold text-foreground"}>Two rounds</p>
      {two ? (
        <p className="mt-1 text-sm text-foreground tabular-nums">{roundsLine(listing)}.</p>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">
          One round. A two-round sale takes indicative bids first, which bind nobody, then binding final bids from a shortlist{desk ? " the seller and the desk choose" : " you and the desk choose"}. It runs on sealed bids, and the bid deadline is the final round&apos;s.
        </p>
      )}
      {listing.roundOneEndsAt && !two && termsOpen && (
        <p className="mt-2 text-sm text-foreground">A round-one date is on file, but the bid terms no longer fit it, so this sale runs one round. Set the two rounds again to use them.</p>
      )}

      {/* The setting, until a bid is in. */}
      {termsOpen && !listing.saleEventId && (bids > 0 ? (
        two && <p className="mt-2 text-sm text-muted-foreground">Bids are in, so the rounds are fixed until this sale ends.</p>
      ) : sets ? (
        <form action={saveSaleRounds} className="mt-3 space-y-3">
          <input type="hidden" name="listingId" value={listing.id} />
          <label className="flex min-h-10 items-start gap-3 text-sm text-foreground">
            <input type="checkbox" name="twoRounds" value="on" defaultChecked={two} className="mt-1 size-4 shrink-0" />
            <span className="min-w-0">Run this sale in two rounds</span>
          </label>
          <label className="block max-w-xs">
            <span className="text-[13px] text-muted-foreground">Indicative bids due (UTC)</span>
            <input name="roundOneEndsAt" type="datetime-local" defaultValue={inputValue(listing.roundOneEndsAt)} className="desk-input mt-2 tabular-nums" />
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Both dates in the future, with at least {ROUND_GAP_DAYS} days between round one and the bid deadline{listing.bidMode === "SEALED" && listing.bidDeadline ? `, now ${when(listing.bidDeadline)}` : ". Set the bid style to sealed with that deadline first"}. The setting locks once a bid is in.
          </p>
          <SubmitButton variant="outline" pendingLabel="Saving…" className="h-11 w-full text-[13px] font-medium sm:w-auto">Save the rounds</SubmitButton>
        </form>
      ) : canEdit && !desk ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {two ? "The desk set up these rounds. Write the desk to change them before a bid is in." : "Two rounds are for institutional sellers and brokers. The desk can set them up for you."}
        </p>
      ) : null)}

      {/* Round one's bids, and the shortlist once round one closes. */}
      {book && (
        <div className="mt-4 border-t border-border pt-4">
          <p className="text-[13px] font-semibold text-foreground">Round one</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {book.rows.length === 0
              ? "No indicative bids yet."
              : book.sealed
                ? `${book.rows.length} indicative bid${book.rows.length === 1 ? "" : "s"} in. ${desk ? "Your desk role doesn't read sealed bids, so the amounts stay hidden." : `The amounts stay sealed until ${when(listing.roundOneEndsAt!)}.`}`
                : book.stage === "ONE"
                  ? `Indicative bids so far, behind the desk's wall: the seller sees amounts after ${when(listing.roundOneEndsAt!)}. None of them binds the bidder or can be awarded.`
                  : "Indicative bids as they stood when round one closed. None of them binds the bidder or can be awarded."}
            {listing.shortlistedAt ? ` The shortlist was set ${when(listing.shortlistedAt)}.` : ""}
          </p>
          {book.stage === "ENDED" && !listing.shortlistedAt && (
            <p className="mt-2 text-sm text-foreground">No shortlist was set before the final deadline, so this sale ended with no award.</p>
          )}
          {choosing && runs && choices.length > 0 ? (
            <form action={saveShortlist} className="mt-3 space-y-3">
              <input type="hidden" name="listingId" value={listing.id} />
              <fieldset className="min-w-0">
                <legend className="text-[13px] text-muted-foreground">Choose who bids in the final round</legend>
                <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
                  {choices.map((row) => (
                    <li key={row.id} className="px-3 py-2">
                      <label className="flex min-h-10 items-start gap-3 text-sm text-foreground">
                        <input type="checkbox" name="inquiryId" value={row.id} className="mt-1 size-4 shrink-0" />
                        <RoundRow row={row} record={records.get(row.id)} />
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
              <ConfirmSubmit
                title="Set the shortlist?"
                consequence={`Each bidder you chose is told they're in the final round, with final bids due ${when(listing.bidDeadline!)}, and the final-round files open to them. Every other indicative bid closes, and its bidder gets a short notice that names no amount and no other bidder. The shortlist can't be changed afterwards.`}
                confirmLabel="Set the shortlist"
                pendingLabel="Saving…"
                className="h-11 w-full text-[13px] font-medium sm:w-auto"
              >
                Set the shortlist
              </ConfirmSubmit>
            </form>
          ) : (
            book.rows.length > 0 && (
              <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
                {book.rows.map((row) => (
                  <li key={row.id} className="px-3 py-2 text-sm">
                    <RoundRow row={row} record={records.get(row.id)} />
                  </li>
                ))}
              </ul>
            )
          )}
          {choosing && !runs && <p className="mt-2 text-sm text-muted-foreground">The seller and the sales desk choose the shortlist.</p>}
          {(book.stage === "FINAL" || (book.stage === "ENDED" && listing.shortlistedAt)) && (
            <p className="mt-3 text-sm text-muted-foreground">
              {book.finalBids} final bid{book.finalBids === 1 ? "" : "s"} in from the shortlist. They stay sealed until {when(listing.bidDeadline!)}, and awards come from them only.
            </p>
          )}
        </div>
      )}

      {/* Files held back until a bidder is shortlisted. Their names and types still show in the room. */}
      {two && (
        <div className="mt-4 border-t border-border pt-4">
          <p className="text-[13px] font-semibold text-foreground">Final-round files</p>
          <p className="mt-1 text-sm text-muted-foreground">A file marked final round only shows in the data room, but opens only to shortlisted bidders.</p>
          {roomFiles.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No files in the data room yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
              {roomFiles.map((document) => (
                <li key={document.id} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="break-all text-sm text-foreground">{document.originalName}</p>
                    <p className="text-[13px] text-muted-foreground">{docLabel(document.type)} · {document.finalRoundOnly ? "final round only" : "open to every bidder in the room"}</p>
                  </div>
                  {runs && (
                    <form action={saveFinalRoundFile} className="shrink-0">
                      <input type="hidden" name="listingId" value={listing.id} />
                      <input type="hidden" name="documentId" value={document.id} />
                      <input type="hidden" name="finalRoundOnly" value={document.finalRoundOnly ? "off" : "on"} />
                      <SubmitButton variant="outline" pendingLabel="Saving…" className="h-10 w-full text-[13px] font-medium sm:w-auto">
                        {document.finalRoundOnly ? "Open to every bidder" : "Final round only"}
                      </SubmitButton>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function RoundRow({ row, record }: { row: { bidder: string; scope: string; price: number | null; status: string; shortlisted: boolean }; record: TrackRecord | undefined }) {
  return (
    <span className="min-w-0 break-words">
      <span className="font-medium">{row.bidder}</span>
      {row.price != null && <span className="tabular-nums"> · {money(row.price)}</span>}
      <span className="block text-[13px] text-muted-foreground">
        {row.scope} · indicative, non-binding · {row.shortlisted ? "shortlisted" : STATUS_TEXT[row.status] ?? row.status.toLowerCase()}
      </span>
      {record && <span className="block text-[13px] text-muted-foreground tabular-nums">{trackLine(record)}</span>}
    </span>
  );
}
