import { canReadClosingFile } from "@/lib/acl";
import { getApiUser } from "@/lib/auth";
import { closingLoans } from "@/lib/closing";
import { buildClosingPdf, fillTemplate, type TemplateKey } from "@/lib/closing-docs";
import { money } from "@/lib/format";
import { pricesFor } from "@/lib/loan-prices";
import { prisma } from "@/lib/prisma";
import { isTemplateKey, loadTemplate } from "@/lib/templates";
import { sendForSignature } from "@/lib/vendors";
import { namesOnTitle } from "@/lib/vesting";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
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
  // Every loan the closing covers, not just the first one on the listing.
  const loans = closingLoans(closing, closing.listing.notes);
  const pool = loans.length > 1;
  // A bid priced loan by loan names each loan's price on its own papers, while those prices add up to the sale.
  const loanPrices = pool ? pricesFor(inquiry?.loanPrices, loans.map((note) => note.id), Number(closing.salePrice)) : null;
  const template = await loadTemplate(kind as TemplateKey);
  const price = money(Number(closing.salePrice));
  // The papers name who takes title, the vetted entity, not the person who holds the login.
  const names = await namesOnTitle(closing, inquiry?.buyerId ?? null, funders);
  const shared = {
    seller: closing.listing.seller.companyName || closing.listing.seller.name,
    buyer: funders.length > 1 ? "The buying group" : names.buyer || (closing.deskBidId ? "UPB Capital desk" : "Buyer"),
    title: closing.listing.title,
    price,
    premium: money(closing.buyerPremiumCents / 100),
    allIn: money(closing.buyerTotalCents / 100),
    commission: money(closing.sellerCommissionCents / 100),
    net: money(closing.netToSellerCents / 100),
    date: new Date().toISOString().slice(0, 10),
  };
  const forLoan = (note: (typeof loans)[number] | undefined) => ({
    ...shared,
    city: note?.city || "",
    state: note?.state || "",
    street: note?.streetAddress || "Withheld",
    borrower: note?.borrowerName || "Withheld",
    upb: note ? money(Number(note.upb)) : "",
    // A pool sells for one price. Splitting it across loans is the parties' call, so each page says so, unless the
    // buyer priced each loan.
    price: pool
      ? note && loanPrices ? `${money(loanPrices[note.id])}, part of ${price} for the ${loans.length}-loan pool` : `${price} for the ${loans.length}-loan pool`
      : price,
  });
  const vars = pool
    ? {
        ...shared,
        city: [...new Set(loans.map((note) => note.city))].join(", "),
        state: [...new Set(loans.map((note) => note.state))].join(", "),
        street: "See the loan schedule",
        borrower: "See the loan schedule",
        upb: money(loans.reduce((sum, note) => sum + Number(note.upb), 0)),
        price,
      }
    : forLoan(loans[0]);
  const loanSchedule = pool
    ? `\n\nLoan schedule\n${loans.map((note, index) => `${index + 1}. ${note.streetAddress}, ${note.city}, ${note.state} ${note.zip}. Borrower ${note.borrowerName || "not named"}. Unpaid principal ${money(Number(note.upb))}.${loanPrices ? ` Price ${money(loanPrices[note.id])}.` : ""}`).join("\n")}`
    : "";
  const schedule = funders.length
    ? `\n\nCo-ownership schedule\n${funders.map((funder) => `${names.funder(funder) || funder.user.name}: ${Number(funder.percent).toFixed(2)}% of the price ($${Number(funder.amount).toLocaleString("en-US")}), premium $${(funder.premiumCents / 100).toLocaleString("en-US")}.`).join("\n")}\nThe buyers take title together, each for the percentage above.`
    : "";
  // The agreement is one document with a loan schedule. An assignment and an allonge travel with each loan.
  const perLoan = pool && kind !== "PSA";
  const pdf = await buildClosingPdf({
    title: template.title,
    pages: perLoan
      ? loans.map((note) => `${fillTemplate(template.body, forLoan(note))}${schedule}`)
      : [`${fillTemplate(template.body, vars)}${loanSchedule}${schedule}`],
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
