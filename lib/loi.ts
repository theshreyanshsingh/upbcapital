import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { canManageRoom } from "@/lib/acl";
import { deadlinePassed, deskWalled, sealedFromSeller } from "@/lib/auction";
import { audit } from "@/lib/audit";
import { bidderAlias, realName } from "@/lib/bidder-alias";
import { depositTerms } from "@/lib/closing-clock";
import { diligenceDays } from "@/lib/closing-service";
import { acknowledgementLine, bidCovenantStanding, COVENANT_SELECT, listingCovenants } from "@/lib/covenants";
import { allInFor, feePayerOf, feeTerms, premiumOn, type FeeTerms } from "@/lib/fee-schedule";
import { BID_MODES } from "@/lib/filters";
import { money, prettyDate } from "@/lib/format";
import { standingLoanPrices, type LoanPrices } from "@/lib/loan-prices";
import { pdfSafe, wrap } from "@/lib/memo-pdf";
import { bidExpired, buyerPrice } from "@/lib/offers";
import { prisma } from "@/lib/prisma";
import { when } from "@/lib/sale-events";
import { FINAL_LABEL, INDICATIVE_LABEL, INDICATIVE_REFUSED, roundOf, twoRounds } from "@/lib/sale-rounds";
import { getSettings } from "@/lib/settings";
import { bidVesting } from "@/lib/vesting";

// A letter of intent and term sheet for one bid: what an institutional buyer takes to its credit committee, and what a
// bank seller's board expects to read. It restates the bid as UPB holds it (price, all-in, deposit, diligence, round,
// good-until and the conditions) and says plainly that it is a summary, not an offer outside UPB or a contract. It is
// drawn from this bid alone and never carries anything of another bidder's. Counsel: the wording is the desk's draft.

export const LOI_TITLE = "Letter of intent and term sheet";
export const LOI_NON_BINDING =
  "This letter is a non-binding summary of a bid placed on UPB Capital. It is not an offer made outside UPB Capital, and it is not a contract. The bid stands under UPB's bid rules, and a sale binds only under the purchase agreement the buyer and the seller sign after an award.";
export const LOI_DESK_DRAFT =
  "Desk draft for counsel to confirm. Prepared by UPB Capital from the bid record, in UPB's reading. UPB Capital arranges the sale and isn't a party to it, and never holds the loans or the money.";
const FOOTER = "Desk draft for counsel to confirm. A non-binding summary of a bid on UPB Capital, not an offer or a contract.";

export const LOI_SEALED = "This bid's amount is sealed from you until the deadline, so its letter of intent opens then.";
export const LOI_CLOSED = "This bid no longer stands, so it has no letter of intent.";
export const LOI_GROUP = "A group's bid has no letter of intent. Each seat's share is on the group page.";
export const LOI_NO_PRICE = "This bid has no price on it yet.";

// A bid that still stands: open or under review and inside its good-until date, or accepted.
const STANDING = ["OPEN", "REVIEWED", "ACCEPTED"];

export function loiHref(inquiryId: string) {
  return `/api/inquiries/${inquiryId}/loi`;
}

export function loiStands(bid: { type: string; status: string; expiresAt?: Date | null }, now = new Date()) {
  if (bid.type !== "OFFER" || !STANDING.includes(bid.status)) return false;
  return bid.status === "ACCEPTED" || !bidExpired(bid.expiresAt, now);
}

// Of these bids, the ones a letter can be drawn for, for the pages' links. A group's bid is the group's.
export async function loiReady(bids: { id: string; type: string; status: string; expiresAt?: Date | null }[], now = new Date()) {
  const standing = bids.filter((bid) => loiStands(bid, now));
  if (!standing.length) return new Set<string>();
  const groups = await prisma.groupBuy.findMany({ where: { inquiryId: { in: standing.map((bid) => bid.id) } }, select: { inquiryId: true } });
  const grouped = new Set(groups.map((group) => group.inquiryId));
  return new Set(standing.filter((bid) => !grouped.has(bid.id)).map((bid) => bid.id));
}

// ---------------------------------------------------------------------------------------------------------------
// The words

export type LoiSide = "buyer" | "seller" | "desk";
export type LoiSection = { heading: string; lines: string[] };
export type LoiContent = { title: string; subtitle: string; sections: LoiSection[]; footer: string };

export type LoiInput = {
  side: LoiSide;
  bid: { id: string; createdAt: Date; status: string; expiresAt: Date | null; noteId: string | null; allowPartial: boolean | null };
  // The buying entity, or the bidder's letter on a seller's copy before an award.
  buyerName: string;
  aliased: boolean;
  listing: { title: string; kind: string; bidMode: string; bidDeadline: Date | null; roundOneEndsAt: Date | null; twoRounds: boolean };
  loans: { id: string; city: string; state: string; upb: number }[];
  round: 1 | 2 | null;
  price: number;
  terms: FeeTerms;
  loanPrices: LoanPrices | null;
  deposit: { bps: number; days: number };
  diligence: number;
  covenants: { summary: string; acknowledgement: string } | null;
  now: Date;
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function saleTerms(listing: LoiInput["listing"]) {
  if (listing.twoRounds && listing.roundOneEndsAt && listing.bidDeadline) {
    return `a two-round sale, with indicative bids due ${when(listing.roundOneEndsAt)} and final bids from the shortlist due ${when(listing.bidDeadline)}`;
  }
  const mode = (BID_MODES.find((option) => option.value === listing.bidMode)?.label ?? "Open offers").toLowerCase();
  return listing.bidMode !== "NONE" && listing.bidDeadline ? `${mode}, with bids due ${when(listing.bidDeadline)}` : mode;
}

export function loiContent(input: LoiInput): LoiContent {
  const { bid, listing, loans } = input;
  const position = new Map(loans.map((loan, index) => [loan.id, index + 1]));
  const covered = bid.noteId ? loans.filter((loan) => loan.id === bid.noteId) : loans;
  const upb = covered.reduce((sum, loan) => sum + loan.upb, 0);
  const one = bid.noteId ? loans.find((loan) => loan.id === bid.noteId) : null;
  const scope = one
    ? loans.length > 1
      ? `1 loan, loan ${position.get(one.id)} of ${loans.length} on the listing, in ${one.city}, ${one.state}`
      : `1 loan, in ${one.city}, ${one.state}`
    : listing.kind === "POOL"
      ? `${plural(loans.length, "loan")}, the whole listing`
      : `1 loan, in ${loans[0]?.city ?? ""}, ${loans[0]?.state ?? ""}`;
  const indicative = input.round === 1;
  const status = bid.status === "ACCEPTED" ? "Accepted" : bid.status === "REVIEWED" ? "Open, with the desk" : "Open";

  const theBid = [
    `Buyer: ${input.buyerName}${input.aliased ? " (bidders show by letter until an award, as on the listing)" : ""}`,
    `Listing: ${listing.title}`,
    `Loans: ${scope}`,
    `Unpaid principal on the tape: ${money(upb, 2)}`,
    `Placed on UPB Capital: ${prettyDate(bid.createdAt)} · bid reference ${bid.id.slice(-8).toUpperCase()}`,
    `Status on UPB Capital: ${status}`,
    ...(input.round === 1 ? [`Round: ${INDICATIVE_LABEL}. ${INDICATIVE_REFUSED}`] : []),
    ...(input.round === 2 ? [`Round: ${FINAL_LABEL}, from the shortlist. A final bid binds under UPB's bid rules: the deposit, any covenants and verified funds.`] : []),
  ];

  const premium = premiumOn(input.terms, input.price);
  const allIn = allInFor(input.terms, input.price);
  const payer = feePayerOf(input.terms.payer);
  const ofUpb = upb > 0 ? ` (${((input.price / upb) * 100).toFixed(2)}% of UPB)` : "";
  const price = [
    `${indicative ? "Indicative price" : "Price"}: ${money(input.price, 2)}${ofUpb}`,
    premium > 0 ? `Buyer premium: ${money(premium, 2)}` : "Buyer premium: none",
    `All-in: ${money(allIn, 2)}, the price with the buyer premium, as the bid confirmation shows it`,
    payer === "SELLER"
      ? "The seller pays UPB's fees on this listing, so nothing is added to the price."
      : payer === "BUYER"
        ? "The buyer pays UPB's fees on this listing, as one premium on top of the price that covers both sides."
        : "The buyer premium is UPB's fee, paid on top of the price.",
  ];
  if (input.loanPrices) {
    const priced = loans.filter((loan) => input.loanPrices![loan.id] != null);
    price.push(`Loan prices, which add up to the price. ${bid.allowPartial ? "The seller may take part of the pool at these prices." : "Whole pool only."}`);
    for (const loan of priced) price.push(`Loan ${position.get(loan.id)} · ${loan.city}, ${loan.state}: ${money(input.loanPrices[loan.id], 2)}`);
  }

  const deposit = input.deposit.bps > 0
    ? `Deposit: ${input.deposit.bps / 100}% of the price, due within ${plural(input.deposit.days, "day")} of an award. It counts toward the price.`
    : "Deposit: none at award.";
  const diligence = input.diligence > 0
    ? `Diligence window: ${plural(input.diligence, "day")} after an award, in which the buyer can walk away for a finding.`
    : "Diligence window: none after an award, so diligence is done in the data room before bidding.";
  const terms = [
    deposit,
    diligence,
    ...(indicative ? ["The deposit and the diligence window apply to a final bid that is awarded, not to this indicative bid."] : []),
    bid.expiresAt ? `Good until: ${when(bid.expiresAt)}` : "Good until: no end date. The bid stands until it is withdrawn or decided.",
    ...(input.covenants ? [`Covenants: ${input.covenants.summary} ${input.covenants.acknowledgement}`] : []),
  ];

  const conditions = [
    "Subject to the purchase agreement the buyer and the seller sign after an award on UPB Capital.",
    "Subject to the buyer's diligence of the listing's data room.",
    `Subject to the listing's terms on UPB Capital: ${saleTerms(listing)}.`,
  ];

  const what = [LOI_NON_BINDING, "It covers this bid only, and says nothing of any other bid on the listing.", LOI_DESK_DRAFT];

  const reader = input.side === "buyer" ? "the buyer" : input.side === "seller" ? "the seller" : "the desk";
  return {
    title: indicative ? `${LOI_TITLE} · indicative` : LOI_TITLE,
    subtitle: `Prepared ${prettyDate(input.now)} for ${reader}`,
    sections: [
      { heading: "The bid", lines: theBid },
      { heading: "Price", lines: price },
      { heading: "Terms", lines: terms },
      { heading: "Conditions", lines: conditions },
      { heading: "What this letter is", lines: what },
    ],
    footer: FOOTER,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Who may open it

type Viewer = { id: string; role: string; deskRole?: string | null };
type Opened = { ok: true; side: LoiSide; content: LoiContent } | { ok: false; status: 403 | 404 | 409; error: string };

// The bid's buyer, which a firm's seats act as. The seller of record, or a broker of record, and the desk read a bid
// they can already see in full: never while its amount is sealed from them. Anyone else gets a 404, so a bid's
// existence isn't confirmed. Each letter opened is logged against the bid.
export async function openLoi(inquiryId: string, viewer: Viewer, now = new Date()): Promise<Opened> {
  const missing = { ok: false, status: 404, error: "Not found." } as const;
  if (!inquiryId || inquiryId.length > 64) return missing;
  const bid = await prisma.inquiry.findUnique({
    where: { id: inquiryId },
    include: {
      listing: {
        select: {
          id: true, title: true, kind: true, status: true, sellerId: true, brokerId: true, bidMode: true, bidDeadline: true, roundOneEndsAt: true, shortlistedAt: true,
          saleEventId: true, feeBuyerPremiumBps: true, feeSellerCommissionBps: true, feeSchedule: true, feePayer: true,
        },
      },
      messages: { select: { kind: true, amount: true, createdAt: true, authorId: true } },
    },
  });
  if (!bid || bid.type !== "OFFER") return missing;
  const { listing } = bid;
  const side: LoiSide | null = viewer.id === bid.buyerId ? "buyer" : viewer.role === "ADMIN" ? "desk" : canManageRoom(viewer, listing) ? "seller" : null;
  if (!side) return missing;
  const round = roundOf(bid, listing);
  const rounds = twoRounds(listing);
  // A round-one bid's amount shows to the seller once round one closes, as in the round-one book (lib/sale-rounds.ts).
  const roundOneOpen = round === 1 && rounds ? !deadlinePassed(listing.roundOneEndsAt, now) : null;
  const sealed = side === "desk" ? deskWalled(listing, viewer, now) : side === "seller" ? (roundOneOpen ?? sealedFromSeller(listing, now)) : false;
  if (sealed) return { ok: false, status: 403, error: LOI_SEALED };
  if (!loiStands(bid, now)) return { ok: false, status: 409, error: LOI_CLOSED };
  if (await prisma.groupBuy.count({ where: { inquiryId: bid.id } })) return { ok: false, status: 409, error: LOI_GROUP };
  // The buyer's own latest price. Once round one closes, an indicative bid stands at its price then.
  const closedAt = round === 1 && rounds && !roundOneOpen ? listing.roundOneEndsAt : null;
  const messages = closedAt ? bid.messages.filter((message) => message.createdAt.getTime() < closedAt.getTime()) : bid.messages;
  const price = buyerPrice(bid.amount == null ? null : Number(bid.amount), messages.map((message) => ({ ...message, amount: message.amount == null ? null : Number(message.amount) })), bid.buyerId);
  if (price == null || !(price > 0)) return { ok: false, status: 409, error: LOI_NO_PRICE };

  const [settings, notes, awarded] = await Promise.all([
    getSettings(),
    prisma.note.findMany({ where: { listingId: listing.id }, select: { ...COVENANT_SELECT, upb: true }, orderBy: { createdAt: "asc" } }),
    prisma.inquiry.count({ where: { listingId: listing.id, buyerId: bid.buyerId, status: "ACCEPTED" } }),
  ]);
  // The seller and a broker read a bidder by letter until an award, as everywhere else on the listing.
  const aliased = side === "seller" && awarded === 0;
  const buyerName = aliased ? await bidderAlias(listing.id, bid.buyerId) : await buyingEntity(bid);
  const scoped = listingCovenants({ notes }, bid.noteId ? [bid.noteId] : null);
  const standing = scoped.hash ? await bidCovenantStanding(bid, notes) : null;
  const content = loiContent({
    side,
    bid: { id: bid.id, createdAt: bid.createdAt, status: bid.status, expiresAt: bid.expiresAt, noteId: bid.noteId, allowPartial: bid.allowPartial },
    buyerName,
    aliased,
    listing: { title: listing.title, kind: listing.kind, bidMode: listing.bidMode, bidDeadline: listing.bidDeadline, roundOneEndsAt: listing.roundOneEndsAt, twoRounds: rounds },
    loans: notes.map((note) => ({ id: note.id, city: note.city, state: note.state, upb: Number(note.upb) })),
    round: round === 1 || round === 2 ? round : null,
    price,
    terms: feeTerms(listing, settings),
    loanPrices: !bid.noteId && listing.kind === "POOL" ? standingLoanPrices(bid.loanPrices, price) : null,
    deposit: depositTerms(settings),
    diligence: diligenceDays(settings.diligenceDays),
    covenants: scoped.summary ? { summary: scoped.summary, acknowledgement: acknowledgementLine({ deskPurchase: false, standing }) } : null,
    now,
  });
  await audit(viewer.id, "LOI_DOWNLOAD", "inquiry", bid.id, `${side === "buyer" ? "Buyer" : side === "seller" ? "Seller" : "Desk"} downloaded the letter of intent for a bid on ${listing.title}`);
  return { ok: true, side, content };
}

// The bid's buying entity, else the main file's entity name, else the account's own name.
async function buyingEntity(bid: { buyerId: string; buyerEntityId?: string | null }) {
  const vesting = await bidVesting(bid);
  if (vesting.name) return vesting.name;
  const buyer = await prisma.user.findUnique({ where: { id: bid.buyerId }, select: { name: true, companyName: true } });
  return buyer ? realName(buyer) : "The buyer";
}

// ---------------------------------------------------------------------------------------------------------------
// The PDF, in the lender pack's style

const PAGE: [number, number] = [612, 792];
const MARGIN = 48;
const WIDTH = 516;
const BOTTOM = 64;

export async function buildLoiPdf(content: LoiContent) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(content.title);
  pdf.setProducer("UPB Capital");
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const gold = rgb(0.776, 0.643, 0.431);
  const ink = rgb(0.12, 0.11, 0.09);
  const soft = rgb(0.4, 0.38, 0.34);
  // A long unbroken string, such as a pasted link in a title, would run off the page.
  const safe = (text: string, face: PDFFont) => pdfSafe(text, face).replace(/\S{70,}/g, (word) => word.replace(/(\S{60})/g, "$1 "));

  let page: PDFPage = pdf.addPage(PAGE);
  page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: rgb(0.03, 0.03, 0.04) });
  page.drawText("UPB CAPITAL  ·  LETTER OF INTENT  ·  DESK DRAFT", { x: MARGIN, y: 762, size: 11, font, color: gold });
  let y = 704;
  for (const line of wrap(safe(content.title, font), font, 20, WIDTH).slice(0, 2)) {
    page.drawText(line, { x: MARGIN, y, size: 20, font, color: ink });
    y -= 24;
  }
  page.drawText(safe(content.subtitle, italic), { x: MARGIN, y: y - 2, size: 12, font: italic, color: soft });
  y -= 34;

  const turn = () => {
    page = pdf.addPage(PAGE);
    page.drawText(safe(`UPB Capital  ·  ${content.title}`, font), { x: MARGIN, y: 760, size: 9, font, color: soft });
    y = 732;
  };
  for (const section of content.sections) {
    // A heading never sits alone at the foot of a page.
    if (y < BOTTOM + 60) turn();
    page.drawText(section.heading, { x: MARGIN, y, size: 13, font, color: gold });
    y -= 20;
    for (const text of section.lines) {
      for (const row of wrap(safe(text, font), font, 10.5, WIDTH)) {
        if (y < BOTTOM) turn();
        page.drawText(row, { x: MARGIN, y, size: 10.5, font, color: ink });
        y -= 15;
      }
      y -= 3;
    }
    y -= 10;
  }
  const footer = wrap(safe(content.footer, font), font, 8, WIDTH - 60);
  const pages = pdf.getPages();
  pages.forEach((sheet, index) => {
    footer.slice(0, 2).forEach((line, row) => sheet.drawText(line, { x: MARGIN, y: 36 - row * 10, size: 8, font, color: soft }));
    sheet.drawText(`${index + 1} of ${pages.length}`, { x: 612 - MARGIN - 30, y: 36, size: 8, font, color: soft });
  });
  return Buffer.from(await pdf.save());
}
