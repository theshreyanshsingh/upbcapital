export function stripeConfigured(priceId?: string | null) {
  return Boolean(process.env.STRIPE_SECRET_KEY && (priceId || process.env.STRIPE_PRO_PRICE_ID));
}

// Simulated checkout is only for a desk with no Stripe secret. With a secret and no price yet, Pro waits for the price.
export function simulatedCheckout() {
  return !process.env.STRIPE_SECRET_KEY;
}

export const UNPRICED_NOTE = "Checkout opens once the desk saves the Pro price.";

export function appOrigin() {
  return process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:4317";
}
