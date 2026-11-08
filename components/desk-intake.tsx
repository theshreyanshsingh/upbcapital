import { askDeskTapeChanges, confirmDeskFiledTape } from "@/actions/desk-intake";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/submit-button";
import { prettyDate } from "@/lib/format";

type IntakeListing = { id: string; sellerId: string; status: string; filedByDeskId?: string | null; sellerConfirmedAt?: Date | null };

// On the seller's listing page: a tape the desk filed for them, to confirm or send back. Nothing shows for a
// listing the seller filed themselves.
export function IntakeConfirm({ listing, viewerId }: { listing: IntakeListing; viewerId: string }) {
  if (!listing.filedByDeskId) return null;
  if (listing.sellerConfirmedAt) {
    return <p id="desk-intake" className="mt-4 scroll-mt-6 text-sm text-muted-foreground">The desk filed this tape for you. You confirmed it on {prettyDate(listing.sellerConfirmedAt)}.</p>;
  }
  const open = ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED"].includes(listing.status);
  const seller = listing.sellerId === viewerId;
  return (
    <section id="desk-intake" aria-labelledby="desk-intake-heading" className="mt-6 scroll-mt-6 border border-link/30 bg-link/5 p-5 rounded-xl">
      <h2 id="desk-intake-heading" className="eyebrow">The desk filed this tape for you</h2>
      <p className="mt-2 max-w-2xl text-sm text-foreground">
        Check the loans and the tape in your files below. Confirm that the tape is yours and correct, or tell the desk what should change. The desk can&apos;t approve the listing until you confirm, and buyers see nothing before then.
      </p>
      {!seller ? (
        <p className="mt-3 text-sm text-muted-foreground">Waiting for the seller to confirm.</p>
      ) : !open ? (
        <p className="mt-3 text-sm text-muted-foreground">This listing is no longer in review.</p>
      ) : (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <form action={confirmDeskFiledTape}>
            <input type="hidden" name="listingId" value={listing.id} />
            <ConfirmSubmit
              title="Confirm this tape?"
              consequence="You confirm that these loans are yours to sell and that the tape is correct. The desk then finishes its review and can approve the listing."
              confirmLabel="Confirm the tape"
              pendingLabel="Confirming…"
              className="h-10 text-[13px] font-medium"
            >
              Confirm the tape
            </ConfirmSubmit>
          </form>
          <form action={askDeskTapeChanges} className="space-y-2">
            <input type="hidden" name="listingId" value={listing.id} />
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Or ask for changes</span>
              <textarea name="message" required minLength={3} maxLength={1000} className="desk-input mt-2 min-h-20" placeholder="Which loans or fields are wrong, and what they should say" />
            </label>
            <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Sending…">Send to the desk</SubmitButton>
          </form>
        </div>
      )}
    </section>
  );
}
