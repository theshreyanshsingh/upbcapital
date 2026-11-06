import { PageIntro } from "@/components/page-intro";
import { requireUser } from "@/lib/auth";
import { feeFromPool, type FeeTerms } from "@/lib/broker-fees";
import { depositCents, depositTerms } from "@/lib/closing-clock";
import { diligenceDays } from "@/lib/closing-service";
import { money } from "@/lib/format";
import { feeBreakdown } from "@/lib/money";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "Fee schedule" };

const EXAMPLE_PRICE = 100_000;

// "2.5%", "10%": a rate in basis points as people read it.
function rate(bps: number) {
  return `${Number((bps / 100).toFixed(2))}%`;
}

function share(terms: FeeTerms) {
  return terms.basis === "FLAT" ? `A flat ${money(terms.cents / 100)} per listing` : `${rate(terms.bps)} of UPB's fees on the trade, the buyer premium plus the seller commission`;
}

export default async function FeeSchedulePage() {
  await requireUser();
  const settings = await getSettings();
  const deposit = depositTerms(settings);
  const diligence = diligenceDays(settings.diligenceDays);
  const broker: FeeTerms = { basis: settings.brokerFeeBasis, bps: settings.brokerFeeBps, cents: settings.brokerFeeCents };
  const affiliate: FeeTerms = { basis: settings.affiliateFeeBasis, bps: settings.affiliateFeeBps, cents: settings.affiliateFeeCents };
  const example = feeBreakdown(EXAMPLE_PRICE, settings.buyerPremiumBps, settings.sellerCommissionBps);
  const pool = example.premiumCents + example.commissionCents;
  // No payee is paid more than UPB's fees on the trade, so the example caps the same way.
  const brokerCut = Math.min(feeFromPool(pool, broker), pool);
  const affiliateCut = Math.min(feeFromPool(pool, affiliate), pool);
  const schedule: [string, string][] = [
    ["Buyer premium", `${rate(settings.buyerPremiumBps)} of the accepted price, added on top of the bid. It is not part of the bid itself.`],
    ["Seller commission", `${rate(settings.sellerCommissionBps)} of the sale price, taken from the seller's proceeds.`],
    ["Deposit", deposit.bps > 0 ? `${rate(deposit.bps)} of the price, wired within ${deposit.days} day${deposit.days === 1 ? "" : "s"} of the award. It counts toward what the buyer owes at closing.` : "None. The full price is due at closing."],
    ["Diligence window", diligence > 0 ? `${diligence} day${diligence === 1 ? "" : "s"} after an award, in which the buyer may walk away for a finding, with a reason both sides read.` : "None. An accepted bid is a commitment to buy."],
    ["Broker fee", `${share(broker)}. UPB pays it out of its own fees, so it adds nothing to what a buyer or seller pays.`],
    ["Affiliate fee", `${share(affiliate)}. Paid the same way, out of UPB's fees.`],
    ["Pro membership", `${money(settings.proMonthlyPriceCents / 100, 2)} a month, for buyers.`],
    ["Desk purchases", `When UPB's desk buys a note for its own book, there is no buyer premium${settings.chargeDeskFees ? ", and the seller commission applies." : " and no seller commission."}`],
  ];
  const rows: [string, string, boolean?][] = [
    ["Price", money(EXAMPLE_PRICE), true],
    [`Buyer premium, ${rate(settings.buyerPremiumBps)}`, money(example.premiumCents / 100)],
    ["The buyer pays", money(example.buyerTotalCents / 100), true],
    [`Deposit at award, ${rate(deposit.bps)}`, deposit.bps > 0 ? `${money(depositCents(EXAMPLE_PRICE, deposit.bps) / 100)} within ${deposit.days} day${deposit.days === 1 ? "" : "s"}` : "None"],
    [`Seller commission, ${rate(settings.sellerCommissionBps)}`, money(example.commissionCents / 100)],
    ["The seller nets", money(example.netToSellerCents / 100), true],
    ["UPB's fees on the trade", money(pool / 100)],
    ["Of that, to a broker who filed the listing", money(brokerCut / 100)],
    ["Of that, to an affiliate who referred the seller", money(affiliateCut / 100)],
  ];
  return (
    <div className="max-w-3xl">
      <PageIntro
        eyebrow="Fees"
        title="What a trade costs on UPB."
        lede="The rates in force today, as the desk sets them. Every bid is placed against this schedule, and a closing keeps the rates it opened with."
      />
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
      <section className="glass mt-8 p-5 md:p-6" aria-labelledby="example-heading">
        <h2 id="example-heading" className="eyebrow">On a {money(EXAMPLE_PRICE)} note</h2>
        <p className="mt-2 text-sm text-muted-foreground">A note that trades at {money(EXAMPLE_PRICE)}, under today&apos;s schedule.</p>
        <dl className="mt-4 space-y-2 text-sm">
          {rows.map(([label, value, total]) => (
            <div key={label} className={`flex flex-wrap justify-between gap-3 ${total ? "border-t border-border pt-2 font-medium text-foreground" : "text-muted-foreground"}`}>
              <dt>{label}</dt>
              <dd className="tabular-nums text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          A broker or affiliate fee comes out of UPB&apos;s fees and only applies when one brought the deal. Third-party costs, such as recording or a servicer&apos;s boarding fee, are not UPB fees and are not shown.
        </p>
      </section>
    </div>
  );
}
