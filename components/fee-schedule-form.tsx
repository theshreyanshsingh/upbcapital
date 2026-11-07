import { saveFeeSchedule } from "@/actions/fee-schedule";
import { SubmitButton } from "@/components/submit-button";
import { MAX_TIERS, readSchedule, type FeeTier } from "@/lib/fee-schedule";
import { bpsToPercent } from "@/lib/money";

const SPARE_ROWS = 2;

// The desk's graded schedule on the settings page. A tier's rates apply to the whole price that falls in it, and
// each side then pays at least its minimum. Blank rows are skipped, and the last tier's "up to" stays blank.
export function FeeScheduleForm({ settings, owns }: { settings: { feeSchedule?: unknown; buyerPremiumBps: number; sellerCommissionBps: number }; owns: boolean }) {
  const schedule = readSchedule(settings.feeSchedule);
  const tiers: (FeeTier | null)[] = schedule ? [...schedule.tiers] : [];
  while (tiers.length < Math.min(MAX_TIERS, (schedule?.tiers.length ?? 0) + SPARE_ROWS) || tiers.length < 3) tiers.push(null);
  const dollars = (cents: number | undefined) => (cents ? String(cents / 100) : "");
  return (
    <form id="graded-fees" action={saveFeeSchedule} className="mt-8 scroll-mt-6 space-y-5 glass p-6" aria-labelledby="graded-fees-heading">
      <div>
        <p id="graded-fees-heading" className="eyebrow">Graded by sale size</p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Each sale pays the rates of the tier its price falls in, on the whole price. It is not worked out band by band. Each side then pays at least its minimum, and never more than the price. Listings already live keep the fees they went live with.
        </p>
        <p className="mt-2 text-sm text-foreground">
          {schedule ? `Now: ${schedule.tiers.length} tier${schedule.tiers.length === 1 ? "" : "s"}. This replaces the flat rates above for new approvals.` : `Now: no graded schedule, so new approvals take the flat ${bpsToPercent(settings.buyerPremiumBps).toFixed(2)}% premium and ${bpsToPercent(settings.sellerCommissionBps).toFixed(2)}% commission.`}
        </p>
      </div>
      <div className="space-y-3">
        <div className="hidden grid-cols-3 gap-3 text-[13px] text-muted-foreground sm:grid">
          <span>Up to (USD)</span>
          <span>Buyer premium (%)</span>
          <span>Seller commission (%)</span>
        </div>
        {tiers.map((tier, index) => (
          <fieldset key={index} className="grid grid-cols-1 gap-3 border-t border-border pt-3 sm:grid-cols-3 sm:border-0 sm:pt-0">
            <legend className="sr-only">Tier {index + 1}</legend>
            <label className="block">
              <span className="text-[13px] text-muted-foreground sm:sr-only">Tier {index + 1} up to (USD)</span>
              <input name="tierUpTo" inputMode="decimal" defaultValue={tier?.upTo ?? ""} placeholder={index === 0 ? "100,000" : "Blank on the last tier"} className="desk-input mt-2 tabular-nums sm:mt-0" aria-label={`Tier ${index + 1} up to`} />
            </label>
            <label className="block">
              <span className="text-[13px] text-muted-foreground sm:sr-only">Tier {index + 1} buyer premium (%)</span>
              <input name="tierPremium" inputMode="decimal" defaultValue={tier ? bpsToPercent(tier.premiumBps) : ""} className="desk-input mt-2 tabular-nums sm:mt-0" aria-label={`Tier ${index + 1} buyer premium`} />
            </label>
            <label className="block">
              <span className="text-[13px] text-muted-foreground sm:sr-only">Tier {index + 1} seller commission (%)</span>
              <input name="tierCommission" inputMode="decimal" defaultValue={tier ? bpsToPercent(tier.commissionBps) : ""} className="desk-input mt-2 tabular-nums sm:mt-0" aria-label={`Tier ${index + 1} seller commission`} />
            </label>
          </fieldset>
        ))}
        <p className="text-xs text-muted-foreground">Tiers go up in price. Rates run from 0% to 10%. Leave “up to” blank on the last tier so every price has one.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Minimum buyer premium (USD)</span>
          <input name="minPremium" inputMode="decimal" defaultValue={dollars(schedule?.minPremiumCents)} placeholder="0" className="desk-input mt-2 tabular-nums" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Minimum seller commission (USD)</span>
          <input name="minCommission" inputMode="decimal" defaultValue={dollars(schedule?.minCommissionCents)} placeholder="0" className="desk-input mt-2 tabular-nums" />
        </label>
      </div>
      {owns ? (
        <div className="flex flex-wrap gap-3">
          <SubmitButton className="h-11 text-[13px] font-medium" pendingLabel="Saving…">Save graded schedule</SubmitButton>
          {schedule && (
            <SubmitButton variant="outline" name="intent" value="clear" className="h-11 text-[13px] font-medium" pendingLabel="Clearing…">
              Go back to flat rates
            </SubmitButton>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Only an owner changes the fee schedule.</p>
      )}
    </form>
  );
}
