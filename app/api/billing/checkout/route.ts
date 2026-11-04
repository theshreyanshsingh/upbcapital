import { NextResponse } from "next/server";
import Stripe from "stripe";
import { getApiUser } from "@/lib/auth";
import { appOrigin, checkoutUnavailableNote, simulatedCheckout, stripeConfigured } from "@/lib/billing";
import { shouldApplyReferralCredit } from "@/lib/acl";
import { unset } from "@/lib/db-filters";
import { prisma } from "@/lib/prisma";
import { getSettings, isPro } from "@/lib/settings";
import { liveSubscription, portalReturnUrl } from "@/lib/stripe-billing";

export const runtime = "nodejs";

export async function POST() {
  const user = await getApiUser();
  if (!user || user.role !== "BUYER" || user.accountStatus !== "APPROVED") {
    return NextResponse.redirect(new URL("/login", appOrigin()));
  }
  if (isPro(user)) {
    return NextResponse.redirect(new URL(`/buyer/subscription?notice=${encodeURIComponent("You are already on Pro.")}`, appOrigin()));
  }
  const settings = await getSettings();
  const priceId = settings.stripePriceId || process.env.STRIPE_PRO_PRICE_ID;
  if (!stripeConfigured(priceId) || !priceId) {
    const back = simulatedCheckout() ? "?notice=mock" : `?error=${encodeURIComponent(checkoutUnavailableNote())}`;
    return NextResponse.redirect(new URL(`/buyer/subscription${back}`, appOrigin()));
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  // The customer exists before Checkout, so every checkout for this buyer lands on one customer and the
  // check below sees a subscription started from another tab.
  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: user.email, name: user.name, metadata: { userId: user.id } });
    const { count } = await prisma.user.updateMany({ where: { id: user.id, ...unset("stripeCustomerId") }, data: { stripeCustomerId: customer.id } });
    customerId = count ? customer.id : (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).stripeCustomerId;
  }
  if (!customerId) return NextResponse.json({ error: "No Stripe customer for this account." }, { status: 500 });
  // A lapsed or past-due subscription is still there. Fixing the card in the portal restarts it; a second
  // Checkout would bill both once it did.
  if (await liveSubscription(stripe, customerId)) {
    const portal = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: portalReturnUrl() });
    return NextResponse.redirect(portal.url);
  }
  const applyCredit = shouldApplyReferralCredit(user.referralCredits);
  let couponId = "";
  if (applyCredit) {
    const coupon = await stripe.coupons.create({
      amount_off: settings.proMonthlyPriceCents,
      currency: "usd",
      duration: "once",
      name: "UPB referral month",
      max_redemptions: 1,
    });
    couponId = coupon.id;
  }
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${appOrigin()}/buyer/subscription?notice=stripe_success`,
    cancel_url: `${appOrigin()}/buyer/subscription?notice=stripe_cancel`,
    customer: customerId,
    client_reference_id: user.id,
    discounts: couponId ? [{ coupon: couponId }] : undefined,
    metadata: { userId: user.id, referralCredit: applyCredit ? "1" : "0" },
    subscription_data: { metadata: { userId: user.id, referralCredit: applyCredit ? "1" : "0" } },
  });
  if (!session.url) return NextResponse.json({ error: "Stripe did not return a checkout URL." }, { status: 500 });
  return NextResponse.redirect(session.url);
}
