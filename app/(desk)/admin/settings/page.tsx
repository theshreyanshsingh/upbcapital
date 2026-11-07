import { saveSettings } from "@/actions/admin";
import { saveMarketRates } from "@/actions/market-rates";
import { saveSettlementSettings } from "@/actions/settlement-settings";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { simulatedCheckout, stripeConfigured } from "@/lib/billing";
import { isoDate, prettyDate, q } from "@/lib/format";
import { DEFAULT_INDICATIVE_YIELD, indicativeTarget, marketRate, RATE_STALE_DAYS, rateStamp } from "@/lib/indicative";
import { bpsToPercent } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { SETTLEMENT_WEEKDAYS, depositTerms, settlementLabel, settlementWeekdays, targetDays } from "@/lib/closing-clock";
import { diligenceDays } from "@/lib/closing-service";
import { launchReadiness } from "@/lib/readiness";
import { strikeLimitOf } from "@/lib/strikes";
import { decideWires } from "@/actions/wires";
import { BackstopSettings } from "@/components/backstop-settings";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { ReaderSettings } from "@/components/document-reader";
import { FeeScheduleForm } from "@/components/fee-schedule-form";
import { RecertifySettings } from "@/components/recertify-settings";
import { SellerIdentitySetting } from "@/components/seller-identity";
import { SignatureSettings } from "@/components/signature-panel";
import { deskCan } from "@/lib/staff";
import { pendingWireChanges } from "@/lib/wire-changes";

export const metadata = { title: "Fee schedule" };

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["ADMIN"]);
  const params = await searchParams;
  const settings = await getSettings();
  // Every desk role reads the schedule. Only an owner saves it, and a wire change also waits for a second person.
  const owns = deskCan(user, "admin");
  const pendingWires = await pendingWireChanges(null);
  const readiness = await launchReadiness(settings);
  const rate = marketRate(settings);
  const stamp = rate ? rateStamp(rate.asOf) : null;
  const target = indicativeTarget(settings.indicativeTargetYield);
  return (
    <div className="max-w-2xl">
      <PageIntro
        eyebrow="Fee schedule"
        title="What the desk charges."
        lede="These rates show on listings, offers, and seller desks immediately. When a Stripe secret is set, saving the Pro price creates or replaces the Stripe Price used at checkout."
      />
      <Notice notice={q(params, "notice") === "saved" ? "saved_settings" : q(params, "notice")} error={q(params, "error")} />
      <p className="mt-4 text-sm text-muted-foreground">
        Billing mode: {stripeConfigured(settings.stripePriceId)
          ? `Stripe price ${settings.stripePriceId || process.env.STRIPE_PRO_PRICE_ID}.`
          : simulatedCheckout()
            ? "Simulated checkout. Set STRIPE_SECRET_KEY to create the Pro price from this page."
            : process.env.STRIPE_SECRET_KEY
              ? "Stripe secret is set but there is no Pro price yet. Buyers cannot check out until you save the price below."
              : "Checkout is closed. A release needs STRIPE_SECRET_KEY before buyers can pay for Pro."}
      </p>
      <section className="mt-6 glass p-6" aria-labelledby="readiness-heading">
        <p id="readiness-heading" className="eyebrow">Launch readiness</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {readiness.ready ? "Every service runs for real." : "Stand-ins are fine for the demo desk. Each one is a decision to make before real users arrive."}
        </p>
        <ul className="mt-4 divide-y divide-border">
          {readiness.items.map((item) => (
            <li key={item.label} className="flex flex-wrap items-baseline justify-between gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-foreground">{item.label}</p>
                <p className="text-xs text-muted-foreground">{item.detail}</p>
              </div>
              <span className={`whitespace-nowrap text-[13px] font-medium ${item.state === "live" ? "text-good" : item.state === "off" ? "text-bad" : "text-muted-foreground"}`}>
                {item.state === "live" ? "Live" : item.state === "off" ? "Off" : "Stand-in"}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <form action={saveSettings} className="mt-8 space-y-5 glass p-6">
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Buyer premium (%)</span>
          <input name="buyerPremium" defaultValue={bpsToPercent(settings.buyerPremiumBps)} step="0.01" className="desk-input mt-2" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Seller commission (%)</span>
          <input name="sellerCommission" defaultValue={bpsToPercent(settings.sellerCommissionBps)} step="0.01" className="desk-input mt-2" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Pro price (USD / month)</span>
          <input name="proPrice" type="number" min="0.50" defaultValue={(settings.proMonthlyPriceCents / 100).toFixed(2)} step="0.01" className="desk-input mt-2" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Early access (hours)</span>
          <input name="earlyAccessHours" defaultValue={settings.earlyAccessHours} className="desk-input mt-2" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Free listings a buyer can open</span>
          <input name="freeBrowseLimit" defaultValue={settings.freeBrowseLimit} className="desk-input mt-2" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Days from an accepted offer to the target close</span>
          <input name="closingTargetDays" defaultValue={targetDays(settings.closingTargetDays)} className="desk-input mt-2" />
          <span className="mt-1 block text-xs text-muted-foreground">Sets the step due dates on new closings. Open closings keep their dates.</span>
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Buyer deposit at award (% of price)</span>
          <input name="depositPercent" defaultValue={depositTerms(settings).bps / 100} className="desk-input mt-2" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Days to wire the deposit</span>
          <input name="depositDays" defaultValue={depositTerms(settings).days} className="desk-input mt-2" />
          <span className="mt-1 block text-xs text-muted-foreground">Set on each new closing. Zero percent means no deposit. The desk records the wire in the closing room.</span>
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Buyer diligence window (days after an award)</span>
          <input name="diligenceDays" inputMode="numeric" defaultValue={diligenceDays(settings.diligenceDays) || ""} placeholder="None" className="desk-input mt-2" />
          <span className="mt-1 block text-xs text-muted-foreground">Until it ends, the buyer can walk away from the closing for a finding, with a reason both sides read. Zero or blank means none. Desk purchases have no window. Set on each new closing.</span>
        </label>
        <label className="flex items-start gap-3">
          <input type="checkbox" name="requireTwoStep" defaultChecked={settings.requireTwoStep !== false} className="mt-1" />
          <span className="text-sm text-foreground">Require two-step sign-in for every buyer, seller, and broker<span className="mt-1 block text-xs text-muted-foreground">They can see borrower data, so they enroll an authenticator before using the desk, as admins already do. Demo seats on undeliverable addresses are exempt.</span></span>
        </label>
        <fieldset className="space-y-3 border-t border-border pt-5">
          <legend className="eyebrow">Broker compensation</legend>
          <p className="text-sm text-muted-foreground">A percentage is taken from the buyer premium plus the seller commission. A flat amount is owed even when that pool is small. Each broker can override this.</p>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Broker fee</span>
            <select name="brokerFeeBasis" defaultValue={settings.brokerFeeBasis} className="desk-input mt-2" aria-label="Broker fee basis">
              <option value="PERCENT">Percent of premium + commission</option>
              <option value="FLAT">Flat amount</option>
            </select>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Broker percent</span>
              <input name="brokerFeePercent" defaultValue={bpsToPercent(settings.brokerFeeBps)} step="0.01" className="desk-input mt-2" aria-label="Broker fee percent" />
            </label>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Broker flat (USD)</span>
              <input name="brokerFeeFlat" defaultValue={(settings.brokerFeeCents / 100).toFixed(2)} step="0.01" className="desk-input mt-2" aria-label="Broker flat fee" />
            </label>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Affiliate percent</span>
              <input name="affiliateFeePercent" defaultValue={bpsToPercent(settings.affiliateFeeBps)} step="0.01" className="desk-input mt-2" aria-label="Affiliate fee percent" />
            </label>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Affiliate flat (USD)</span>
              <input name="affiliateFeeFlat" defaultValue={(settings.affiliateFeeCents / 100).toFixed(2)} step="0.01" className="desk-input mt-2" aria-label="Affiliate flat fee" />
            </label>
          </div>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Affiliate fee basis</span>
            <select name="affiliateFeeBasis" defaultValue={settings.affiliateFeeBasis} className="desk-input mt-2" aria-label="Affiliate fee basis">
              <option value="PERCENT">Percent of premium + commission</option>
              <option value="FLAT">Flat amount</option>
            </select>
          </label>
        </fieldset>
        <label className="flex items-start gap-3 text-sm text-foreground">
          <input type="checkbox" name="chargeDeskFees" value="on" defaultChecked={settings.chargeDeskFees} className="mt-1" />
          <span>Charge the seller commission when the desk buys the note. The desk never pays itself a buyer premium. Turn this off to run those purchases through the checklist with no fee.</span>
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Default wire instructions</span>
          <textarea name="wireInstructions" defaultValue={settings.wireInstructions} className="desk-input mt-2 min-h-28" />
          <span className="mt-1 block text-xs text-muted-foreground">New closings start with these. A change waits until a second desk member who approves wires approves it.</span>
        </label>
        {settings.stripePriceId && <p className="text-xs text-muted-foreground">Current Stripe price {settings.stripePriceId}</p>}
        {owns ? <SubmitButton className="h-11 text-[13px] font-medium">Save schedule</SubmitButton> : <p className="text-sm text-muted-foreground">Only an owner changes the fee schedule.</p>}
      </form>
      <FeeScheduleForm settings={settings} owns={owns} />
      {pendingWires.length > 0 && (
        <section id="wires" aria-labelledby="wires-heading" className="mt-8 scroll-mt-6 space-y-3 rounded-xl border border-warn/40 bg-warn/5 p-6">
          <p id="wires-heading" className="eyebrow">Default wire change waiting for approval</p>
          {pendingWires.map((change) => (
            <div key={change.id} className="space-y-2">
              <p className="text-xs text-muted-foreground">Proposed by {change.proposedBy} on {prettyDate(change.createdAt)}. Open closings keep their own instructions.</p>
              <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-foreground/85">{change.instructions || "No instructions. Approving clears the default."}</pre>
              {deskCan(user, "approveWires") ? (
                <div className="flex flex-wrap gap-2">
                  {change.proposedById !== user.id && (
                    <form action={decideWires}>
                      <input type="hidden" name="changeId" value={change.id} />
                      <input type="hidden" name="decision" value="APPROVED" />
                      <ConfirmSubmit
                        title="Approve the new default wire instructions?"
                        consequence="Every closing opened from now on starts with them. Open closings keep the instructions they have."
                        confirmLabel="Approve"
                        pendingLabel="Approving…"
                        className="h-9 text-[13px] font-medium"
                      >
                        Approve
                      </ConfirmSubmit>
                    </form>
                  )}
                  <form action={decideWires}>
                    <input type="hidden" name="changeId" value={change.id} />
                    <input type="hidden" name="decision" value="REJECTED" />
                    <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Saving…">{change.proposedById === user.id ? "Withdraw" : "Reject"}</SubmitButton>
                  </form>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">A desk member who approves wires decides it.</p>
              )}
              {change.proposedById === user.id && <p className="text-xs text-muted-foreground">You proposed this, so someone else approves it.</p>}
            </div>
          ))}
        </section>
      )}
      <form id="market-rates" action={saveMarketRates} className="mt-8 scroll-mt-6 space-y-5 glass p-6" aria-labelledby="market-rates-heading">
        <div>
          <p id="market-rates-heading" className="eyebrow">Market rates</p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Spread rules on buy boxes price for the 10-year Treasury yield plus the buyer&apos;s spread. Each morning the jobs run reads the 10-year from Treasury&apos;s daily par yield curve. A rate saved here holds over that read until the next business day, so you can correct a bad read. Saving a new rate reprices every open spread match. Past {RATE_STALE_DAYS} days, every spread-based figure shows its rate date in the warn colour.
          </p>
          <p className="mt-2 text-sm tabular-nums">
            {rate && stamp ? (
              <span className={stamp.stale ? "text-warn" : "text-foreground"}>
                On file: {rate.rate}%, {stamp.text}{stamp.stale ? ", over a week old" : ""}, {settings.tenYearSource === "TREASURY" ? "read from Treasury's daily par yield curve" : "entered by the desk"}.
              </span>
            ) : (
              <span className="text-warn">No rate on file, so spread rules price nothing yet.</span>
            )}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-[13px] text-muted-foreground">10-year Treasury yield (%)</span>
            <input name="tenYearRate" inputMode="decimal" required defaultValue={rate?.rate ?? ""} placeholder="4.95" className="desk-input mt-2 tabular-nums" />
            <span className="mt-1 block text-xs text-muted-foreground">The constant-maturity yield from the Federal Reserve&apos;s H.15 release or Treasury&apos;s daily par curve.</span>
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Date the rate was read</span>
            <input name="tenYearAsOf" type="date" required defaultValue={isoDate(rate?.asOf ?? null) ?? ""} className="desk-input mt-2 tabular-nums" />
          </label>
        </div>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Yield for the book&apos;s indicative price (%)</span>
          <input name="indicativeTargetYield" inputMode="decimal" defaultValue={settings.indicativeTargetYield ?? ""} placeholder={`${DEFAULT_INDICATIVE_YIELD}, the default`} className="desk-input mt-2 tabular-nums" />
          <span className="mt-1 block text-xs text-muted-foreground">
            The desk model prices every listing&apos;s indicative range for this IRR, one point either side. Now {target.label}. Blank keeps the default.
          </span>
        </label>
        {owns ? <SubmitButton className="h-11 text-[13px] font-medium" pendingLabel="Repricing…">Save rates</SubmitButton> : <p className="text-sm text-muted-foreground">Only an owner changes market rates.</p>}
      </form>
      <form id="settlement" action={saveSettlementSettings} className="mt-8 scroll-mt-6 space-y-5 glass p-6" aria-labelledby="settlement-heading">
        <div>
          <p id="settlement-heading" className="eyebrow">Settlement and winner discipline</p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            New closings take their payment and close dates on the next settlement day, so the desk sends wires in batches. Open closings keep their dates. Leave every day unticked to settle on any business day.
          </p>
          <p className="mt-2 text-sm text-foreground">Now: {settlementLabel(settings.settlementDays)}.</p>
        </div>
        <fieldset>
          <legend className="text-[13px] text-muted-foreground">Settlement days</legend>
          <div className="mt-2 flex flex-wrap gap-4">
            {SETTLEMENT_WEEKDAYS.map((weekday) => (
              <label key={weekday.key} className="flex items-center gap-2 text-sm text-foreground">
                <input type="checkbox" name="settlementDays" value={weekday.key} defaultChecked={Boolean(settings.settlementDays) && settlementWeekdays(settings.settlementDays).includes(weekday.day)} />
                {weekday.label}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Strikes before a buyer&apos;s bidding pauses</span>
          {/* With no save button for other roles, a lone text field would still submit on Enter, so it reads only. */}
          <input name="strikeLimit" inputMode="numeric" required disabled={!owns} defaultValue={strikeLimitOf(settings.strikeLimit)} className="desk-input mt-2 tabular-nums" />
          <span className="mt-1 block text-xs text-muted-foreground">A strike is recorded when the desk cancels a closing as the buyer&apos;s failure to close. At this many, new bids are refused until the desk clears one on the buyer file.</span>
        </label>
        {owns ? <SubmitButton className="h-11 text-[13px] font-medium" pendingLabel="Saving…">Save settlement</SubmitButton> : <p className="text-sm text-muted-foreground">Only an owner changes settlement days.</p>}
      </form>
      <BackstopSettings owns={owns} stallDays={settings.stallDays} />
      <RecertifySettings owns={owns} months={settings.recertifyMonths} />
      <SignatureSettings owns={owns} setting={settings.psaSignHours} />
      <ReaderSettings owns={owns} />
      <SellerIdentitySetting value={settings.requireSellerIdentity} owns={owns} />
    </div>
  );
}
