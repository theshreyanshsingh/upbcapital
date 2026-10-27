export type StoredPrice = {
  unitAmount: number | null;
  currency: string;
  active: boolean;
  interval: string | null;
};

export function priceNeedsReplace(existing: StoredPrice | null, cents: number) {
  if (!existing) return true;
  return !(existing.unitAmount === cents && existing.currency === "usd" && existing.active && existing.interval === "month");
}

export type StripeSyncResult = {
  mode: "skipped" | "unchanged" | "created" | "error";
  productId: string;
  priceId: string;
  detail: string;
};

export async function syncProPrice(input: {
  secretKey: string | undefined;
  cents: number;
  productId: string;
  priceId: string;
}): Promise<StripeSyncResult> {
  if (!input.secretKey) {
    return { mode: "skipped", productId: input.productId, priceId: input.priceId, detail: "Stripe secret is not set." };
  }
  if (input.cents < 50) {
    return { mode: "skipped", productId: input.productId, priceId: input.priceId, detail: "Stripe recurring prices start at $0.50." };
  }
  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(input.secretKey);
    let productId = input.productId;
    if (productId) {
      const product = await stripe.products.retrieve(productId);
      if (product.deleted) productId = "";
    }
    if (!productId) {
      const product = await stripe.products.create({ name: "UPB Capital Pro", metadata: { desk: "upb-capital" } });
      productId = product.id;
    }
    if (input.priceId) {
      const price = await stripe.prices.retrieve(input.priceId);
      const stored: StoredPrice = {
        unitAmount: price.unit_amount,
        currency: price.currency,
        active: price.active,
        interval: price.recurring?.interval ?? null,
      };
      if (!priceNeedsReplace(stored, input.cents)) {
        return { mode: "unchanged", productId, priceId: price.id, detail: "Stripe price already matches." };
      }
      if (price.active) await stripe.prices.update(price.id, { active: false });
    }
    const created = await stripe.prices.create({
      product: productId,
      unit_amount: input.cents,
      currency: "usd",
      recurring: { interval: "month" },
      nickname: `UPB Pro $${(input.cents / 100).toFixed(2)}`,
    });
    return { mode: "created", productId, priceId: created.id, detail: created.id };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Stripe error";
    return { mode: "error", productId: input.productId, priceId: input.priceId, detail };
  }
}
