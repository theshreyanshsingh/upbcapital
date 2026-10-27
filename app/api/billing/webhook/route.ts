import { NextResponse } from "next/server";
import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!secret || !key) return NextResponse.json({ error: "Stripe is not configured." }, { status: 400 });
  const stripe = new Stripe(key);
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Missing signature." }, { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, secret);
  } catch {
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.metadata?.userId || session.client_reference_id;
    if (userId) {
      const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
      const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
      const buyer = await prisma.user.update({
        where: { id: userId },
        data: {
          subscriptionTier: "PRO",
          subscriptionStatus: "ACTIVE",
          subscriptionComped: false,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
          subscriptionCurrentPeriodEnd: new Date(Date.now() + 30 * 86400000),
        },
      }).catch(() => null);
      if (buyer && session.metadata?.referralCredit === "1") {
        await prisma.user.updateMany({
          where: { id: userId, referralCredits: { gt: 0 } },
          data: { referralCredits: { decrement: 1 } },
        });
      }
      if (buyer?.referredById && !buyer.referralRewarded) {
        await prisma.user.update({ where: { id: buyer.referredById }, data: { referralCredits: { increment: 1 } } });
        await prisma.user.update({ where: { id: buyer.id }, data: { referralRewarded: true } });
      }
    }
  }

  if (event.type === "invoice.paid") {
    const invoice = event.data.object as Stripe.Invoice;
    const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
    if (customerId && (invoice.billing_reason === "subscription_create" || invoice.billing_reason === "subscription_cycle")) {
      const user = await prisma.user.findFirst({ where: { stripeCustomerId: customerId } });
      const settings = await getSettings();
      const amount = invoice.amount_paid || settings.proMonthlyPriceCents;
      await prisma.revenueEvent.create({
        data: {
          type: "SUBSCRIPTION",
          amountCents: amount,
          userId: user?.id,
          description: `Pro membership${user ? ` · ${user.name}` : ""}`,
          externalId: invoice.id,
          mock: false,
        },
      }).catch(() => null);
      if (user) {
        await prisma.user.update({
          where: { id: user.id },
          data: {
            subscriptionTier: "PRO",
            subscriptionStatus: "ACTIVE",
            subscriptionComped: false,
            subscriptionCurrentPeriodEnd: new Date(Date.now() + 30 * 86400000),
          },
        });
      }
    }
  }

  if (event.type === "customer.subscription.deleted" || event.type === "customer.subscription.updated") {
    const subscription = event.data.object as Stripe.Subscription;
    const user = await prisma.user.findFirst({ where: { stripeSubscriptionId: subscription.id } });
    if (user) {
      const active = subscription.status === "active" || subscription.status === "trialing";
      await prisma.user.update({
        where: { id: user.id },
        data: active
          ? { subscriptionTier: "PRO", subscriptionStatus: "ACTIVE" }
          : { subscriptionTier: "FREE", subscriptionStatus: subscription.status === "past_due" ? "PAST_DUE" : "CANCELED" },
      });
    }
  }

  return NextResponse.json({ received: true });
}
