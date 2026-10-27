import { addContractorBid, addDraw, addRehabLine, fundDraw, openEstimate, saveEstimate, selectContractor } from "@/actions/rehab";
import { SubmitButton } from "@/components/submit-button";
import { money } from "@/lib/format";
import { drawDollars, rehabPicture } from "@/lib/rehab";

type Cost = { trade: string; unit: string; costCents: number };
type Line = { id: string; room: string; trade: string; quantity: unknown; unitCostCents: number };
type Bid = { id: string; contractor: string; amount: unknown; days: number; selected: boolean };
type Draw = { id: string; label: string; percent: unknown; fundedAt: Date | null };

export function RehabPanel({
  holdingId,
  basis,
  costs,
  estimate,
}: {
  holdingId: string;
  basis: number;
  costs: Cost[];
  estimate: {
    arv: unknown;
    holdingMonths: number;
    monthlyHold: unknown;
    monthlyRent: unknown;
    expenseRatio: unknown;
    exitPath: string;
    lines: Line[];
    bids: Bid[];
    draws: Draw[];
  } | null;
}) {
  if (!estimate) {
    return (
      <section className="glass mt-8 p-6">
        <p className="eyebrow">Rehab estimator</p>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">Room and trade lines, contractor bids, a draw schedule, and a resale or rental picture. Unit costs start from the South Florida schedule.</p>
        <form action={openEstimate} className="mt-4">
          <input type="hidden" name="holdingId" value={holdingId} />
          <SubmitButton className="h-11 text-[13px] font-medium">Open the estimator</SubmitButton>
        </form>
      </section>
    );
  }
  const picture = rehabPicture({
    basis,
    lines: estimate.lines.map((line) => ({ quantity: Number(line.quantity), unitCostCents: line.unitCostCents })),
    bids: estimate.bids.map((bid) => ({ amount: Number(bid.amount), selected: bid.selected })),
    arv: Number(estimate.arv),
    holdingMonths: estimate.holdingMonths,
    monthlyHold: Number(estimate.monthlyHold),
    monthlyRent: Number(estimate.monthlyRent),
    expenseRatio: Number(estimate.expenseRatio),
  });
  return (
    <section className="glass mt-8 p-6">
      <p className="eyebrow">Rehab estimator</p>
      <p className="mt-2 text-sm text-muted-foreground">
        Desk budget {money(picture.budget)}
        {picture.usingBid ? ` · selected bid ${money(picture.hard)}` : ""}
        {" · holding "}{money(picture.holding)}
        {" · all-in "}{money(picture.allIn)}
        {estimate.exitPath === "RENTAL"
          ? ` · NOI ${money(picture.noi)} · cap ${picture.capRate == null ? "—" : `${picture.capRate.toFixed(1)}%`}`
          : ` · resale profit ${money(picture.resaleProfit)} against ARV ${money(Number(estimate.arv))}`}
      </p>
      <form action={saveEstimate} className="mt-5 grid gap-3 sm:grid-cols-3">
        <input type="hidden" name="holdingId" value={holdingId} />
        <label className="block"><span className="text-[13px] text-muted-foreground">ARV</span><input name="arv" defaultValue={Number(estimate.arv) || ""} className="desk-input mt-2" aria-label="After repair value" /></label>
        <label className="block"><span className="text-[13px] text-muted-foreground">Hold months</span><input name="holdingMonths" defaultValue={estimate.holdingMonths} className="desk-input mt-2" aria-label="Holding months" /></label>
        <label className="block"><span className="text-[13px] text-muted-foreground">Monthly hold</span><input name="monthlyHold" defaultValue={Number(estimate.monthlyHold)} className="desk-input mt-2" aria-label="Monthly holding cost" /></label>
        <label className="block"><span className="text-[13px] text-muted-foreground">Monthly rent</span><input name="monthlyRent" defaultValue={Number(estimate.monthlyRent)} className="desk-input mt-2" aria-label="Pro forma rent" /></label>
        <label className="block"><span className="text-[13px] text-muted-foreground">Expense ratio %</span><input name="expenseRatio" defaultValue={Number(estimate.expenseRatio)} className="desk-input mt-2" aria-label="Expense ratio" /></label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Exit</span>
          <select name="exitPath" defaultValue={estimate.exitPath} className="desk-input mt-2" aria-label="Rehab exit">
            <option value="RESALE">Resale</option>
            <option value="RENTAL">Rental</option>
          </select>
        </label>
        <SubmitButton className="h-11 text-[13px] font-medium">Save the picture</SubmitButton>
      </form>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <div>
          <p className="eyebrow">Lines</p>
          <ul className="mt-3 space-y-2 text-sm">
            {estimate.lines.length === 0 && <li className="text-muted-foreground">No rooms yet.</li>}
            {estimate.lines.map((line) => (
              <li key={line.id} className="text-foreground">
                {line.room ? `${line.room} · ` : ""}{line.trade} · {Number(line.quantity)} × {money(line.unitCostCents / 100)}
              </li>
            ))}
          </ul>
          <form action={addRehabLine} className="mt-4 grid gap-3">
            <input type="hidden" name="holdingId" value={holdingId} />
            <input name="room" className="desk-input" aria-label="Room" placeholder="Kitchen, bath, roof" />
            <select name="trade" className="desk-input" aria-label="Trade" defaultValue={costs[0]?.trade || ""}>
              {costs.map((cost) => (
                <option key={`${cost.trade}-${cost.unit}`} value={cost.trade}>{cost.trade} · {cost.unit} · {money(cost.costCents / 100)}</option>
              ))}
            </select>
            <input name="quantity" className="desk-input" aria-label="Quantity" placeholder="Quantity" />
            <input name="unitCost" className="desk-input" aria-label="Unit cost" placeholder="Unit cost, dollars" />
            <SubmitButton variant="outline" className="h-10 text-[13px] font-medium">Add line</SubmitButton>
          </form>
        </div>
        <div>
          <p className="eyebrow">Contractor bids</p>
          <ul className="mt-3 space-y-2 text-sm">
            {estimate.bids.length === 0 && <li className="text-muted-foreground">No bids yet. The line total is the budget until one is chosen.</li>}
            {estimate.bids.map((bid) => (
              <li key={bid.id} className="flex items-center justify-between gap-3">
                <span className="text-foreground">{bid.contractor} · {money(Number(bid.amount))}{bid.days ? ` · ${bid.days} days` : ""}{bid.selected ? " · selected" : ""}</span>
                {!bid.selected && (
                  <form action={selectContractor}>
                    <input type="hidden" name="holdingId" value={holdingId} />
                    <input type="hidden" name="bidId" value={bid.id} />
                    <SubmitButton variant="ghost" className="h-8 text-[13px] font-medium">Use</SubmitButton>
                  </form>
                )}
              </li>
            ))}
          </ul>
          <form action={addContractorBid} className="mt-4 grid gap-3">
            <input type="hidden" name="holdingId" value={holdingId} />
            <input name="contractor" className="desk-input" aria-label="Contractor" placeholder="Contractor" />
            <input name="amount" className="desk-input" aria-label="Bid amount" placeholder="Bid" />
            <input name="days" className="desk-input" aria-label="Bid days" placeholder="Days" />
            <SubmitButton variant="outline" className="h-10 text-[13px] font-medium">Add bid</SubmitButton>
          </form>
        </div>
      </div>

      <div className="mt-8">
        <p className="eyebrow">Draws</p>
        <ul className="mt-3 space-y-2 text-sm">
          {estimate.draws.map((draw) => (
            <li key={draw.id} className="flex items-center justify-between gap-3 text-foreground">
              <span>{draw.label} · {Number(draw.percent)}% · {money(drawDollars(picture.hard, Number(draw.percent)))}{draw.fundedAt ? " · funded" : ""}</span>
              {!draw.fundedAt && (
                <form action={fundDraw}>
                  <input type="hidden" name="holdingId" value={holdingId} />
                  <input type="hidden" name="id" value={draw.id} />
                  <SubmitButton variant="ghost" className="h-8 text-[13px] font-medium">Fund</SubmitButton>
                </form>
              )}
            </li>
          ))}
        </ul>
        <form action={addDraw} className="mt-4 flex flex-wrap gap-3">
          <input type="hidden" name="holdingId" value={holdingId} />
          <input name="label" className="desk-input" aria-label="Draw name" placeholder="Rough, finish" />
          <input name="percent" className="desk-input w-28" aria-label="Draw percent" placeholder="%" />
          <SubmitButton variant="outline" className="h-11 text-[13px] font-medium">Add draw</SubmitButton>
        </form>
      </div>
    </section>
  );
}
