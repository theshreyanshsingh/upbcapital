import { setLadder, stopLadder } from "@/actions/price-ladder";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { PriceHistory } from "@/components/price-history";
import { SubmitButton } from "@/components/submit-button";
import { money } from "@/lib/format";
import { priceHistory } from "@/lib/price-history";
import {
  LADDER_DEFAULTS,
  LADDER_EVERY_CHOICES,
  LADDER_SELECT,
  LADDER_STEP_MAX_PCT,
  LADDER_STEP_MIN_PCT,
  ladderBlock,
  ladderLine,
  ladderRunning,
  openAsk,
  stepsToFloor,
} from "@/lib/price-ladder";
import { prisma } from "@/lib/prisma";
import { deskCan, type Staff } from "@/lib/staff";

// The price ladder and the price history on the seller's listing page and the desk's (lib/price-ladder.ts). The
// seller and the sales side of the desk set or stop it; anyone else on the page reads it.
export async function PriceLadderPanel({ listingId, viewer, from }: { listingId: string; viewer: Staff & { id: string }; from: "seller" | "desk" }) {
  const [listing, history] = await Promise.all([prisma.listing.findUnique({ where: { id: listingId }, select: LADDER_SELECT }), priceHistory(listingId)]);
  if (!listing) return null;
  const running = ladderRunning(listing);
  const line = ladderLine(listing);
  if (listing.status !== "APPROVED" && !history.length && !line) return null;
  const canRun = listing.sellerId === viewer.id || deskCan(viewer, "sales");
  const blocked = ladderBlock(listing);
  const { ask } = openAsk(listing.notes);
  const exampleFloor = Math.round(ask * 0.85);
  const hidden = (
    <>
      <input type="hidden" name="listingId" value={listing.id} />
      <input type="hidden" name="from" value={from} />
    </>
  );

  return (
    <section id="price-ladder" aria-labelledby="price-ladder-heading" className="mt-6 scroll-mt-6 border border-border p-5 rounded-xl">
      <h2 id="price-ladder-heading" className="eyebrow">Price ladder</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        The ask steps down on a schedule until a buyer bids or it reaches {from === "desk" ? "the seller's" : "your"} floor. A step waits while any bid is live.
        Buyers see each new price and saved-listing alerts go out as for any reprice. No buyer sees the schedule or the floor.
      </p>
      {line && <p className={`mt-3 max-w-2xl text-sm tabular-nums ${running ? "text-foreground" : "text-muted-foreground"}`}>{line}</p>}

      {running && canRun && (
        <form action={stopLadder} className="mt-4">
          {hidden}
          <ConfirmSubmit
            title="Stop the price ladder?"
            consequence={`The ask stays at ${money(ask)}. You can set a new ladder later.`}
            confirmLabel="Stop it"
            pendingLabel="Stopping…"
            variant="outline"
            className="h-10 text-[13px] font-medium"
          >
            Stop the ladder
          </ConfirmSubmit>
        </form>
      )}

      {!running && canRun && blocked && listing.status === "APPROVED" && <p className="mt-3 text-sm text-muted-foreground">{blocked}</p>}

      {!running && canRun && !blocked && (
        <form action={setLadder} className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-3">
          {hidden}
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Step down by</span>
            <span className="mt-2 flex items-center gap-2">
              <input name="step" type="number" inputMode="decimal" min={LADDER_STEP_MIN_PCT} max={LADDER_STEP_MAX_PCT} step="0.5" defaultValue={LADDER_DEFAULTS.stepPct} required className="desk-input" aria-describedby="ladder-step-hint" />
              <span className="text-sm text-muted-foreground">%</span>
            </span>
            <span id="ladder-step-hint" className="mt-1 block text-xs text-muted-foreground">Of the ask at each step, {LADDER_STEP_MIN_PCT}% to {LADDER_STEP_MAX_PCT}%.</span>
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Every</span>
            <select name="every" defaultValue={String(LADDER_DEFAULTS.everyDays)} className="desk-input mt-2">
              {LADDER_EVERY_CHOICES.map((days) => (
                <option key={days} value={days}>{days} days</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Floor, the lowest ask</span>
            <input name="floor" inputMode="decimal" required placeholder={ask > 0 ? money(exampleFloor) : ""} className="desk-input mt-2" aria-describedby="ladder-floor-hint" />
            <span id="ladder-floor-hint" className="mt-1 block text-xs text-muted-foreground tabular-nums">
              Today&apos;s ask is {money(ask)}.{ask > 0 ? ` At ${LADDER_DEFAULTS.stepPct}% a step, ${money(exampleFloor)} is ${stepsToFloor(ask, LADDER_DEFAULTS.stepPct * 100, exampleFloor)} steps away.` : ""}
            </span>
          </label>
          <div className="sm:col-span-3">
            <SubmitButton className="h-10 text-[13px] font-medium" pendingLabel="Setting…">Set the ladder</SubmitButton>
          </div>
        </form>
      )}

      <PriceHistory rows={history} showSource className="mt-5" />
    </section>
  );
}
