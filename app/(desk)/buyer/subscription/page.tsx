import Link from "next/link";
import { mockActivatePro, mockCancelPro } from "@/actions/billing";
import { startProTrial } from "@/actions/trial";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { checkoutUnavailableNote, simulatedCheckout, stripeConfigured } from "@/lib/billing";
import { prettyDate, q } from "@/lib/format";
import { ensureReferralCode } from "@/lib/referral";
import { getSettings, isPro } from "@/lib/settings";
import { onFreeTrial, trialOffer } from "@/lib/trial";

export const metadata = { title: "Membership" };

export default async function SubscriptionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["BUYER", "ADMIN"]);
  const params = await searchParams;
  const settings = await getSettings();
  const pro = isPro(user);
  // A no-card trial is Pro on the book, but checkout stays open so the buyer can keep it.
  const freeTrial = onFreeTrial(user);
  const offer = user.role === "BUYER" ? await trialOffer(user) : null;
  const trialDays = offer && !offer.problem ? offer.days : 0;
  const stripe = stripeConfigured(settings.stripePriceId);
  const simulated = simulatedCheckout();
  const code = user.role === "BUYER" ? await ensureReferralCode(user.id, user.name) : user.referralCode;
  const price = settings.proMonthlyPriceCents / 100;
  return (
    <div>
      <PageIntro
        eyebrow="Membership"
        title={freeTrial ? "You are trying Pro." : pro ? "You are on Pro." : "The free desk, and the full one."}
        lede={stripe ? "Checkout runs through Stripe in test mode." : simulated ? "Stripe keys are not set. Checkout is simulated and written to the revenue ledger as a mock charge." : checkoutUnavailableNote()}
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      {q(params, "reason") === "dataroom" && <p className="mt-4 text-sm text-foreground">The data room is part of Pro.</p>}
      {q(params, "reason") === "alerts" && <p className="mt-4 text-sm text-foreground">Saved-search alerts are part of Pro.</p>}
      {(q(params, "reason") === "access" || q(params, "reason") === "early" || q(params, "reason") === "limit") && (
        <p className="mt-4 text-sm text-foreground">That listing is outside the free book.</p>
      )}
      {freeTrial && user.trialEndsAt && (
        <section className="mt-6 glass p-6">
          <p className="eyebrow">Pro trial</p>
          <p className="mt-2 text-sm leading-relaxed text-foreground">
            Pro is on until {prettyDate(user.trialEndsAt)}. Nothing is charged. After that the account goes back to the free desk, unless you subscribe below.
          </p>
        </section>
      )}
      {trialDays > 0 && offer?.mode === "free" && (
        <section className="mt-6 glass p-6">
          <p className="eyebrow">Try Pro</p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Try every Pro feature for {trialDays} day{trialDays === 1 ? "" : "s"}, once. No card. Access ends on the last day and nothing is charged.
          </p>
          <form action={startProTrial} className="mt-4">
            <SubmitButton className="h-11 text-[13px] font-medium" pendingLabel="Starting…">Start the {trialDays}-day trial</SubmitButton>
          </form>
        </section>
      )}
      {trialDays > 0 && offer?.mode === "card" && stripe && (
        <p className="mt-6 text-sm leading-relaxed text-foreground">
          The first {trialDays} day{trialDays === 1 ? " is" : "s are"} free. Stripe takes the card at checkout and bills ${price.toLocaleString("en-US")} a month after the trial, unless you cancel first.
        </p>
      )}
      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <article className="border border-border p-7 rounded-xl">
          <p className="eyebrow">Free</p>
          <p className="mt-3 font-semibold tracking-tight text-[28px] text-foreground">$0</p>
          <ul className="mt-5 space-y-2 text-sm text-muted-foreground">
            <li>{settings.freeBrowseLimit} open listings</li>
            <li>Metrics veiled</li>
            <li>No data room</li>
            <li>No early access</li>
          </ul>
        </article>
        <article className="glass p-7">
          <p className="eyebrow">Pro</p>
          <p className="mt-3 font-semibold tracking-tight text-[28px] text-foreground">${price.toLocaleString("en-US")}<span className="text-lg text-muted-foreground"> / mo</span></p>
          <ul className="mt-5 space-y-2 text-sm text-muted-foreground">
            <li>Every live listing, including the first {settings.earlyAccessHours} hours</li>
            <li>Price to UPB, LTV, and yield</li>
            <li>Data room after confidentiality</li>
            <li>Saved-search alerts</li>
          </ul>
          <div className="mt-6">
            {user.role !== "BUYER" ? (
              <p className="text-sm text-muted-foreground">Membership is for buyer accounts.</p>
            ) : pro && !freeTrial ? (
              !simulated ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">Manage the card, invoices, and cancellation in Stripe.</p>
                  <form action="/api/billing/portal" method="post">
                    <SubmitButton variant="outline" className="h-11 text-[13px] font-medium">Open the customer portal</SubmitButton>
                  </form>
                </div>
              ) : (
                <form action={mockCancelPro}>
                  <SubmitButton variant="outline" className="h-11 text-[13px] font-medium">Cancel Pro</SubmitButton>
                </form>
              )
            ) : stripe ? (
              // The route sends a buyer whose subscription still exists to the portal, so a lapsed card is fixed there.
              <form action="/api/billing/checkout" method="post" className="space-y-3">
                {user.subscriptionStatus === "PAST_DUE" && <p className="text-sm text-muted-foreground">The last payment didn&apos;t go through. Update the card in Stripe to restart Pro.</p>}
                <SubmitButton className="h-11 text-[13px] font-medium">Continue to Stripe</SubmitButton>
              </form>
            ) : simulated ? (
              <form action={mockActivatePro}>
                <SubmitButton className="h-11 text-[13px] font-medium">Activate Pro · simulated</SubmitButton>
              </form>
            ) : (
              <p className="text-sm text-muted-foreground">{checkoutUnavailableNote()}</p>
            )}
          </div>
        </article>
      </div>
      {user.role === "BUYER" && (
        <section className="mt-8 glass p-6">
          <p className="eyebrow">Referral</p>
          <p className="mt-3 font-semibold tracking-tight text-3xl text-foreground">{code}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {user.referralCredits} free month{user.referralCredits === 1 ? "" : "s"} banked. A buyer who signs up with this code credits you one month the first time they activate Pro. On Stripe checkout, one credit becomes a one-time coupon for the Pro price. On the simulated checkout, it skips the ledger charge.
          </p>
        </section>
      )}
      <p className="mt-8 text-sm text-muted-foreground">
        Current plan: {freeTrial ? "Pro trial" : pro ? "Pro" : "Free"}{user.subscriptionComped ? " · comped by the desk" : ""}. <Link href="/marketplace" className="text-link">Return to the book</Link>
      </p>
    </div>
  );
}
