import { canReadClosingFile } from "@/lib/acl";
import { getApiUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildStatementPdf, statementLines, type StatementSide } from "@/lib/settlement";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const closing = await prisma.closing.findUnique({ where: { id }, include: { listing: { include: { seller: true } }, funders: true, brokerFees: true } });
  if (!closing) return new Response("Not found.", { status: 404 });
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, include: { buyer: true } }) : null;
  const funderIds = closing.funders.map((funder) => funder.userId);
  const allowed = canReadClosingFile({ role: user.role, userId: user.id, sellerId: closing.listing.sellerId, buyerId: inquiry?.buyerId ?? null, funderIds });
  if (!allowed) return new Response("Closed.", { status: 403 });
  // Each side sees its own figures. The desk sees both, and what it owes brokers.
  const side: StatementSide = user.role === "ADMIN" ? "desk" : user.id === closing.listing.sellerId ? "seller" : "buyer";
  const brokerCents = closing.brokerFees.reduce((sum, fee) => sum + fee.amountCents, 0);
  const seller = closing.listing.seller.companyName || closing.listing.seller.name;
  const buyer = closing.deskBidId ? "UPB Capital desk" : funderIds.length > 1 ? "A buying group" : inquiry?.buyer.companyName || inquiry?.buyer.name || "Buyer";
  const record = { ...closing, salePrice: Number(closing.salePrice) };
  const pdf = await buildStatementPdf({
    title: closing.listing.title,
    parties: `Seller ${seller}  -  Buyer ${buyer}`,
    closing: record,
    sections: statementLines(record, side, side === "desk" ? brokerCents : 0),
  });
  return new Response(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="settlement-${closing.id}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
