import { canReadClosingFile } from "@/lib/acl";
import { getCurrentUser } from "@/lib/auth";
import { buildClosingPdf, fillTemplate, type TemplateKey } from "@/lib/closing-docs";
import { money } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { isTemplateKey, loadTemplate } from "@/lib/templates";
import { sendForSignature } from "@/lib/vendors";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getCurrentUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const kind = new URL(request.url).searchParams.get("kind") || "PSA";
  if (!isTemplateKey(kind)) return new Response("Unknown form.", { status: 400 });
  const closing = await prisma.closing.findUnique({
    where: { id },
    include: { listing: { include: { seller: true, notes: true } } },
  });
  if (!closing) return new Response("Not found.", { status: 404 });
  const inquiry = closing.inquiryId
    ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, include: { buyer: true, note: true } })
    : null;
  const funders = await prisma.closingFunder.findMany({ where: { closingId: closing.id }, include: { user: true }, orderBy: { percent: "desc" } });
  const allowed = canReadClosingFile({
    role: user.role,
    userId: user.id,
    sellerId: closing.listing.sellerId,
    buyerId: inquiry?.buyerId ?? null,
    funderIds: funders.map((funder) => funder.userId),
  });
  if (!allowed) return new Response("Closed.", { status: 403 });
  const note = inquiry?.note || closing.listing.notes[0];
  const template = await loadTemplate(kind as TemplateKey);
  const vars = {
    seller: closing.listing.seller.companyName || closing.listing.seller.name,
    buyer: funders.length > 1 ? "The buying group" : inquiry?.buyer.name || (closing.deskBidId ? "UPB Capital desk" : "Buyer"),
    title: closing.listing.title,
    city: note?.city || "",
    state: note?.state || "",
    street: note?.streetAddress || "Withheld",
    borrower: note?.borrowerName || "Withheld",
    upb: note ? money(Number(note.upb)) : "",
    price: money(Number(closing.salePrice)),
    premium: money(closing.buyerPremiumCents / 100),
    allIn: money(closing.buyerTotalCents / 100),
    commission: money(closing.sellerCommissionCents / 100),
    net: money(closing.netToSellerCents / 100),
    date: new Date().toISOString().slice(0, 10),
  };
  const schedule = funders.length
    ? `\n\nCo-ownership schedule\n${funders.map((funder) => `${funder.user.name}: ${Number(funder.percent).toFixed(2)}% of the price ($${Number(funder.amount).toLocaleString("en-US")}), premium $${(funder.premiumCents / 100).toLocaleString("en-US")}.`).join("\n")}\nThe buyers take title together, each for the percentage above.`
    : "";
  const body = `${fillTemplate(template.body, vars)}${schedule}`;
  const pdf = await buildClosingPdf({
    title: template.title,
    body,
    fields: [
      { name: "buyer", value: vars.buyer },
      { name: "seller", value: vars.seller },
      { name: "price", value: vars.price },
      { name: "date", value: vars.date },
    ],
  });
  if (new URL(request.url).searchParams.get("send") === "1" && kind === "PSA" && inquiry) {
    await sendForSignature({
      title: template.title,
      signerName: inquiry.buyer.name,
      signerEmail: inquiry.buyer.email,
      pdf,
      kind: "psa",
    });
  }
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${kind.toLowerCase()}.pdf"`,
    },
  });
}
