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
    // Both sides read the same wire text, so it carries no money figures. Each side's own are on the closing page.
    const instructions =
      input.wireInstructions.trim() ||
      [
        "Manual escrow. The desk will issue wire instructions.",
        `Reference ${input.closingId}.`,
        "Your own figures are on the closing page and in your settlement statement.",
        input.listingTitle,
      ].join("\n");
    return { provider: "manual", providerRef: "", instructions };
  },
};

registerEscrowProvider(manualProvider);

export function getEscrowProvider(id = process.env.ESCROW_PROVIDER || "manual") {
  return providers.get(id) ?? manualProvider;
}
