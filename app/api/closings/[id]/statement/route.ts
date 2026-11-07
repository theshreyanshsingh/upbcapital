import { canReadClosingFile } from "@/lib/acl";
import { getApiUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sellerOnTitle } from "@/lib/seller-identity";
import { buildStatementPdf, statementLines, statementScope, statementSide } from "@/lib/settlement";
import { CUSTODIAN_FUNDS, fundingParty, namesOnTitle } from "@/lib/vesting";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const closing = await prisma.closing.findUnique({
    where: { id },
    include: { listing: { include: { seller: true, notes: true } }, funders: true, brokerFees: true, kickouts: { orderBy: { createdAt: "asc" } } },
  });
  if (!closing) return new Response("Not found.", { status: 404 });
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, include: { buyer: true } }) : null;
  const funderIds = closing.funders.map((funder) => funder.userId);
  const parties = { role: user.role, userId: user.id, sellerId: closing.listing.sellerId, buyerId: inquiry?.buyerId ?? null, funderIds };
  // Each side sees its own figures. The desk sees both, and what it owes brokers. A group seat holder sees their share.
  const side = statementSide(parties);
  if (!canReadClosingFile(parties) || side === "observer") return new Response("Closed.", { status: 403 });
  const mine = side === "buyer" ? closing.funders.find((funder) => funder.userId === user.id) : undefined;
  const share = mine ? { amount: Number(mine.amount), premiumCents: mine.premiumCents, status: mine.status, fundedAt: mine.fundedAt } : null;
  const brokerCents = closing.brokerFees.reduce((sum, fee) => sum + fee.amountCents, 0);
  const [names, funding, seller] = await Promise.all([
    namesOnTitle(closing, inquiry?.buyerId ?? null, closing.funders),
    fundingParty(closing),
    sellerOnTitle(closing.listing.seller),
  ]);
  const buyer = closing.deskBidId ? "UPB Capital desk" : funderIds.length > 1 ? "A buying group" : names.buyer || "Buyer";
  const record = { ...closing, salePrice: Number(closing.salePrice) };
  // The loans the closing covers now, and any the desk took out before settlement.
  const { loans, kickouts } = statementScope(closing, closing.listing.notes);
  const pdf = await buildStatementPdf({
    title: closing.listing.title,
    parties: `Seller ${seller}  -  Buyer ${buyer}  -  ${loans.length} loan${loans.length === 1 ? "" : "s"}`,
    closing: record,
    sections: [
      ...statementLines(record, side, side === "desk" ? brokerCents : 0, share, kickouts),
      // An IRA buyer's money comes from its custodian, so the buyer's and the desk's statements name them with what
      // they wire. The seller's statement carries only the seller's own figures.
      ...(funding && side !== "seller"
        ? [{ heading: "Funding party", lines: [{ label: `Due from ${funding.custodian}, IRA custodian`, cents: closing.buyerTotalCents, detail: CUSTODIAN_FUNDS }] }]
        : []),
    ],
  });
  return new Response(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="settlement-${closing.id}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
