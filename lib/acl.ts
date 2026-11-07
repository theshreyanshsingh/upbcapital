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

// Files that never go out with the listing's data room. Signed NDAs and the broker's seller authorization stay
// with the seller, the desk, and the signer. A loan's own file (an O&E, a risk search) opens only by that loan's
// rule, through loanFileAccess, so anything that copies or lists the room leaves it out.
export function isPrivateDocument(document: { type: string; storedName: string; noteId?: string | null }, listing: { authorizationKey: string }) {
  return document.type === "NDA" || Boolean(document.noteId) || (listing.authorizationKey !== "" && document.storedName === listing.authorizationKey);
}

// A loan's own file opens with that loan's street and borrower, and to a buyer only when they are Pro or are
// buying that loan. A file whose loan has gone, or sits on another listing, opens to no buyer.
export function loanFileAccess(input: {
  note: { id: string; listingId: string; tradeStatus: string } | null;
  listingId: string;
  listingStatus: string;
  signedNda: boolean;
  wholeParty: boolean;
  loanIds: Iterable<string>;
}) {
  if (!input.note || input.note.listingId !== input.listingId) return { open: false, party: false };
  const loanParty = new Set(input.loanIds).has(input.note.id);
  return {
    open: loanOpenTo({ tradeStatus: input.note.tradeStatus, listingStatus: input.listingStatus, signedNda: input.signedNda, wholeParty: input.wholeParty, loanParty }),
    party: input.wholeParty || loanParty,
  };
}

// The seller of record, the filing broker and the desk run a listing's room: its questions, its approvals, its log.
export function canManageRoom(viewer: { id: string; role: string }, listing: { sellerId: string; brokerId?: string | null }) {
  return viewer.role === "ADMIN" || viewer.id === listing.sellerId || (Boolean(listing.brokerId) && viewer.id === listing.brokerId);
}

// Whether a buyer's NDA opens the room. A seller who approves each bidder holds it PENDING until they decide, and a
// DECLINED one stays shut. A missing status is an NDA from a room that opens on the signature alone, so it opens.
// Every `signedNda` passed to the rules below comes through here.
export function ndaOpensRoom(nda: { accessStatus?: string | null } | null | undefined) {
  if (!nda) return false;
  return nda.accessStatus == null || nda.accessStatus === "APPROVED";
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
  // An NDA that opens the room, from ndaOpensRoom: one still waiting on the seller, or declined, doesn't count.
  signedNda: boolean;
  listingStatus: string;
  closingParty: boolean;
  // Set for a loan's own file, from loanFileAccess. The listing's room doesn't open it.
  loan?: { open: boolean; party: boolean } | null;
}) {
  if (input.owner || input.admin || input.ownNda) return true;
  if (input.loan) return input.loan.open && (input.proBuyer || input.loan.party);
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
