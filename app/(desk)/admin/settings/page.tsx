import { saveSettings } from "@/actions/admin";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { simulatedCheckout, stripeConfigured } from "@/lib/billing";
import { q } from "@/lib/format";
import { bpsToPercent } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { depositTerms, targetDays } from "@/lib/closing-clock";
import { diligenceDays } from "@/lib/closing-service";
import { launchReadiness } from "@/lib/readiness";

export const metadata = { title: "Fee schedule" };

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole(["ADMIN"]);
  const params = await searchParams;
  const settings = await getSettings();
  const readiness = await launchReadiness(settings);
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
        </label>
        {settings.stripePriceId && <p className="text-xs text-muted-foreground">Current Stripe price {settings.stripePriceId}</p>}
        <SubmitButton className="h-11 text-[13px] font-medium">Save schedule</SubmitButton>
      </form>
    </div>
  );
}
