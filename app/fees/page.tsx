import type { Metadata } from "next";
import Link from "next/link";
import { PublicPage } from "@/components/public-page";
import { getCurrentUser } from "@/lib/auth";
import { feeFromPool, type FeeTerms as BrokerTerms } from "@/lib/broker-fees";
import { depositCents, depositTerms } from "@/lib/closing-clock";
import { diligenceDays } from "@/lib/closing-service";
import { money } from "@/lib/format";
import { homeFor } from "@/lib/labels";
import { EXAMPLE_PRICES, chargeFees, feeTerms, rateText, tierLabel, type Fees } from "@/lib/fee-schedule";
import { getSettings } from "@/lib/settings";

// Public, so a buyer or seller can read the costs before asking for an account. The desk navigation links here too.
export const metadata: Metadata = {
  title: "Fee schedule",
  description: "What a trade costs on UPB Capital: the buyer premium, the seller commission, deposits, and broker fees.",
};
export const dynamic = "force-dynamic";

// "2.5%", "10%": a rate in basis points as people read it.
function rate(bps: number) {
  return `${Number((bps / 100).toFixed(2))}%`;
}

function share(terms: BrokerTerms) {
  return terms.basis === "FLAT" ? `A flat ${money(terms.cents / 100)} per listing` : `${rate(terms.bps)} of UPB's fees on the trade, the buyer premium plus the seller commission`;
}

// The rate a worked example paid on one side: "2.5%", or "$750 minimum" when the minimum set the fee.
function paid(fees: Fees, side: "premium" | "commission") {
  const floor = side === "premium" ? fees.premiumFloor : fees.commissionFloor;
  const cents = side === "premium" ? fees.premiumCents : fees.commissionCents;
  if (floor) return `${money(cents / 100)} minimum`;
  return rate(side === "premium" ? fees.premiumBps : fees.commissionBps);
}

export default async function FeeSchedulePage() {
  const [settings, user] = await Promise.all([getSettings(), getCurrentUser()]);
  const deposit = depositTerms(settings);
  const diligence = diligenceDays(settings.diligenceDays);
  const broker: BrokerTerms = { basis: settings.brokerFeeBasis, bps: settings.brokerFeeBps, cents: settings.brokerFeeCents };
  const affiliate: BrokerTerms = { basis: settings.affiliateFeeBasis, bps: settings.affiliateFeeBps, cents: settings.affiliateFeeCents };
  // Today's terms: the desk's graded schedule when one is set, else the flat rates.
  const terms = feeTerms(null, settings);
  const graded = terms.schedule;
  // Flat rates read as one tier that covers every price.
  const table = graded ?? { tiers: [{ upTo: null, premiumBps: terms.premiumBps, commissionBps: terms.commissionBps }], minPremiumCents: 0, minCommissionCents: 0 };
  const tierRule = "The tier the price falls in sets the rate on the whole price. It is not worked out band by band.";
  const schedule: [string, string][] = [
    ["Buyer premium", graded
      ? `${rateText(terms, "premium")}, added on top of the accepted price. It is not part of the bid itself. ${tierRule}`
      : `${rate(settings.buyerPremiumBps)} of the accepted price, added on top of the bid. It is not part of the bid itself.`],
    ["Seller commission", graded
      ? `${rateText(terms, "commission")}, taken from the seller's proceeds. Neither fee is ever more than the price.`
      : `${rate(settings.sellerCommissionBps)} of the sale price, taken from the seller's proceeds.`],
    ["Deposit", deposit.bps > 0 ? `${rate(deposit.bps)} of the price, wired within ${deposit.days} day${deposit.days === 1 ? "" : "s"} of the award. It counts toward what the buyer owes at closing.` : "None. The full price is due at closing."],
    ["Diligence window", diligence > 0 ? `${diligence} day${diligence === 1 ? "" : "s"} after an award, in which the buyer may walk away for a finding, with a reason both sides read.` : "None. An accepted bid is a commitment to buy."],
    ["Broker fee", `${share(broker)}. UPB pays it out of its own fees, so it adds nothing to what a buyer or seller pays.`],
    ["Affiliate fee", `${share(affiliate)}. Paid the same way, out of UPB's fees.`],
    ["Pro membership", `${money(settings.proMonthlyPriceCents / 100, 2)} a month, for buyers.`],
    ["Desk purchases", `When UPB's desk buys a note for its own book, there is no buyer premium${settings.chargeDeskFees ? ", and the seller commission applies." : " and no seller commission."}`],
  ];
  const examples = EXAMPLE_PRICES.map((price) => {
    const fees = chargeFees(terms, price);
    const pool = fees.premiumCents + fees.commissionCents;
    // No payee is paid more than UPB's fees on the trade, so the example caps the same way.
    return { price, fees, pool, brokerCut: Math.min(feeFromPool(pool, broker), pool), affiliateCut: Math.min(feeFromPool(pool, affiliate), pool) };
  });
  const rows: [string, (example: (typeof examples)[number]) => string, boolean?][] = [
    ["Price", (example) => money(example.price), true],
    ["Buyer premium rate", (example) => paid(example.fees, "premium")],
    ["Buyer premium", (example) => money(example.fees.premiumCents / 100)],
    ["The buyer pays", (example) => money(example.fees.buyerTotalCents / 100), true],
    [`Deposit at award, ${rate(deposit.bps)}`, (example) => (deposit.bps > 0 ? money(depositCents(example.price, deposit.bps) / 100) : "None")],
    ["Seller commission rate", (example) => paid(example.fees, "commission")],
    ["Seller commission", (example) => money(example.fees.commissionCents / 100)],
    ["The seller nets", (example) => money(example.fees.netToSellerCents / 100), true],
    ["UPB's fees on the trade", (example) => money(example.pool / 100)],
    ["Of that, to a broker who filed the listing", (example) => money(example.brokerCut / 100)],
    ["Of that, to an affiliate who referred the seller", (example) => money(example.affiliateCut / 100)],
  ];
  return (
    <PublicPage
      title="What a trade costs on UPB."
      lede="The rates in force today, as the desk sets them. A listing keeps the rates in force when the desk approved it, and a closing keeps the rates it opened with."
      authed={Boolean(user)}
    >
      {user && (
        <p className="text-sm text-muted-foreground">
          <Link href={homeFor(user.role)} className="text-link">Back to the desk</Link>
        </p>
      )}
      <section className="glass p-5 md:p-6" aria-labelledby="schedule-heading">
        <h2 id="schedule-heading" className="eyebrow">The schedule</h2>
        <dl className="mt-4 divide-y divide-border">
          {schedule.map(([label, text]) => (
            <div key={label} className="grid gap-1 py-3 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4">
              <dt className="text-sm font-medium text-foreground">{label}</dt>
              <dd className="text-sm leading-relaxed text-muted-foreground tabular-nums">{text}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="glass p-5 md:p-6" aria-labelledby="tiers-heading">
        <h2 id="tiers-heading" className="eyebrow">Rates by sale size</h2>
        <p className="mt-2 text-sm text-muted-foreground">{graded ? tierRule : "One rate for every sale, whatever its size, and no minimum."}</p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[20rem] text-sm tabular-nums">
            <thead>
              <tr className="border-b border-border text-left text-[13px] text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-medium">Sale price</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Buyer premium</th>
                <th scope="col" className="py-2 text-right font-medium">Seller commission</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {table.tiers.map((tier, index) => (
                <tr key={index}>
                  <th scope="row" className="py-2 pr-3 text-left font-normal text-foreground">{tierLabel(table, index)}</th>
                  <td className="py-2 pr-3 text-right text-foreground">{rate(tier.premiumBps)}</td>
                  <td className="py-2 text-right text-foreground">{rate(tier.commissionBps)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {graded && (
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            Minimum buyer premium {graded.minPremiumCents > 0 ? money(graded.minPremiumCents / 100) : "none"}. Minimum seller commission {graded.minCommissionCents > 0 ? money(graded.minCommissionCents / 100) : "none"}. A fee is never more than the price.
          </p>
        )}
        </section>
      <section className="glass p-5 md:p-6" aria-labelledby="example-heading">
        <h2 id="example-heading" className="eyebrow">Worked examples</h2>
        <p className="mt-2 text-sm text-muted-foreground">Notes that trade at {EXAMPLE_PRICES.map((price) => money(price)).join(", ").replace(/, ([^,]*)$/, " and $1")}, under today&apos;s schedule.</p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[22rem] text-sm tabular-nums">
            <thead>
              <tr className="text-left text-[13px] text-muted-foreground">
                <th scope="col" className="sr-only">Line</th>
                {examples.map((example) => (
                  <th key={example.price} scope="col" className="py-1 pl-3 text-right font-medium">{money(example.price)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, value, total]) => (
                <tr key={label} className={total ? "border-t border-border font-medium text-foreground" : "text-muted-foreground"}>
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal">{label}</th>
                  {examples.map((example) => (
                    <td key={example.price} className="py-1.5 pl-3 text-right text-foreground">{value(example)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          A broker or affiliate fee comes out of UPB&apos;s fees and only applies when one brought the deal. Third-party costs, such as recording or a servicer&apos;s boarding fee, are not UPB fees and are not shown.
        </p>
      </section>
      <p className="text-sm text-muted-foreground">
        Fees are charged under the <Link href="/terms" className="text-link">terms of use</Link>. Questions about a particular trade go to the desk.
      </p>
    </PublicPage>
  );
}
