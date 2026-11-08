import { NextResponse } from "next/server";
import Stripe from "stripe";
import { getApiUser } from "@/lib/auth";
import { appOrigin } from "@/lib/billing";
import { billingBlock } from "@/lib/seats";

export const runtime = "nodejs";

export async function POST() {
  const user = await getApiUser();
  if (!user || user.role !== "BUYER") return NextResponse.redirect(new URL("/login", appOrigin()));
  // The portal changes the firm's card and plan, so it is the owner's or a managing seat's (lib/seats.ts).
  const blocked = billingBlock(user);
  if (blocked) return NextResponse.redirect(new URL(`/buyer/subscription?error=${encodeURIComponent(blocked)}`, appOrigin()));
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
