import { canReadClosingFile } from "@/lib/acl";
import { CURE_DAYS, FEE_TAIL_MONTHS, REPURCHASE_DAYS, masterLines, masterStatus, masterTermsText } from "@/lib/agreements";
import { closingLoans } from "@/lib/closing";
import { isPaperForm, paperLoans } from "@/lib/enotes";
import { PER_LOAN_TEMPLATES, buildClosingPdf, fillTemplate, formBody, type TemplateKey } from "@/lib/closing-docs";
import { money } from "@/lib/format";
import { pricesFor } from "@/lib/loan-prices";
import { prisma } from "@/lib/prisma";
import { sellerOnTitle } from "@/lib/seller-identity";
import { loadTemplate } from "@/lib/templates";
import { namesOnTitle } from "@/lib/vesting";

type Viewer = { id: string; role: string };

// A closing's form as a PDF, filled from the closing. The packet route serves it, and lib/signatures.ts sends the
// same bytes for signature. Null when the closing doesn't exist; `allowed` false when the viewer may not read it.
export async function closingPacket(closingId: string, kind: TemplateKey, viewer: Viewer) {
  const closing = await prisma.closing.findUnique({
    where: { id: closingId },
    include: { listing: { include: { seller: true, notes: true } } },
  });
  if (!closing) return null;
  const inquiry = closing.inquiryId
    ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, include: { buyer: true, note: true } })
    : null;
  const funders = await prisma.closingFunder.findMany({ where: { closingId: closing.id }, include: { user: true }, orderBy: { percent: "desc" } });
  const allowed = canReadClosingFile({
    role: viewer.role,
    userId: viewer.id,
    sellerId: closing.listing.sellerId,
    buyerId: inquiry?.buyerId ?? null,
    funderIds: funders.map((funder) => funder.userId),
  });
  if (!allowed) return { allowed: false as const, closing, inquiry, funders };
  // Every loan the closing covers, not just the first one on the listing. An eNote has no paper to endorse or lose,
  // so the allonge and the lost note affidavit leave it out, and with only eNotes there is no form to draw.
  const loans = paperLoans(kind, closingLoans(closing, closing.listing.notes));
  if (!loans.length && isPaperForm(kind)) return { allowed: false as const, closing, inquiry, funders, eNote: true as const };
  const pool = loans.length > 1;
  // A bid priced loan by loan names each loan's price on its own papers, while those prices add up to the sale.
  const loanPrices = pool ? pricesFor(inquiry?.loanPrices, loans.map((note) => note.id), Number(closing.salePrice)) : null;
  const template = await loadTemplate(kind);
  const price = money(Number(closing.salePrice));
  // The papers name who takes title, the vetted entity, not the person who holds the login. The seller side names
  // the entity on the seller's approved identity file.
  const [names, seller, signer] = await Promise.all([
    namesOnTitle(closing, inquiry?.buyerId ?? null, funders),
    sellerOnTitle(closing.listing.seller),
    prisma.sellerProfile.findUnique({ where: { userId: closing.listing.sellerId }, select: { signerName: true, signerTitle: true } }),
  ]);
  const buyer = funders.length > 1 ? "The buying group" : names.buyer || (closing.deskBidId ? "UPB Capital desk" : "Buyer");
  // The masters each party accepted. Every seat of a group signs for itself; the desk buying for its own book signs
  // none, so only the seller's counts then.
  const masters = await masterStatus({
    seller: { userId: closing.listing.sellerId, name: seller },
    buyers: funders.length
      ? funders.map((funder) => ({ userId: funder.userId, name: names.funder(funder) || funder.user.name }))
      : inquiry ? [{ userId: inquiry.buyerId, name: buyer }] : [],
    deskPurchase: Boolean(closing.deskBidId),
  });
  const day = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : "");
  const deposit = closing.depositCents != null ? money(closing.depositCents / 100, 2) : "";
  const shared = {
    seller,
    buyer,
    title: closing.listing.title,
    price,
    premium: money(closing.buyerPremiumCents / 100),
    allIn: money(closing.buyerTotalCents / 100),
    commission: money(closing.sellerCommissionCents / 100),
    net: money(closing.netToSellerCents / 100),
    date: new Date().toISOString().slice(0, 10),
    // The articles' periods, the same ones the master agreements give.
    repurchaseDays: String(REPURCHASE_DAYS),
    cureDays: String(CURE_DAYS),
    feeTailMonths: String(FEE_TAIL_MONTHS),
    deposit: deposit || "None",
    depositDue: day(closing.depositDueAt) || "Not set",
    depositTerms: deposit ? `The buyer pays a deposit of ${deposit}${closing.depositDueAt ? ` by ${day(closing.depositDueAt)}` : ""}.` : "This sale carries no deposit.",
    diligenceEnds: day(closing.diligenceEndsAt) || "None",
    diligenceWindow: closing.diligenceEndsAt ? `inside its diligence window, which ends on ${day(closing.diligenceEndsAt)}` : "inside a diligence window, which this sale does not have",
    closingRef: closing.id,
    masterTerms: masterTermsText(masters),
    ...masterLines(masters),
    // Who signs for the seller, from the seller's identity file.
    signer: signer?.signerName.trim() || closing.listing.seller.name,
    signerTitle: signer?.signerTitle.trim() || "authorised signer",
  };
  const forLoan = (note: (typeof loans)[number] | undefined) => ({
    ...shared,
    city: note?.city || "",
    state: note?.state || "",
    street: note?.streetAddress || "Withheld",
    borrower: note?.borrowerName || "Withheld",
    upb: note ? money(Number(note.upb)) : "",
    loanNumber: note?.loanNumber || "Not on the tape",
    noteDate: day(note?.originationDate ?? null) || "Not on the tape",
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
        loanNumber: "See the loan schedule",
        noteDate: "See the loan schedule",
        price,
      }
    : forLoan(loans[0]);
  const loanSchedule = pool
    ? `\n\nLoan schedule\n${loans.map((note, index) => `${index + 1}. ${note.streetAddress}, ${note.city}, ${note.state} ${note.zip}. Borrower ${note.borrowerName || "not named"}. Unpaid principal ${money(Number(note.upb))}.${loanPrices ? ` Price ${money(loanPrices[note.id])}.` : ""}`).join("\n")}`
    : "";
  const schedule = funders.length
    ? `\n\nCo-ownership schedule\n${funders.map((funder) => `${names.funder(funder) || funder.user.name}: ${Number(funder.percent).toFixed(2)}% of the price ($${Number(funder.amount).toLocaleString("en-US")}), premium $${(funder.premiumCents / 100).toLocaleString("en-US")}.`).join("\n")}\nThe buyers take title together, each for the percentage above.`
    : "";
  // The agreements are one document with a loan schedule. An assignment, an allonge and an affidavit travel with
  // each loan.
  const perLoan = pool && PER_LOAN_TEMPLATES.includes(kind);
  const body = formBody(kind, template.body);
  const pdf = await buildClosingPdf({
    title: template.title,
    pages: perLoan
      ? loans.map((note) => `${fillTemplate(body, forLoan(note))}${schedule}`)
      : [`${fillTemplate(body, vars)}${loanSchedule}${schedule}`],
    fields: [
      { name: "buyer", value: vars.buyer },
      { name: "seller", value: vars.seller },
      { name: "price", value: vars.price },
      { name: "date", value: vars.date },
    ],
  });
  return { allowed: true as const, closing, inquiry, funders, template, pdf, names: { buyer: vars.buyer, seller: vars.seller }, masters };
}
