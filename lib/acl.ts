export function canReadProof(viewer: { id: string; role: string }, ownerId: string) {
  return viewer.role === "ADMIN" || viewer.id === ownerId;
}

export function canReadClosingFile(input: { role: string; userId: string; sellerId: string; buyerId: string | null; funderIds?: string[] }) {
  return input.role === "ADMIN" || input.userId === input.sellerId || input.userId === input.buyerId || Boolean(input.funderIds?.includes(input.userId));
}

export function closingAccess(input: {
  role: string;
  accountStatus: string;
  userId: string;
  sellerId: string;
  buyerId: string | null;
  funderIds?: string[];
  brokerId?: string | null;
  buyerReferrerId?: string | null;
}): "party" | "observer" | null {
  if (canReadClosingFile(input)) return "party";
  if (input.role !== "BROKER" || input.accountStatus !== "APPROVED") return null;
  if (input.userId === input.brokerId || input.userId === input.buyerReferrerId) return "observer";
  return null;
}

// Signed NDAs and the broker's seller authorization stay with the seller, the desk, and the signer.
export function isPrivateDocument(document: { type: string; storedName: string }, listing: { authorizationKey: string }) {
  return document.type === "NDA" || (listing.authorizationKey !== "" && document.storedName === listing.authorizationKey);
}

export function canReadDocument(input: {
  owner: boolean;
  admin: boolean;
  ownNda: boolean;
  privateFile: boolean;
  proBuyer: boolean;
  signedNda: boolean;
  listingVisible: boolean;
}) {
  if (input.owner || input.admin || input.ownNda) return true;
  if (input.privateFile) return false;
  return input.proBuyer && input.signedNda && input.listingVisible;
}

export function canReadThreadFile(input: { role: string; userId: string; memberIds: string[] }) {
  return input.role === "ADMIN" || input.memberIds.includes(input.userId);
}

export function shouldApplyReferralCredit(credits: number) {
  return credits > 0;
}
