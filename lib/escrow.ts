export type EscrowOpening = {
  closingId: string;
  listingTitle: string;
  salePrice: number;
  buyerTotalCents: number;
  netToSellerCents: number;
  wireInstructions: string;
};

export type EscrowOpenResult = {
  provider: string;
  providerRef: string;
  instructions: string;
};

export type EscrowProvider = {
  id: string;
  open(input: EscrowOpening): Promise<EscrowOpenResult>;
};

const providers = new Map<string, EscrowProvider>();

export function registerEscrowProvider(provider: EscrowProvider) {
  providers.set(provider.id, provider);
}

const manualProvider: EscrowProvider = {
  id: "manual",
  async open(input) {
    const instructions =
      input.wireInstructions.trim() ||
      [
        "Manual escrow. The desk will issue wire instructions.",
        `Reference ${input.closingId}.`,
        `Buyer all-in ${(input.buyerTotalCents / 100).toFixed(2)} USD.`,
        `Estimated net to seller ${(input.netToSellerCents / 100).toFixed(2)} USD.`,
        input.listingTitle,
      ].join("\n");
    return { provider: "manual", providerRef: "", instructions };
  },
};

registerEscrowProvider(manualProvider);

export function getEscrowProvider(id = process.env.ESCROW_PROVIDER || "manual") {
  return providers.get(id) ?? manualProvider;
}
