import { appOrigin } from "@/lib/billing";

// Only what these helpers call, so tests can pass a stand-in instead of the real Stripe client.
export type SubscriptionApi = {
  subscriptions: {
    retrieve(id: string): Promise<{ id: string; status: string }>;
    cancel(id: string): Promise<{ id: string; status: string }>;
    list(params: { customer: string; status: "all"; limit: number }): Promise<{ data: { id: string; status: string }[] }>;
  };
};

export type CancelResult = { mode: "skipped" | "unchanged" | "canceled" | "error"; detail: string };

// A subscription in either state never bills again. Anything else can still charge the card.
export function subscriptionEnded(status: string) {
  return status === "canceled" || status === "incomplete_expired";
}

async function stripeClient(secretKey: string) {
  const Stripe = (await import("stripe")).default;
  return new Stripe(secretKey);
}

function missing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "resource_missing");
}

export async function cancelSubscription(stripe: SubscriptionApi, subscriptionId: string): Promise<CancelResult> {
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    if (subscriptionEnded(subscription.status)) return { mode: "unchanged", detail: `Subscription ${subscriptionId} had already ended.` };
    await stripe.subscriptions.cancel(subscriptionId);
    return { mode: "canceled", detail: `Canceled subscription ${subscriptionId} in Stripe.` };
  } catch (error) {
    // A subscription Stripe no longer has can't bill anyone.
    if (missing(error)) return { mode: "unchanged", detail: `Stripe has no subscription ${subscriptionId}.` };
    return { mode: "error", detail: error instanceof Error ? error.message : "Stripe error" };
  }
}

// When the desk sets a membership by hand, a live Stripe subscription would keep billing and its next event
// would undo the change. Without Stripe there is nothing to cancel, and the database is the whole record.
export async function cancelBuyerSubscription(secretKey: string | undefined, subscriptionId: string | null | undefined): Promise<CancelResult> {
  if (!secretKey || !subscriptionId) return { mode: "skipped", detail: "No Stripe subscription to cancel." };
  return cancelSubscription(await stripeClient(secretKey), subscriptionId);
}

// The customer's subscription that can still bill, if any. A second Checkout would start a second one.
export async function liveSubscription(stripe: SubscriptionApi, customerId: string) {
  const list = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 20 });
  return list.data.find((subscription) => !subscriptionEnded(subscription.status)) ?? null;
}

export function portalReturnUrl() {
  return `${appOrigin()}/buyer/subscription`;
}
