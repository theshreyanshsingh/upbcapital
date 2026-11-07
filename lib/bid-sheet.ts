import { deskCan, type Staff } from "@/lib/desk-roles";
import { allInFor, feeTerms, flatTerms, type FeeTerms } from "@/lib/fee-schedule";
import { ofacBlocks } from "@/lib/ofac";
import { buyerPrice } from "@/lib/offers";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

const DAY = 24 * 60 * 60 * 1000;

export type Funds = "covered" | "short" | "expired" | "unstated";

// Compares what the buyer would wire, premium included, with the proof the desk verified.
export function fundsCoverage(allIn: number, proof: { amount: number | null; expiresAt: Date | null; verifiedAt: Date | null }, now = new Date()): Funds {
  if (proof.amount == null || proof.amount <= 0) return "unstated";
  if (proof.expiresAt && proof.expiresAt.getTime() < now.getTime()) return "expired";
  return allIn <= proof.amount ? "covered" : "short";
}

export type BidInput = {
  inquiryId: string;
  buyerId: string;
  buyerName: string;
  status: string;
  amount: number;
  createdAt: Date;
  noteLabel: string | null;
  ask: number;
  upb: number;
  fileStatus: string;
  proof: { amount: number | null; expiresAt: Date | null; verifiedAt: Date | null };
  record: { closed: number; canceled: number };
  ofacHold: boolean;
};

export type BidRow = BidInput & {
  rank: number;
  allIn: number;
  ofAsk: number | null;
  ofUpb: number | null;
  funds: Funds;
  flags: string[];
  strength: "strong" | "watch" | "weak";
};

// Highest price first, then the bid most likely to close. Flags say why a lower bid may still be the better award.
// fees is the listing's terms, or a flat premium in basis points.
export function rankBids(bids: BidInput[], fees: number | FeeTerms, now = new Date()): BidRow[] {
  const terms = typeof fees === "number" ? flatTerms(fees) : fees;
  const rows = bids.map((bid) => {
    const allIn = allInFor(terms, bid.amount);
    const funds = fundsCoverage(allIn, bid.proof, now);
    const flags: string[] = [];
    if (bid.ofacHold) flags.push("OFAC review open");
    if (bid.fileStatus !== "APPROVED") flags.push("Buyer file not approved");
    if (funds === "short") flags.push("All-in is above verified funds");
    if (funds === "expired") flags.push("Proof of funds has expired");
    if (funds === "unstated") flags.push("No verified funds amount");
    if (bid.record.canceled > 0) flags.push(`${bid.record.canceled} canceled closing${bid.record.canceled === 1 ? "" : "s"}`);
    const blocking = bid.ofacHold || bid.fileStatus !== "APPROVED" || funds === "short" || funds === "expired";
    const strength: BidRow["strength"] = blocking ? "weak" : funds === "covered" && bid.record.canceled === 0 ? "strong" : "watch";
    return {
      ...bid,
      rank: 0,
      allIn,
      ofAsk: bid.ask > 0 ? (bid.amount / bid.ask) * 100 : null,
      ofUpb: bid.upb > 0 ? (bid.amount / bid.upb) * 100 : null,
      funds,
      flags,
      strength,
    };
  });
  const order = { strong: 0, watch: 1, weak: 2 };
  rows.sort((a, b) => b.amount - a.amount || order[a.strength] - order[b.strength] || a.createdAt.getTime() - b.createdAt.getTime());
  rows.forEach((row, index) => (row.rank = index + 1));
  return rows;
}

// Closings a buyer won, split by how they ended. Open files are not counted either way.
export async function buyerRecords(buyerIds: string[]) {
  const records = new Map<string, { closed: number; canceled: number }>(buyerIds.map((id) => [id, { closed: 0, canceled: 0 }]));
  if (!buyerIds.length) return records;
  const won = await prisma.inquiry.findMany({ where: { buyerId: { in: buyerIds }, type: "OFFER" }, select: { id: true, buyerId: true } });
  const owner = new Map(won.map((inquiry) => [inquiry.id, inquiry.buyerId]));
  const closings = await prisma.closing.findMany({
    where: { inquiryId: { in: [...owner.keys()] }, status: { in: ["COMPLETE", "CANCELED"] } },
    select: { inquiryId: true, status: true },
  });
  for (const closing of closings) {
    const record = records.get(owner.get(closing.inquiryId ?? "") ?? "");
    if (!record) continue;
    if (closing.status === "COMPLETE") record.closed += 1;
    else record.canceled += 1;
  }
  return records;
}

export async function bidSheet(listingId: string, premiumBps: number, now = new Date()) {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    include: {
      notes: { select: { id: true, city: true, state: true, upb: true, askingPrice: true } },
      inquiries: {
        where: { type: "OFFER", status: { in: ["OPEN", "REVIEWED", "ACCEPTED"] } },
        include: { buyer: { include: { buyerProfile: true } }, messages: true },
      },
    },
  });
  if (!listing) return [];
  const buyerIds = [...new Set(listing.inquiries.map((inquiry) => inquiry.buyerId))];
  const [records, checks] = await Promise.all([
    buyerRecords(buyerIds),
    buyerIds.length ? prisma.ofacCheck.findMany({ where: { result: "REVIEW", userId: { in: buyerIds } } }) : Promise.resolve([]),
  ]);
  const held = new Set(checks.filter(ofacBlocks).map((check) => check.userId));
  const notes = listing.notes;
  const total = (pick: (note: (typeof notes)[number]) => number) => notes.reduce((sum, note) => sum + pick(note), 0);
  const bids: BidInput[] = [];
  for (const inquiry of listing.inquiries) {
    // Ranked on what each buyer has agreed to pay, not on a desk counter they haven't answered.
    const amount = buyerPrice(
      inquiry.amount != null ? Number(inquiry.amount) : null,
      inquiry.messages.map((message) => ({ kind: message.kind, amount: message.amount != null ? Number(message.amount) : null, createdAt: message.createdAt, authorId: message.authorId })),
      inquiry.buyerId,
    );
    if (!amount || amount <= 0) continue;
    const note = inquiry.noteId ? notes.find((item) => item.id === inquiry.noteId) : null;
    const profile = inquiry.buyer.buyerProfile;
    bids.push({
      inquiryId: inquiry.id,
      buyerId: inquiry.buyerId,
      buyerName: profile?.entityName || inquiry.buyer.companyName || inquiry.buyer.name,
      status: inquiry.status,
      amount,
      createdAt: inquiry.createdAt,
      noteLabel: note ? `${note.city}, ${note.state}` : null,
      ask: note ? Number(note.askingPrice) : total((item) => Number(item.askingPrice)),
      upb: note ? Number(note.upb) : total((item) => Number(item.upb)),
      fileStatus: profile?.status ?? "NOT_STARTED",
      proof: { amount: profile?.proofAmount ?? null, expiresAt: profile?.proofExpiresAt ?? null, verifiedAt: profile?.proofVerifiedAt ?? null },
      record: records.get(inquiry.buyerId) ?? { closed: 0, canceled: 0 },
      ofacHold: held.has(inquiry.buyerId),
    });
  }
  // The premium the listing went live with, which the closing will charge. premiumBps covers older listings.
  return rankBids(bids, feeTerms(listing, { ...(await getSettings()), buyerPremiumBps: premiumBps }), now);
}

// The ranked sheet is behind the desk's wall: only staff whose role reads sealed bids see it, whatever the round.
// Anyone else gets null, and the page says why.
export async function bidSheetFor(viewer: Staff, listingId: string, premiumBps: number, now = new Date()) {
  if (!deskCan(viewer, "sealedBids")) return null;
  return bidSheet(listingId, premiumBps, now);
}

export function proofExpiry(raw: string, approvedAt: Date) {
  if (raw) {
    const date = new Date(`${raw}T23:59:59Z`);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date(approvedAt.getTime() + 90 * DAY);
}
