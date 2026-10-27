import { canReadClosingFile } from "@/lib/acl";
import { getCurrentUser } from "@/lib/auth";
import { toCsv } from "@/lib/csv";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getCurrentUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const closing = await prisma.closing.findUnique({
    where: { id },
    include: { listing: { include: { seller: true, notes: true } }, boarding: true },
  });
  if (!closing) return new Response("Not found.", { status: 404 });
  const inquiry = closing.inquiryId
    ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, include: { buyer: true, note: true } })
    : null;
  const funders = await prisma.closingFunder.findMany({ where: { closingId: closing.id }, select: { userId: true } });
  if (!canReadClosingFile({ role: user.role, userId: user.id, sellerId: closing.listing.sellerId, buyerId: inquiry?.buyerId ?? null, funderIds: funders.map((funder) => funder.userId) })) {
    return new Response("Closed.", { status: 403 });
  }
  const note = inquiry?.note || closing.listing.notes[0];
  const rows = [{
    closingId: closing.id,
    listing: closing.listing.title,
    buyer: inquiry?.buyer.name || (closing.deskBidId ? "UPB Capital desk" : ""),
    buyerEmail: inquiry?.buyer.email || "",
    seller: closing.listing.seller.email,
    salePrice: Number(closing.salePrice),
    upb: note ? Number(note.upb) : "",
    rate: note ? Number(note.interestRate) : "",
    city: note?.city || "",
    state: note?.state || "",
    street: note?.streetAddress || "",
    borrower: note?.borrowerName || "",
    servicer: closing.boarding?.servicerName || "",
    servicerEmail: closing.boarding?.contactEmail || "",
    loanNumber: closing.boarding?.loanNumber || "",
    boardedAt: closing.boarding?.boardedAt?.toISOString().slice(0, 10) || "",
    notes: closing.boarding?.notes || "",
  }];
  return new Response(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="boarding-${closing.id.slice(-6)}.csv"`,
    },
  });
}
