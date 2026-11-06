import Link from "next/link";
import { Countdown } from "@/components/countdown";
import { money, pct, prettyDate } from "@/lib/format";
import { bpsToPercent } from "@/lib/money";

export type Economics = {
  asking: number;
  premium: number;
  premiumBps: number;
  upb: number;
  priceToUpb: number | null;
  priceToValue: number | null;
  ltv: number | null;
  currentYield: number | null;
  allInYield: number | null;
  loansPriced: number;
  performing: number;
  salePrice: number | null;
};

// The figures a bid turns on, each with its basis: what it is, gross or net, and as of when. Free members see
// the same tiles veiled, so they know what Pro opens without seeing the numbers.
export function ListingEconomics({
  economics,
  pool,
  listedAt,
  deadline,
}: {
  // Null when this viewer sees figures veiled.
  economics: Economics | null;
  pool: boolean;
  listedAt: Date | null;
  deadline: { at: string; mode: string } | null;
}) {
  const scope = pool && economics ? `${economics.loansPriced} loan${economics.loansPriced === 1 ? "" : "s"} still for sale` : "the note";
  return (
    // A container, so the figures go four across only when this box has room, not when the window does: beside
    // the bid panel the column is narrow on a wide screen.
    <section aria-labelledby="economics-heading" className="@container mt-6 glass p-5 md:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="economics-heading" className="eyebrow">Buyer economics</h2>
        {economics && <p className="text-xs text-muted-foreground">For {scope}</p>}
      </div>
      {economics ? (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5 @2xl:grid-cols-4">
            <Figure term="Ask" value={money(economics.asking)} basis="The seller's asking price" />
            <Figure term="Price / UPB" value={pct(economics.priceToUpb)} basis={`Of ${money(economics.upb)} unpaid principal`} />
            <Figure term="All-in if accepted" value={money(economics.asking + economics.premium)} basis={`With the ${bpsToPercent(economics.premiumBps).toFixed(2)}% buyer premium of ${money(economics.premium)}`} />
            <Figure
              term="Current yield"
              value={economics.currentYield == null ? "None" : `${pct(economics.allInYield)} to ${pct(economics.currentYield)}`}
              basis={economics.currentYield == null
                ? "Nothing is paying now. Resolution cases are under Analysis."
                : `On the all-in price, then on the ask${economics.performing < economics.loansPriced ? `, from the ${economics.performing} performing of ${economics.loansPriced} loans` : ""}`}
            />
          </dl>
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            Current yield is the tape&apos;s annual principal and interest over the price, gross before servicing and closing costs.
            Price to value {pct(economics.priceToValue, 0)} and LTV {pct(economics.ltv, 0)} use the seller&apos;s value.
            {" "}Figures come from the seller&apos;s tape{listedAt ? `, listed ${prettyDate(listedAt)}` : ""}. The ask is current as of {prettyDate(new Date())}.
          </p>
          {economics.salePrice != null && (
            <p className="mt-3 text-sm text-foreground tabular-nums">Settled at {money(economics.salePrice)}.</p>
          )}
        </>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5 @2xl:grid-cols-4">
            {["Ask", "Price / UPB", "All-in if accepted", "Current yield"].map((term) => (
              <div key={term}>
                <dt className="text-xs font-medium text-muted-foreground">{term}</dt>
                <dd className="mt-1 h-8 w-28 rounded-md bg-gradient-to-r from-link/10 via-link/30 to-link/10 blur-[2px]" aria-hidden="true" />
                <dd className="mt-1 text-xs font-medium text-link">Pro</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-sm text-muted-foreground">
            The ask, the premium, the all-in price and the yields open with Pro. <Link href="/buyer/subscription?reason=access" className="text-link">See Pro</Link>
          </p>
        </>
      )}
      {deadline && (
        <div className="mt-5 border-t border-border pt-4">
          <Countdown deadline={deadline.at} mode={deadline.mode} />
          <p className="mt-1 text-xs text-muted-foreground tabular-nums">Closes {prettyDate(deadline.at)}, {new Date(deadline.at).toISOString().slice(11, 16)} UTC.</p>
        </div>
      )}
    </section>
  );
}

function Figure({ term, value, basis }: { term: string; value: string; basis: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{term}</dt>
      <dd className="mt-1 font-semibold tracking-tight text-xl text-foreground tabular-nums @md:text-2xl">{value}</dd>
      <dd className="mt-1 text-xs leading-relaxed text-muted-foreground">{basis}</dd>
    </div>
  );
}
