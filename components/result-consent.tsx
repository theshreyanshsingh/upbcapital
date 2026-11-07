import Link from "next/link";
import { savePublishResult } from "@/actions/results";
import { SubmitButton } from "@/components/submit-button";

// Whether this sale's anonymised result goes on the public results page. Off unless the seller says yes.
// readOnly is for a desk role outside sales: it reads the setting, and the action refuses it the change.
export function ResultConsent({ listing, desk = false, client, readOnly = false }: { listing: { id: string; publishResult: boolean | null }; desk?: boolean; client?: string; readOnly?: boolean }) {
  const on = listing.publishResult === true;
  const whose = desk ? "the seller's" : client ? `${client}'s` : "your";
  return (
    <section id="public-result" aria-labelledby="public-result-heading" className="mt-6 scroll-mt-6 border border-border p-4 rounded-xl">
      <p id="public-result-heading" className="eyebrow">Public results</p>
      <p className="mt-2 text-sm leading-relaxed text-foreground">
        {on ? `This sale will show on the public results page once it closes.` : `This sale won't show on the public results page.`}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        It shows only the state, the lien, whether it was performing, a UPB band, the price as a percent of UPB and the month it closed. Never the address, the borrower, the parties or the exact balance.{" "}
        <Link href="/results" className="text-link">See the page</Link>
      </p>
      {(desk || client) && !on && !readOnly && <p className="mt-1 text-xs text-muted-foreground">Turn this on only with {whose} agreement.</p>}
      {readOnly && <p className="mt-3 text-sm text-muted-foreground">The sales side of the desk changes this.</p>}
      {!readOnly && <form action={savePublishResult} className="mt-3">
        <input type="hidden" name="listingId" value={listing.id} />
        <input type="hidden" name="publish" value={on ? "no" : "yes"} />
        <SubmitButton variant="outline" pendingLabel="Saving…" className="h-9 px-3 text-[13px] font-medium">
          {on ? "Stop showing it" : desk ? "Show it, with the seller's agreement" : "Show it once it closes"}
        </SubmitButton>
      </form>}
    </section>
  );
}
