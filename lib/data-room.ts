import { prisma } from "@/lib/prisma";

// What a buyer bought or is buying on this listing, through an open or finished closing: the whole listing,
// or particular loans. The winning bidder and any co-funders count.
export async function dealAccess(listingId: string, userId: string) {
  const closings = await prisma.closing.findMany({
    where: { listingId, status: { in: ["OPEN", "COMPLETE"] } },
    select: { id: true, inquiryId: true, noteId: true },
  });
  const access = { whole: false, loans: new Set<string>() };
  if (!closings.length) return access;
  const inquiryIds = closings.flatMap((closing) => (closing.inquiryId ? [closing.inquiryId] : []));
  const [bought, funded] = await Promise.all([
    inquiryIds.length ? prisma.inquiry.findMany({ where: { id: { in: inquiryIds }, buyerId: userId }, select: { id: true } }) : [],
    prisma.closingFunder.findMany({ where: { closingId: { in: closings.map((closing) => closing.id) }, userId }, select: { closingId: true } }),
  ]);
  const mine = new Set([...bought.map((row) => row.id), ...funded.map((row) => row.closingId)]);
  for (const closing of closings) {
    if (!mine.has(closing.id) && !(closing.inquiryId && mine.has(closing.inquiryId))) continue;
    if (closing.noteId) access.loans.add(closing.noteId);
    else access.whole = true;
  }
  return access;
}

export async function isClosingParty(listingId: string, userId: string) {
  const access = await dealAccess(listingId, userId);
  return access.whole || access.loans.size > 0;
}
