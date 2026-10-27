import { NextResponse } from "next/server";
import Stripe from "stripe";
import { getCurrentUser } from "@/lib/auth";
import { appOrigin, simulatedCheckout, stripeConfigured, UNPRICED_NOTE } from "@/lib/billing";
import { shouldApplyReferralCredit } from "@/lib/acl";
import { getSettings } from "@/lib/settings";

export const runtime = "nodejs";

export async function POST() {
  const user = await getCurrentUser();
  if (!user || user.role !== "BUYER" || user.accountStatus !== "APPROVED") {
    return NextResponse.redirect(new URL("/login", appOrigin()));
  }
  const settings = await getSettings();
  const priceId = settings.stripePriceId || process.env.STRIPE_PRO_PRICE_ID;
  if (!stripeConfigured(priceId) || !priceId) {
    const back = simulatedCheckout() ? "?notice=mock" : `?error=${encodeURIComponent(UNPRICED_NOTE)}`;
    return NextResponse.redirect(new URL(`/buyer/subscription${back}`, appOrigin()));
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
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
    customer_email: user.stripeCustomerId ? undefined : user.email,
    customer: user.stripeCustomerId || undefined,
    client_reference_id: user.id,
    discounts: couponId ? [{ coupon: couponId }] : undefined,
    metadata: { userId: user.id, referralCredit: applyCredit ? "1" : "0" },
    subscription_data: { metadata: { userId: user.id, referralCredit: applyCredit ? "1" : "0" } },
  });
  if (!session.url) return NextResponse.json({ error: "Stripe did not return a checkout URL." }, { status: 500 });
  return NextResponse.redirect(session.url);
}
