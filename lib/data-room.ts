import { prisma } from "@/lib/prisma";

// A buyer on an open or finished closing for this listing: the winning bidder or a co-funder.
export async function isClosingParty(listingId: string, userId: string) {
  const closings = await prisma.closing.findMany({ where: { listingId, status: { in: ["OPEN", "COMPLETE"] } }, select: { id: true, inquiryId: true } });
  if (!closings.length) return false;
  const inquiryIds = closings.flatMap((closing) => (closing.inquiryId ? [closing.inquiryId] : []));
  const [bought, funded] = await Promise.all([
    inquiryIds.length ? prisma.inquiry.count({ where: { id: { in: inquiryIds }, buyerId: userId } }) : 0,
    prisma.closingFunder.count({ where: { closingId: { in: closings.map((closing) => closing.id) }, userId } }),
  ]);
  return bought + funded > 0;
}
