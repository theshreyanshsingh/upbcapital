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

// Before an award, a buyer who signed the NDA may work the file. Once the listing is in contract or sold, only
// the deal's own buyers may. Reg P limits a bidder's use of borrower data to the sale (12 CFR 1016.11), and a
// losing bidder has no sale left. A canceled closing puts the listing back on the book and reopens the room.
export function dataRoomOpenTo(input: { listingStatus: string; signedNda: boolean; closingParty: boolean }) {
  if (input.listingStatus === "APPROVED") return input.signedNda || input.closingParty;
  if (input.listingStatus === "PENDING" || input.listingStatus === "SOLD") return input.closingParty;
  return false;
}

// One loan's street and borrower. A loan still for sale follows the listing's room. A loan in contract or sold
// is open only to whoever is buying it, even while the rest of the pool is still on the book.
export function loanOpenTo(input: { tradeStatus: string; listingStatus: string; signedNda: boolean; wholeParty: boolean; loanParty: boolean }) {
  const party = dataRoomOpenTo({ listingStatus: input.listingStatus, signedNda: input.signedNda, closingParty: true });
  if (input.wholeParty) return party;
  if (input.tradeStatus !== "AVAILABLE") return input.loanParty && party;
  return dataRoomOpenTo({ listingStatus: input.listingStatus, signedNda: input.signedNda, closingParty: input.loanParty });
}

export function canReadDocument(input: {
  owner: boolean;
  admin: boolean;
  ownNda: boolean;
  privateFile: boolean;
  proBuyer: boolean;
  signedNda: boolean;
  listingStatus: string;
  closingParty: boolean;
}) {
  if (input.owner || input.admin || input.ownNda) return true;
  if (input.privateFile) return false;
  // A buyer on the deal needs the file to close it, Pro or not.
  return (input.proBuyer || input.closingParty) && dataRoomOpenTo(input);
}

export function canReadThreadFile(input: { role: string; userId: string; memberIds: string[] }) {
  return input.role === "ADMIN" || input.memberIds.includes(input.userId);
}

export function shouldApplyReferralCredit(credits: number) {
  return credits > 0;
}
