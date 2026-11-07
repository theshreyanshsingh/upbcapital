import Link from "next/link";
import { retireBuyBox, saveBuyBox, saveStandingRule } from "@/actions/buy-box";
import { RateNote } from "@/components/indicative-price";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { StandingBidInvite } from "@/components/standing-bid-invite";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { depositTerms } from "@/lib/closing-clock";
import { diligenceDays } from "@/lib/closing-service";
import { effectiveBps, feesFor } from "@/lib/fee-schedule";
import { money, prettyDate, q } from "@/lib/format";
import { marketRate, rateStamp, type MarketRate } from "@/lib/indicative";
import { LIEN_POSITIONS, PAYMENT_STATUSES } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { getSettings, isPro } from "@/lib/settings";
import { openInvitations, ruleLabel, ruleOf, type StandingBox } from "@/lib/standing-bids";
import { bidEntities } from "@/lib/buyer-entities";

export const metadata = { title: "Buy box" };

export default async function BuyBoxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["BUYER"]);
  const params = await searchParams;
  const boxes = await prisma.buyBox.findMany({
    where: { userId: user.id, active: true },
    // Boxes score listings still in review too, so the live filter runs before the top five are taken.
    include: { matches: { where: { listing: { status: { in: ["APPROVED", "PENDING"] } } }, include: { listing: true }, orderBy: { score: "desc" }, take: 5 } },
    orderBy: { createdAt: "desc" },
  });
  const [invitations, settings, entities] = await Promise.all([openInvitations(user.id), getSettings(), bidEntities(user.id)]);
  const pro = isPro(user);
  const rate = marketRate(settings);
  // Spread-priced invitations whose rate is over a week old, so the buyer knows before confirming.
  const staleInvites = invitations.filter((invite) => invite.rateAsOf && rateStamp(invite.rateAsOf)?.stale);
  // What a winning bidder owes, for the confirmation. A 0% deposit says nothing.
  const terms = depositTerms(settings);
  const deposit: [number, number] | undefined = terms.bps > 0 ? [terms.bps / 100, terms.days] : undefined;
  const diligence = diligenceDays(settings.diligenceDays) || undefined;
  return (
    <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div>
        <PageIntro eyebrow="Buy box" title="Paper that fits." lede="States, lien, performance, balance, price, a ceiling as a percent of UPB, a target IRR from the deal analyzer, the highest LTV and the fewest months of seasoning. New listings are scored against every active box. A match on the live book sends a notice. On Pro, a box can carry a standing price too, an indicative figure for every new tape that fits." />
        <Notice notice={q(params, "notice")} error={q(params, "error")} />
        {invitations.length > 0 && (
          <section id="invitations" className="mt-8 scroll-mt-6" aria-labelledby="invitations-heading">
            <p id="invitations-heading" className="eyebrow">Invitations to confirm</p>
            <p className="mt-1 text-sm text-muted-foreground">The desk sent you these standing prices. Each is indicative until you bid it, and a bid made here is a real offer.</p>
            {staleInvites.length > 0 && (
              <p className="mt-2 text-sm text-warn tabular-nums">
                {staleInvites.length === 1 ? "One spread-priced invitation uses" : `${staleInvites.length} spread-priced invitations use`} a 10-year {rateStamp(staleInvites[0].rateAsOf)?.text}, over a week old. Check the figure before you confirm.
              </p>
            )}
            <ul className="mt-4 space-y-4">
              {invitations.map((invite) => {
                const upb = invite.listing.notes.reduce((sum, note) => sum + note.upb, 0);
                const price = invite.indicativePrice ?? 0;
                return (
                  <StandingBidInvite
                    key={invite.id}
                    matchId={invite.id}
                    listingId={invite.listingId}
                    title={invite.listing.title}
                    boxName={invite.buyBox.name}
                    rule={ruleLabel(ruleOf(invite.buyBox), rate)}
                    price={price}
                    ofUpb={upb > 0 ? (price / upb) * 100 : null}
                    invitedAt={prettyDate(invite.invitedAt)}
                    // The listing's own premium on this price, graded when it went live with a schedule.
                    premiumBps={effectiveBps(feesFor(invite.listing, settings, price))}
                    deposit={deposit}
                    diligenceDays={diligence}
                    entities={entities}
                  />
                );
              })}
            </ul>
          </section>
        )}
        <ul className="mt-8 space-y-4">
          {boxes.length === 0 && <li className="border border-dashed border-link/30 px-5 py-8 text-sm text-muted-foreground rounded-xl">No box yet. The form on the right starts one.</li>}
          {boxes.map((box) => (
            <li key={box.id} className="glass p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold tracking-tight text-3xl text-foreground">{box.name}</p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {[box.states || "Any state", box.liens || "Any lien", box.statuses || "Any status"].join(" · ")}
                    {box.maxPriceToUpb != null ? ` · max ${Number(box.maxPriceToUpb)}% of UPB` : ""}
                    {box.targetYield != null ? ` · IRR ${Number(box.targetYield)}%` : ""}
                    {box.maxLtv != null ? ` · LTV up to ${Number(box.maxLtv)}%` : ""}
                    {box.minSeasoningMonths != null ? ` · seasoned ${box.minSeasoningMonths}+ months` : ""}
                  </p>
                </div>
                <form action={retireBuyBox}>
                  <input type="hidden" name="id" value={box.id} />
                  <SubmitButton variant="ghost" className="h-9 text-[13px] font-medium">Retire</SubmitButton>
                </form>
              </div>
              <ul className="mt-4 space-y-2 text-sm">
                {box.matches.length === 0 && <li className="text-muted-foreground">Nothing on the current book fits.</li>}
                {box.matches.map((match) => (
                  <li key={match.id} className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="min-w-0">
                      <Link href={`/marketplace/${match.listingId}`} className="text-foreground hover:text-link">{match.listing.title}</Link>
                      {match.reasons && <span className="block text-xs text-muted-foreground">{match.reasons}</span>}
                    </span>
                    <span className="tabular-nums">
                      {match.indicativePrice != null && <span className="text-muted-foreground">indicative {money(match.indicativePrice)} · </span>}
                      <span className="text-link">{match.score}</span>
                      {match.indicativePrice != null && match.rateAsOf && <RateNote rate={rateStamp(match.rateAsOf)} className="block text-right text-xs" />}
                    </span>
                  </li>
                ))}
              </ul>
              <StandingRuleForm box={box} pro={pro} rate={rate} />
            </li>
          ))}
        </ul>
      </div>
      <form action={saveBuyBox} className="glass h-fit space-y-4 p-5">
        <p className="eyebrow">New box</p>
        <label className="block"><span className="text-[13px] text-muted-foreground">Name</span><input name="name" required className="desk-input mt-2" aria-label="Box name" /></label>
        <label className="block"><span className="text-[13px] text-muted-foreground">States</span><input name="states" placeholder="FL, GA" className="desk-input mt-2" aria-label="States" /></label>
        <fieldset>
          <legend className="text-[13px] text-muted-foreground">Lien</legend>
          <div className="mt-2 flex flex-wrap gap-3 text-sm text-foreground">
            {LIEN_POSITIONS.map((item) => (
              <label key={item.value} className="inline-flex items-center gap-2"><input type="checkbox" name={`lien_${item.value}`} />{item.label}</label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-[13px] text-muted-foreground">Performance</legend>
          <div className="mt-2 flex flex-wrap gap-3 text-sm text-foreground">
            {PAYMENT_STATUSES.map((item) => (
              <label key={item.value} className="inline-flex items-center gap-2"><input type="checkbox" name={`status_${item.value}`} />{item.label}</label>
            ))}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="text-[13px] text-muted-foreground">UPB min</span><input name="upbMin" className="desk-input mt-2" aria-label="UPB minimum" /></label>
          <label className="block"><span className="text-[13px] text-muted-foreground">UPB max</span><input name="upbMax" className="desk-input mt-2" aria-label="UPB maximum" /></label>
          <label className="block"><span className="text-[13px] text-muted-foreground">Price min</span><input name="priceMin" className="desk-input mt-2" aria-label="Price minimum" /></label>
          <label className="block"><span className="text-[13px] text-muted-foreground">Price max</span><input name="priceMax" className="desk-input mt-2" aria-label="Price maximum" /></label>
        </div>
        <label className="block"><span className="text-[13px] text-muted-foreground">Max % of UPB</span><input name="maxPriceToUpb" className="desk-input mt-2" aria-label="Maximum percent of UPB" /></label>
        <label className="block"><span className="text-[13px] text-muted-foreground">Target IRR %</span><input name="targetYield" className="desk-input mt-2" aria-label="Target IRR" /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="text-[13px] text-muted-foreground">Highest LTV %</span><input name="maxLtv" inputMode="decimal" className="desk-input mt-2" aria-label="Highest loan to value, percent" /></label>
          <label className="block"><span className="text-[13px] text-muted-foreground">Seasoned at least, months</span><input name="minSeasoningMonths" inputMode="numeric" className="desk-input mt-2" aria-label="Fewest months since origination" /></label>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">LTV is UPB over the seller&apos;s estimated value. Seasoning counts months since the origination date, so a loan with no date on its tape doesn&apos;t fit a seasoning limit.</p>
        <SubmitButton className="h-11 text-[13px] font-medium">Score the book</SubmitButton>
      </form>
    </div>
  );
}

const BASES = [
  ["OFF", "Off"],
  ["UPB", "% of UPB"],
  ["YIELD", "Price for my target yield"],
  ["SPREAD", "Spread over the 10-year Treasury"],
] as const;

// A box's standing price rule. It prices every new tape that fits, as an indicative figure the desk can send back to
// the buyer to confirm. A spread rule's target moves with the desk's 10-year rate, so the rule holds through a hike.
function StandingRuleForm({ box, pro, rate }: { box: StandingBox & { id: string }; pro: boolean; rate: MarketRate | null }) {
  const rule = ruleOf(box);
  const basis = box.standingBids ? (box.bidBasis ?? "OFF") : "OFF";
  const stamp = rate ? rateStamp(rate.asOf) : null;
  const spreadTarget = rate && box.bidSpread != null ? Math.round((rate.rate + box.bidSpread) * 100) / 100 : null;
  return (
    <details className="mt-4 border-t border-border pt-4">
      <summary className="cursor-pointer text-[13px] font-medium text-foreground">
        Standing price · {ruleLabel(rule, rate)}
        {rule?.basis === "SPREAD" && stamp?.stale && <span className="ml-1 text-warn">· over a week old</span>}
      </summary>
      {pro ? (
        <form action={saveStandingRule} className="mt-3 space-y-4">
          <input type="hidden" name="id" value={box.id} />
          <p className="text-sm leading-relaxed text-muted-foreground">
            Indicative only. Each new tape that fits this box is priced by the rule as it arrives, and the desk may send you the figure to confirm. Nothing binds until you confirm it as a bid.
          </p>
          <fieldset>
            <legend className="text-[13px] text-muted-foreground">Price rule</legend>
            <div className="mt-2 flex flex-wrap gap-4 text-sm text-foreground">
              {BASES.map(([value, label]) => (
                <label key={value} className="inline-flex items-center gap-2">
                  <input type="radio" name="bidBasis" value={value} defaultChecked={basis === value} />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Bid, % of UPB</span>
              <input name="bidPercent" inputMode="decimal" defaultValue={box.bidPercent ?? ""} className="desk-input mt-2 tabular-nums" />
            </label>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Target IRR %</span>
              <input name="targetYield" inputMode="decimal" defaultValue={box.targetYield ?? ""} className="desk-input mt-2 tabular-nums" />
            </label>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Spread over the 10-year, percentage points</span>
              <input name="bidSpread" inputMode="decimal" defaultValue={box.bidSpread ?? ""} placeholder="Such as 7" className="desk-input mt-2 tabular-nums" />
            </label>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Most for one loan</span>
              <input name="bidCap" inputMode="decimal" defaultValue={box.bidCap ?? ""} placeholder="No cap" className="desk-input mt-2 tabular-nums" />
            </label>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground tabular-nums">
            A spread rule prices for the 10-year Treasury yield plus your spread, so a rate move reprices your open matches without a new rule.{" "}
            {rate && stamp ? (
              <>
                The desk&apos;s rate is {rate.rate}%, <span className={stamp.stale ? "text-warn" : ""}>{stamp.text}{stamp.stale ? ", over a week old" : ""}</span>
                {spreadTarget != null ? `, so this box's spread prices for a ${spreadTarget}% IRR today.` : "."}
              </>
            ) : (
              "The desk hasn't entered a 10-year rate yet, so a spread rule prices nothing until it does."
            )}
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            With a rule on, the box&apos;s price limits apply to its own price, so a tape asking more still gets your figure. No loan is priced above its ask or your cap. A yield or spread rule prices performing loans only, so a pool with a sub- or non-performing loan gets no yield price.
          </p>
          <SubmitButton variant="outline" pendingLabel="Repricing…" className="h-9 text-[13px] font-medium">Save the rule</SubmitButton>
        </form>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          Standing bids are a Pro privilege. <Link href="/buyer/subscription" className="text-link">See membership</Link>
        </p>
      )}
    </details>
  );
}
