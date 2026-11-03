import { isReleaseBuild } from "@/lib/deploy";

export function stripeConfigured(priceId?: string | null) {
  return Boolean(process.env.STRIPE_SECRET_KEY && (priceId || process.env.STRIPE_PRO_PRICE_ID));
}

// Simulated checkout is only for a demo desk with no Stripe secret. A release never hands out Pro for nothing.
// With a secret and no price yet, Pro waits for the price.
export function simulatedCheckout() {
  return !process.env.STRIPE_SECRET_KEY && !isReleaseBuild(process.env);
}

export const UNPRICED_NOTE = "Checkout opens once the desk saves the Pro price.";
export const CHECKOUT_OFF_NOTE = "Pro checkout isn't open yet. The desk will tell you when it is.";

export function checkoutUnavailableNote() {
  return process.env.STRIPE_SECRET_KEY ? UNPRICED_NOTE : CHECKOUT_OFF_NOTE;
}

export function appOrigin() {
  return process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:4317";
}
