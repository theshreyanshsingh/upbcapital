import { awardPoolPlan } from "@/actions/pool-sale";
import { ConfirmRows, ConfirmSubmit } from "@/components/confirm-submit";
import { money } from "@/lib/format";
import { EXACT_LIMIT, planKey, type PlanPick, type PoolPlan } from "@/lib/pool-optimizer";

const TAKES: Record<PlanPick["kind"], string> = {
  whole: "The whole pool",
  part: "Part of the pool, at the buyer's loan prices",
  loan: "One loan",
};

// The optimiser's recommendation beside the bid sheet: the combination of live bids with the most proceeds, against
// the best single whole-pool bid. It shows sealed amounts, so the page renders it only where it shows the sheet.
export function PoolPlanPanel({
  listingId,
  plan,
  loans,
  canAward,
  waiting,
}: {
  listingId: string;
  plan: PoolPlan;
  loans: { id: string; label: string }[];
  // The desk member can award, and the listing is past any bid deadline.
  canAward: boolean;
  // Why the combination can't be awarded yet, when it can't.
  waiting: string | null;
}) {
  const name = new Map(loans.map((loan) => [loan.id, loan.label]));
  const names = (ids: string[]) => ids.map((id) => name.get(id) ?? "A loan");
  const awards = plan.picks.length;
  const summary = !awards
    ? "No live bid can be taken right now."
    : plan.bestWhole && plan.gain != null
      ? plan.gain > 0.005
        ? `${money(plan.proceeds)} across ${awards} award${awards === 1 ? "" : "s"}, ${money(plan.gain)} more than the best whole-pool bid of ${money(plan.bestWhole.price)} from ${plan.bestWhole.bidder}.`
        : `The best whole-pool bid, ${money(plan.bestWhole.price)} from ${plan.bestWhole.bidder}, is the best outcome.`
      : `${money(plan.proceeds)} across ${awards} award${awards === 1 ? "" : "s"}. No whole-pool bid can be taken.`;
  const flagged = plan.picks.filter((pick) => pick.overFunds).length;
  return (
    <section id="pool-plan" aria-labelledby="pool-plan-heading" className="mt-6 scroll-mt-6 border border-border p-5 rounded-xl">
      <p id="pool-plan-heading" className="eyebrow">Best combination</p>
      <p className="mt-1 text-sm text-muted-foreground">
        The mix of live bids that brings the seller the most, with each loan sold once. A bid priced loan by loan that allows part of the pool competes loan by loan with one-loan bids.
      </p>
      <p className="mt-3 text-sm font-medium text-foreground tabular-nums">{summary}</p>
      {awards > 0 && (
        <div className="mt-3 relative overflow-x-auto border border-border rounded-xl">
          <table className="min-w-full text-left text-sm">
            <thead className="text-xs font-medium text-muted-foreground">
              <tr>{["Bidder", "Takes", "Loans", "Price", "Funds"].map((heading) => <th key={heading} className="px-3 py-2 font-normal">{heading}</th>)}</tr>
            </thead>
            <tbody>
              {plan.picks.map((pick) => (
                <tr key={pick.bidId} className="border-t border-border align-top">
                  <td className="px-3 py-2 text-foreground">{pick.bidder}</td>
                  <td className="px-3 py-2 text-muted-foreground">{TAKES[pick.kind]}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {pick.kind === "whole" ? `All ${pick.noteIds.length}` : (
                      <ul className="space-y-0.5">{names(pick.noteIds).map((label) => <li key={label}>{label}</li>)}</ul>
                    )}
                  </td>
                  <td className="px-3 py-2 font-medium text-foreground tabular-nums">{money(pick.price, 2)}</td>
                  <td className={`px-3 py-2 ${pick.overFunds ? "text-bad" : "text-muted-foreground"}`}>{pick.overFunds ? "Over verified funds" : "Within funds or none stated"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {awards > 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          {plan.unsold.length ? `Left unsold: ${names(plan.unsold).join("; ")}.` : "Every loan still for sale has a buyer."}
        </p>
      )}
      {plan.excluded.length > 0 && (
        <details className="mt-3 text-sm text-muted-foreground">
          <summary className="cursor-pointer">{plan.excluded.length} bid{plan.excluded.length === 1 ? "" : "s"} left out</summary>
          <ul className="mt-2 space-y-1">
            {plan.excluded.map((row) => <li key={row.bidId}>{row.bidder}: {row.reason}</li>)}
          </ul>
        </details>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        {plan.method === "exact"
          ? "Every combination of the whole-pool bids was tried."
          : `More than ${EXACT_LIMIT} whole-pool bids, so this is a quick pass rather than every combination. With bids on the whole pool it finds the same answer.`}
      </p>
      {awards > 0 && canAward && (
        <form action={awardPoolPlan} className="mt-4">
          <input type="hidden" name="listingId" value={listingId} />
          <input type="hidden" name="plan" value={planKey(plan)} />
          <ConfirmSubmit
            title={`Award this combination for ${money(plan.proceeds)}?`}
            consequence={`Each award runs every check a single award does, in order. Any the seller hasn't agreed to goes to the seller to approve first. Bids that can't win a loan are declined, and the listing stays live for any loan left unsold.${flagged ? ` ${flagged} of these bids ${flagged === 1 ? "is" : "are"} over the buyer's verified funds.` : ""}`}
            details={<ConfirmRows rows={plan.picks.map((pick) => [pick.bidder, `${pick.kind === "whole" ? "Whole pool" : `${pick.noteIds.length} loan${pick.noteIds.length === 1 ? "" : "s"}`} · ${money(pick.price, 2)}`] as [string, string])} />}
            confirmLabel="Award the combination"
            pendingLabel="Awarding…"
            className="h-10 text-[13px] font-medium"
          >
            Award this combination
          </ConfirmSubmit>
        </form>
      )}
      {awards > 0 && !canAward && waiting && <p className="mt-4 text-sm text-muted-foreground">{waiting}</p>}
    </section>
  );
}
