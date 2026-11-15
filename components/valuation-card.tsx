import Link from "next/link";
import { askDeskToFileValuation } from "@/actions/valuations";
import { SubmitButton } from "@/components/submit-button";
import { money } from "@/lib/format";
import { sellerValuations } from "@/lib/valuations";

// The seller's open valuation requests, on their desk. "List these loans" opens the listing form for the seller's
// account; the form doesn't read a valuation yet, so it starts blank. A request sent with a tape can go to the desk
// instead, which files it in desk intake. A listing filed from either way marks the request listed (lib/valuations.ts).
export async function YourValuations({ user }: { user: { id: string; role: string; accountStatus: string } }) {
  const requests = await sellerValuations(user.id);
  if (!requests.length) return null;
  const tapes = user.role === "INSTITUTIONAL_SELLER" && user.accountStatus === "APPROVED";
  return (
    <section id="valuation" aria-labelledby="valuation-heading" className="mt-8 scroll-mt-6 space-y-3">
      <h2 id="valuation-heading" className="eyebrow">Your valuation</h2>
      {requests.map((request) => (
        <div key={request.id} className="glass flex flex-wrap items-center justify-between gap-4 p-5">
          <div className="min-w-0">
            <p className="text-[15px] font-medium text-foreground tabular-nums">
              {request.loans === 1 ? "1 loan" : `${request.loans} loans`}, {money(request.upb)} UPB
              {request.lowPrice != null && request.highPrice != null ? `, indicative ${money(request.lowPrice)}–${money(request.highPrice)}` : ""}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {request.quoted ? "The desk's range. " : "The instant range. "}
              {request.askedDesk ? "The desk has the tape and is filing it for you." : "An estimate, not an offer. Buyers set the price when they bid."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link href={tapes ? "/seller/pools/new" : "/seller/notes/new"} className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-[13px] font-medium text-primary-foreground">
              List these loans
            </Link>
            {request.tape && !request.askedDesk && (
              <form action={askDeskToFileValuation}>
                <input type="hidden" name="id" value={request.id} />
                <SubmitButton variant="outline" className="h-10 px-4 text-[13px] font-medium" pendingLabel="Sending…">Ask the desk to file it</SubmitButton>
              </form>
            )}
          </div>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">The listing form starts blank. Enter the loans with the balances you sent, and the listing is tied to this valuation.</p>
    </section>
  );
}
