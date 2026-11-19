import Link from "next/link";
import { saveBidderLimits } from "@/actions/attestations-bidder";
import { SubmitButton } from "@/components/submit-button";
import { ATTESTATION_KEYS, ATTESTATIONS_HREF, bidderLimitLines, bidsIn, kindOf, lastsLine, limitsOpen, offersRegulatedSwitch, requiredKinds } from "@/lib/attestations";
import { REGULATED_ONLY_LINE, REGULATED_SWITCH, regulatedOnly } from "@/lib/institutions";
import { prisma } from "@/lib/prisma";

// Who may bid on a listing, and what each bidder needs on file (lib/institutions.ts, lib/attestations.ts). The seller
// sets it under their terms and the desk on its listing page. Bids in lock it against tightening.

export async function BidderLimits({ listingId, from, canEdit }: { listingId: string; from: "seller" | "admin"; canEdit: boolean }) {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: { id: true, status: true, buyerLimit: true, requiredAttestations: true, seller: { select: { role: true } } },
  });
  if (!listing) return null;
  const desk = from === "admin";
  const regulated = regulatedOnly(listing);
  const chosen = new Set(requiredKinds(listing.requiredAttestations));
  const lines = bidderLimitLines(listing);
  const editable = canEdit && limitsOpen(listing.status);
  const locked = editable && (await bidsIn(listing.id));
  // The switch is for institutional sellers and the desk. One already on can always be turned off.
  const offersSwitch = offersRegulatedSwitch({ role: desk ? "ADMIN" : "SELLER" }, listing.seller) || regulated;
  return (
    <section id="bidder-limits" aria-labelledby="bidder-limits-heading" className={desk ? "mt-6 scroll-mt-6 rounded-xl border border-border p-5" : "mt-5 scroll-mt-6"}>
      <p id="bidder-limits-heading" className={desk ? "eyebrow" : "text-[13px] font-semibold text-foreground"}>Who may bid</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {regulated ? `${REGULATED_ONLY_LINE} The desk checks each one's charter with its regulator before it counts.` : "Any buyer the desk has approved."}
        {lines.needs ? ` ${lines.needs}` : ""}
      </p>
      {editable && (
        <form action={saveBidderLimits} className="mt-3 space-y-3">
          <input type="hidden" name="listingId" value={listing.id} />
          {offersSwitch && (
            <label className="flex min-h-10 items-start gap-3 text-sm text-foreground">
              <input type="checkbox" name="regulated" defaultChecked={regulated} disabled={locked && !regulated} className="mt-1 size-4 shrink-0" />
              <span className="min-w-0">
                {REGULATED_SWITCH}
                <span className="block text-xs text-muted-foreground">Buyers still see the listing on the book, with a line saying who may bid. Alerts and buy-box matches go to banks and credit unions only.</span>
              </span>
            </label>
          )}
          <fieldset className="min-w-0">
            <legend className="text-[13px] text-muted-foreground">Statements each bidder needs on file</legend>
            <div className="mt-2 space-y-2">
              {ATTESTATION_KEYS.map((key) => {
                const kind = kindOf(key);
                const on = chosen.has(key);
                return (
                  <label key={key} className="flex min-h-10 items-start gap-3 text-sm text-foreground">
                    <input type="checkbox" name="kinds" value={key} defaultChecked={on} disabled={locked && !on} className="mt-1 size-4 shrink-0" />
                    <span className="min-w-0">
                      {kind.label}
                      <span className="block text-xs text-muted-foreground">
                        {lastsLine(kind)}
                        {kind.reference ? ` Names a ${kind.reference.label.toLowerCase()}.` : ""}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {locked
              ? "Bids are in, so these can only be loosened now."
              : "A bid, group seat or standing bid is refused for an entity without them, and the buyer is told what is missing. The wording is UPB's draft, which counsel is reviewing."}
          </p>
          <SubmitButton variant="outline" pendingLabel="Saving…" className="h-11 w-full text-[13px] font-medium sm:w-auto">Save who may bid</SubmitButton>
        </form>
      )}
      {desk && !canEdit && <p className="mt-3 text-sm text-muted-foreground">The sales side of the desk changes this.</p>}
    </section>
  );
}

// On the listing page, beside the bid form: who may bid and what each bidder needs. A buyer who can't bid at all reads
// why in the bid panel itself, so the regulated line isn't repeated for them here.
export function BidderLimitNote({ listing, viewerRole, blocked }: { listing: { buyerLimit?: string | null; requiredAttestations?: string[] | null }; viewerRole: string; blocked: boolean }) {
  const lines = bidderLimitLines(listing);
  const regulated = lines.regulated && !blocked;
  if (!regulated && !lines.needs) return null;
  return (
    <p className="rounded-lg border border-link/30 bg-link/5 px-3 py-2 text-sm leading-relaxed text-foreground">
      {regulated ? `${REGULATED_ONLY_LINE}${viewerRole === "BUYER" ? " Bid through the bank or credit union on your file." : ""}` : ""}
      {regulated && lines.needs ? " " : ""}
      {lines.needs}
      {lines.needs && viewerRole === "BUYER" && (
        <>
          {" "}
          <Link href={ATTESTATIONS_HREF} className="font-medium text-link">Give them in your buyer file</Link>.
        </>
      )}
    </p>
  );
}
