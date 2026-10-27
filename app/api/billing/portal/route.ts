import { NextResponse } from "next/server";
import Stripe from "stripe";
import { getCurrentUser } from "@/lib/auth";
import { appOrigin } from "@/lib/billing";

export const runtime = "nodejs";

export async function POST() {
  const user = await getCurrentUser();
  if (!user || user.role !== "BUYER") return NextResponse.redirect(new URL("/login", appOrigin()));
  if (!process.env.STRIPE_SECRET_KEY || !user.stripeCustomerId) {
    return NextResponse.redirect(new URL("/buyer/subscription?error=The%20Stripe%20customer%20portal%20opens%20after%20a%20Stripe%20checkout.", appOrigin()));
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${appOrigin()}/buyer/subscription`,
  });
  return NextResponse.redirect(session.url);
}
