import { saveSettings } from "@/actions/admin";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { simulatedCheckout, stripeConfigured } from "@/lib/billing";
import { q } from "@/lib/format";
import { bpsToPercent } from "@/lib/money";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "Fee schedule" };

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole(["ADMIN"]);
  const params = await searchParams;
  const settings = await getSettings();
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
            : "Stripe secret is set but there is no Pro price yet. Buyers cannot check out until you save the price below."}
      </p>
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
          <input name="proPrice" defaultValue={(settings.proMonthlyPriceCents / 100).toFixed(2)} step="0.01" className="desk-input mt-2" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Early access (hours)</span>
          <input name="earlyAccessHours" defaultValue={settings.earlyAccessHours} className="desk-input mt-2" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Free listings a buyer can open</span>
          <input name="freeBrowseLimit" defaultValue={settings.freeBrowseLimit} className="desk-input mt-2" />
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
          <span>Charge the buyer premium and the seller commission when the desk buys the note. Turn this off to run those purchases through the checklist with a zero fee.</span>
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
