"use client";

import { useActionState, useState } from "react";
import { previewBidTape, submitBidTape, type BidTapeState } from "@/actions/bid-tape";
import { ConfirmRows, ConfirmSubmit } from "@/components/confirm-submit";
import { CovenantAck } from "@/components/covenant-ack";
import { EntityField, type EntityOption } from "@/components/entity-picker";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { BidCovenants } from "@/lib/covenants";
import { premiumOn, type FeeTerms } from "@/lib/fee-schedule";
import { money } from "@/lib/format";
import { bidTerms, goodUntilRow } from "@/lib/offers";
import { bidTarget, credentialRows, headroomAfter, type BidStanding } from "@/lib/verification";

const empty: BidTapeState = { error: "", problems: [], preview: null };

const tapeHref = (listingId: string, format: "csv" | "xlsx", bid?: string) =>
  `/api/listings/${listingId}/bid-tape?format=${format}${bid ? `&bid=${encodeURIComponent(bid)}` : ""}`;

// The pool's bid template, and each of the buyer's own priced bids here as a filled tape, above the loan tape.
export function BidTapeLinks({ listingId, template, bids }: { listingId: string; template: boolean; bids: { id: string; label: string }[] }) {
  if (!template && !bids.length) return null;
  return (
    <p className="mt-2 flex flex-wrap gap-x-4 text-[13px] font-medium">
      {template && (
        <a href={tapeHref(listingId, "csv")} className="inline-flex min-h-10 items-center text-link">
          Download the bid template
        </a>
      )}
      {bids.map((bid) => (
        <a key={bid.id} href={tapeHref(listingId, "csv", bid.id)} className="inline-flex min-h-10 items-center text-link">
          {bid.label}
        </a>
      ))}
    </p>
  );
}

// "Upload a bid tape" on the pool bid form: the buyer prices the loans in their own spreadsheet, the server reads it
// into a preview, and the buyer confirms it with the same terms and ticks the typed form asks for. Placing it runs
// every check a typed bid meets (lib/bid-tape.ts).
export function BidTapeUpload({
  listingId,
  terms,
  deposit,
  diligenceDays,
  notice,
  credential,
  entity,
  buyingAs,
  covenants,
  covenantRows,
  round = null,
}: {
  listingId: string;
  terms: FeeTerms;
  deposit?: [number, number];
  diligenceDays?: number;
  // The listing's eligibility notices, restated in the confirmation as the typed form does.
  notice: string;
  credential: BidStanding["credential"];
  entity: EntityOption | null;
  buyingAs: [string, string][];
  covenants: BidCovenants | null;
  covenantRows: [string, string][];
  // On a two-round sale, the round the bid goes into, worded as the typed form words it (lib/sale-rounds.ts).
  round?: "INDICATIVE" | "FINAL" | null;
}) {
  const [state, read] = useActionState(previewBidTape, empty);
  const [allow, setAllow] = useState(false);
  const [goodUntil, setGoodUntil] = useState("");
  const preview = state.preview;
  const total = preview?.total ?? 0;
  const premium = premiumOn(terms, total);
  const room = total > 0 ? headroomAfter(credential, bidTarget(listingId, null), total + premium) : null;
  return (
    <details id="bid-tape" className="mt-3 scroll-mt-6 rounded-lg border border-border px-3 py-0.5">
      <summary className="cursor-pointer py-2.5 text-[13px] font-medium text-foreground">Upload a bid tape instead</summary>
      <div className="mt-1 space-y-3 pb-2.5">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Price the loans in your own spreadsheet. Fill in the Bid price column of the bid template and upload it here. Rows are matched by loan ref, so columns of your own can stay.
        </p>
        <p className="flex flex-wrap gap-x-4 text-[13px] font-medium">
          <a href={tapeHref(listingId, "csv")} className="inline-flex min-h-10 items-center text-link">Bid template (CSV)</a>
          <a href={tapeHref(listingId, "xlsx")} className="inline-flex min-h-10 items-center text-link">Excel</a>
        </p>
        <form action={read} className="space-y-2">
          <input type="hidden" name="listingId" value={listingId} />
          <label className="block text-[13px] text-muted-foreground">
            Your bid tape
            <input type="file" name="file" required accept=".csv,.xlsx,.xls" className="mt-1 block w-full min-w-0 text-sm text-foreground" />
          </label>
          <SubmitButton variant="outline" className="h-10 w-full text-[13px] font-medium" pendingLabel="Reading…">
            Read the tape
          </SubmitButton>
        </form>
        {state.error && (
          <div role="alert" className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-xs leading-relaxed text-bad">
            <p className="break-words">{state.error}</p>
            {state.problems.length > 0 && (
              <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
                {state.problems.map((problem) => <li key={problem} className="break-all">{problem}</li>)}
              </ul>
            )}
          </div>
        )}
        {preview && (
          <form action={submitBidTape} className="space-y-3">
            <input type="hidden" name="listingId" value={listingId} />
            <input type="hidden" name="tapePrices" value={preview.prices} />
            <input type="hidden" name="tapeName" value={preview.fileName} />
            <EntityField chosen={entity} />
            {/* The total first, so on a phone it reads before the list of loans. */}
            <section aria-label="Your bid tape" className="space-y-2 rounded-lg border border-border p-3">
              <p className="break-all text-xs text-muted-foreground">{preview.fileName}</p>
              <div className="space-y-1 text-sm text-muted-foreground tabular-nums">
                <div className="flex justify-between gap-3 font-semibold tracking-tight text-lg text-foreground">
                  <span>{round === "INDICATIVE" ? "Your indicative bid" : round === "FINAL" ? "Your final bid" : "Your bid"}</span><span>{money(total, 2)}</span>
                </div>
                <div className="flex justify-between gap-3"><span>Loans priced</span><span className="text-foreground">{preview.count}</span></div>
                {preview.pctOfUpb != null && preview.upb != null && (
                  <div className="flex justify-between gap-3"><span>Of UPB {money(preview.upb)}</span><span className="text-foreground">{preview.pctOfUpb.toFixed(2)}%</span></div>
                )}
                <div className="flex justify-between gap-3"><span>Buyer premium</span><span className="text-foreground">{money(premium)}</span></div>
                <div className="flex justify-between gap-3 border-t border-border pt-2 text-foreground"><span>All-in</span><span>{money(total + premium)}</span></div>
                {room != null && (
                  <div className={`flex justify-between gap-3 ${room < 0 ? "text-bad" : ""}`}>
                    <span>Headroom after this bid</span><span className={room < 0 ? "" : "text-foreground"}>{money(room)}</span>
                  </div>
                )}
              </div>
              {room != null && room < 0 && <p className="text-xs text-bad">This all-in is over your verified funds, so the desk will refuse it. Bid less, or withdraw another bid.</p>}
              {preview.over > 0 && (
                <p className="text-xs leading-relaxed text-warn">
                  {preview.over === 1 ? "One loan is" : `${preview.over} loans are`} priced above {preview.over === 1 ? "its" : "their"} UPB. That can stand; check the figures before you confirm.
                </p>
              )}
              {preview.upb == null && <p className="text-xs text-muted-foreground">Price to UPB shows on Pro, like the balances.</p>}
              <ul className="max-h-72 divide-y divide-border overflow-y-auto pr-1">
                {preview.rows.map((row) => (
                  <li key={row.ref} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2 text-xs">
                    <span className="min-w-0 flex-1 text-muted-foreground">{row.label}</span>
                    <span className="tabular-nums text-foreground">{money(row.price, 2)}</span>
                    {row.over && row.upb != null && <span className="w-full text-warn tabular-nums">Above its UPB of {money(row.upb)}</span>}
                  </li>
                ))}
              </ul>
            </section>
            <label className="flex items-start gap-2 text-sm text-foreground">
              <input type="checkbox" name="allowPartial" value="yes" checked={allow} onChange={(event) => setAllow(event.target.checked)} className="mt-1 size-4 shrink-0" />
              <span>
                The seller may take part of the pool at these loan prices
                <span className="block text-xs text-muted-foreground">The desk can then award you some of the loans at your prices and sell the rest to other buyers.</span>
              </span>
            </label>
            <details className="rounded-lg border border-border px-3 py-0.5">
              <summary className="cursor-pointer py-2.5 text-[13px] font-medium text-foreground">Good-until date or a note (optional)</summary>
              <div className="mt-1 space-y-4 pb-2.5">
                <label className="block text-[13px] text-muted-foreground">
                  Good until (optional)
                  <Input name="goodUntil" type="date" value={goodUntil} onChange={(event) => setGoodUntil(event.target.value)} className="mt-1 h-11 bg-card" />
                  <span className="mt-1 block text-xs">Leave it blank and the bid stands until you withdraw it or the desk decides it.</span>
                </label>
                <label className="block text-[13px] text-muted-foreground">
                  Note to the desk (optional)
                  <Textarea name="message" placeholder="Terms, proof of funds, questions" className="mt-1 min-h-20 bg-card" />
                </label>
              </div>
            </details>
            <CovenantAck covenants={covenants} />
            <ConfirmSubmit
              title={round === "INDICATIVE" ? `Send an indicative bid of ${money(total, 2)} by tape?` : `Bid ${money(total, 2)} by tape?`}
              consequence={round === "INDICATIVE"
                ? `An indicative bid isn't binding, and it can't be accepted or awarded. The seller and the desk read it to choose a shortlist. If your firm is on it, you place a binding final bid, which can be higher or lower.${notice}`
                : `If the desk accepts it, you're committed to buy ${allow ? "the whole pool, or the part of it the desk awards at your loan prices," : "at this price"} plus the buyer premium${deposit ? `, and a ${deposit[0]}% deposit is due within ${deposit[1]} day${deposit[1] === 1 ? "" : "s"}` : ""}.${bidTerms(diligenceDays)}${notice}`}
              details={
                <ConfirmRows
                  rows={[
                    ["Your bid", money(total, 2)],
                    ["Buyer premium", money(premium)],
                    ["All-in", money(total + premium)],
                    ["Loan prices", `${preview.count} loans from your bid tape`],
                    ["Part of the pool", allow ? "The seller may take part at your loan prices" : "Whole pool only"],
                    ...buyingAs,
                    ...credentialRows(credential?.line ?? null, room),
                    goodUntilRow(goodUntil),
                    ...covenantRows,
                  ]}
                />
              }
              confirmLabel="Place the bid"
              pendingLabel="Sending…"
              className="h-11 w-full text-[13px] font-medium"
            >
              {round === "INDICATIVE" ? "Submit as an indicative bid" : round === "FINAL" ? "Submit as your final bid" : "Submit the bid tape"}
            </ConfirmSubmit>
          </form>
        )}
      </div>
    </details>
  );
}
