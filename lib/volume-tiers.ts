import { buyerCut, feeTerms, premiumCutOf, type BuyerCut, type FeeSettings, type ListingFees, type PremiumCut } from "@/lib/fee-schedule";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

// The buyer's cut to the premium, read from the database. lib/fee-schedule.ts holds the rules and the arithmetic;
// this module counts a firm's purchases and finds the cut when a closing opens.
//
// Fees are fixed twice. A listing's terms, volume tiers and forward-flow cut included, are kept on it at go-live.
// The buyer isn't known until the award, so the cut that buyer earns is worked out when its closing opens and goes
// into the premium the closing charges. A closing keeps the fees it opened with: a later purchase, or one that falls
// out of the 12 months, never moves a closing already open.

export const VOLUME_WINDOW_MONTHS = 12;

export function volumeWindowStart(now = new Date()) {
  const since = new Date(now);
  since.setMonth(since.getMonth() - VOLUME_WINDOW_MONTHS);
  return since;
}

// The firm's closed purchases on UPB over the 12 months to now, in cents: closings it won as the buyer, by the firm's
// own account or any of its seats, and its funded shares of group closings. A group closing counts each seat holder's
// share for that holder, not its whole price for the group's opener. The desk's own purchases are not a buyer's.
export async function trailingVolumeCents(buyerId: string, now = new Date()) {
  const buyer = await prisma.user.findUnique({ where: { id: buyerId }, select: { id: true, principalId: true } });
  if (!buyer) return 0;
  const firmId = buyer.principalId ?? buyer.id;
  const seats = await prisma.user.findMany({ where: { principalId: firmId }, select: { id: true } });
  const members = [firmId, ...seats.map((seat) => seat.id)];
  const window = { gte: volumeWindowStart(now), lte: now };
  const won = await prisma.inquiry.findMany({ where: { buyerId: { in: members }, type: "OFFER", status: "ACCEPTED" }, select: { id: true } });
  const [own, shares] = await Promise.all([
    won.length
      ? prisma.closing.findMany({
          where: { inquiryId: { in: won.map((row) => row.id) }, status: "COMPLETE", closedAt: window },
          select: { salePrice: true, funders: { select: { id: true } } },
        })
      : Promise.resolve([]),
    prisma.closingFunder.findMany({
      where: { userId: { in: members }, status: "FUNDED", closing: { status: "COMPLETE", closedAt: window } },
      select: { amount: true },
    }),
  ]);
  const sole = own.filter((closing) => closing.funders.length === 0).reduce((sum, closing) => sum + Math.round(Number(closing.salePrice) * 100), 0);
  return sole + shares.reduce((sum, share) => sum + Math.round(Number(share.amount) * 100), 0);
}

type CutListing = ListingFees & { flowProgramId?: string | null };

// The cut for the buyer of this bid, worked out as its closing opens. A group's bid has many buyers, so no one firm's
// volume sets its premium; a forward-flow tranche's cut still applies to it. Null when there is no cut.
export async function premiumCutAtAward(input: { listing: CutListing | null | undefined; inquiryId: string; settings: FeeSettings; now?: Date }): Promise<BuyerCut | null> {
  const terms = feeTerms(input.listing, input.settings);
  const flowTranche = Boolean(input.listing?.flowProgramId);
  if (!terms.schedule) return null;
  if (!(terms.schedule.volumeTiers?.length) && !(flowTranche && terms.schedule.flowPremiumOffBps)) return null;
  const [bid, group] = await Promise.all([
    prisma.inquiry.findUnique({ where: { id: input.inquiryId }, select: { buyerId: true } }),
    prisma.groupBuy.findFirst({ where: { inquiryId: input.inquiryId }, select: { id: true } }),
  ]);
  if (!bid) return null;
  const volumeCents = group || !terms.schedule.volumeTiers?.length ? null : await trailingVolumeCents(bid.buyerId, input.now);
  return buyerCut(terms, { volumeCents, flowTranche });
}

// The audit line for a cut fixed at award. Volumes and rates only, never a bid amount.
export function cutAuditLine(cut: BuyerCut) {
  const parts = [
    cut.volumeBps > 0 && cut.tier ? `volume tier from $${Math.round(cut.tier.minCents / 100).toLocaleString("en-US")}: ${(cut.volumeBps / 100).toFixed(2)}% off on $${Math.round((cut.volumeCents ?? 0) / 100).toLocaleString("en-US")} closed in 12 months` : "",
    cut.flowBps > 0 ? `forward-flow tranche: ${(cut.flowBps / 100).toFixed(2)}% off` : "",
  ].filter(Boolean);
  return `Buyer premium cut ${(cut.offBps / 100).toFixed(2)}% · ${parts.join(" · ")}`;
}

// The cut an open or closed closing carries, for its statement and invoices. Null for a closing without one.
export async function closingPremiumCut(closing: { listingId: string; salePrice: number; buyerPremiumCents: number; deskBidId?: string | null }): Promise<PremiumCut | null> {
  if (closing.deskBidId) return null;
  const [listing, settings] = await Promise.all([
    prisma.listing.findUnique({ where: { id: closing.listingId }, select: { feeBuyerPremiumBps: true, feeSellerCommissionBps: true, feeSchedule: true, feePayer: true, flowProgramId: true } }),
    getSettings(),
  ]);
  if (!listing) return null;
  return premiumCutOf(feeTerms(listing, settings), { salePrice: Number(closing.salePrice), buyerPremiumCents: closing.buyerPremiumCents, deskBidId: closing.deskBidId }, Boolean(listing.flowProgramId));
}
