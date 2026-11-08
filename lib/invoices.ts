import { Prisma, type Invoice } from "@prisma/client";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { audit } from "@/lib/audit";
import { winAnsi } from "@/lib/closing-docs";
import { DESK_DENIED, deskCan, type Staff } from "@/lib/desk-roles";
import { feePayerOf } from "@/lib/fee-schedule";
import { notify } from "@/lib/email";
import { money } from "@/lib/format";
import { postRevenueOnce } from "@/lib/ledger";
import { prisma } from "@/lib/prisma";

// Numbered fee invoices and credit notes. When a closing completes the buyer gets a PREMIUM invoice and the seller a
// COMMISSION invoice, for the cents the closing actually charged, once each. A canceled or refunded fee gets a
// CREDIT_NOTE against its invoice, and the ledger takes the same amount back. Both kinds share one sequence of
// numbers per year, UPB-2026-000123, drawn from Counter with an atomic increment, so no number ever repeats; a number
// lost to a race leaves a gap, never a repeat.

export const INVOICE_KINDS = ["PREMIUM", "COMMISSION", "CREDIT_NOTE"] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

export const INVOICE_KIND_LABELS: Record<string, string> = {
  PREMIUM: "Buyer premium",
  COMMISSION: "Seller commission",
  CREDIT_NOTE: "Credit note",
};

// A numbering series: the Counter it draws from and the prefix it prints. Tests pass their own.
export type InvoiceSeries = { counter: string; prefix: string };
export const INVOICE_SERIES: InvoiceSeries = { counter: "invoice", prefix: "UPB" };

export function invoiceNumber(series: InvoiceSeries, year: number, value: number) {
  return `${series.prefix}-${year}-${String(value).padStart(6, "0")}`;
}

function intOf(value: unknown): number {
  if (value && typeof value === "object") {
    const wrapped = value as { $numberInt?: string; $numberLong?: string; $numberDouble?: string };
    return Number(wrapped.$numberInt ?? wrapped.$numberLong ?? wrapped.$numberDouble);
  }
  return Number(value);
}

// The next number in the series for the year. findAndModify increments and returns in one step on the server, so
// two awards at the same moment can never read the same value. The first number of a year creates its counter; two
// creating it at once can meet on the key, and the loser simply asks again.
export async function nextInvoiceNumber(series: InvoiceSeries = INVOICE_SERIES, now = new Date()) {
  const year = now.getUTCFullYear();
  const id = `${series.counter}:${year}`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = (await prisma.$runCommandRaw({
        findAndModify: "Counter",
        query: { _id: id },
        update: { $inc: { value: 1 } },
        new: true,
        upsert: true,
      })) as { value?: { value?: unknown } | null };
      const value = intOf(result.value?.value);
      if (!Number.isInteger(value) || value < 1) throw new Error(`Counter ${id} returned no value.`);
      return invoiceNumber(series, year, value);
    } catch (error) {
      const duplicate = error instanceof Error && /E11000|duplicate key/i.test(error.message);
      if (!duplicate || attempt >= 3) throw error;
    }
  }
}

function duplicateKey(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

// One invoice per closing, kind and party. Its id is fixed by those, and MongoDB's _id is unique, so a second issue
// finds the first or loses the race to it.
export function invoiceId(closingId: string, kind: "PREMIUM" | "COMMISSION", userId: string) {
  return `inv-${closingId}-${kind.toLowerCase()}-${userId}`;
}

type IssueInput = { id: string; kind: InvoiceKind; closingId: string | null; userId: string; amountCents: number; description: string; creditOfId?: string | null };

async function issueOnce(input: IssueInput, series: InvoiceSeries, now: Date) {
  const existing = await prisma.invoice.findUnique({ where: { id: input.id } });
  if (existing) return { invoice: existing, issued: false };
  const number = await nextInvoiceNumber(series, now);
  try {
    const invoice = await prisma.invoice.create({ data: { ...input, number, issuedAt: now } });
    return { invoice, issued: true };
  } catch (error) {
    if (!duplicateKey(error)) throw error;
    const winner = await prisma.invoice.findUnique({ where: { id: input.id } });
    if (!winner) throw error;
    return { invoice: winner, issued: false };
  }
}

// A one-off invoice outside a closing, numbered from the series. The numbering test uses it; nothing else does yet.
export async function issueInvoice(input: Omit<IssueInput, "id">, options: { series?: InvoiceSeries; now?: Date } = {}) {
  const now = options.now ?? new Date();
  const number = await nextInvoiceNumber(options.series ?? INVOICE_SERIES, now);
  return prisma.invoice.create({ data: { ...input, number, issuedAt: now } });
}

// The parties a completed closing bills and what each was charged. A group's seats each pay their share of the
// premium. The desk buying for its own book pays no premium to itself. A zero fee gets no invoice.
export function closingCharges(closing: {
  deskBidId: string | null;
  buyerPremiumCents: number;
  sellerCommissionCents: number;
  sellerId: string;
  buyerId: string | null;
  funders: { userId: string; premiumCents: number }[];
}) {
  const charges: { kind: "PREMIUM" | "COMMISSION"; userId: string; amountCents: number }[] = [];
  if (!closing.deskBidId && closing.buyerPremiumCents > 0) {
    if (closing.funders.length) {
      for (const funder of closing.funders) if (funder.premiumCents > 0) charges.push({ kind: "PREMIUM", userId: funder.userId, amountCents: funder.premiumCents });
    } else if (closing.buyerId) {
      charges.push({ kind: "PREMIUM", userId: closing.buyerId, amountCents: closing.buyerPremiumCents });
    }
  }
  if (closing.sellerCommissionCents > 0) charges.push({ kind: "COMMISSION", userId: closing.sellerId, amountCents: closing.sellerCommissionCents });
  return charges;
}

// What an invoice says it is for, and who pays it under the listing's fee payer (lib/fee-schedule.ts). When one
// side pays both fees, its one invoice covers the premium and the commission together, and the other side gets none.
export function invoiceDescription(kind: "PREMIUM" | "COMMISSION", feePayer: unknown, title: string) {
  const payer = feePayerOf(feePayer);
  const side = kind === "PREMIUM" ? "buyer" : "seller";
  if (payer !== "SPLIT" && payer.toLowerCase() === side) return `Buyer premium and seller commission on ${title}, paid by the ${side} under this listing's terms`;
  return `${INVOICE_KIND_LABELS[kind]} on ${title}, paid by the ${side}`;
}

// Issued when a closing completes, from lib/closing-service.ts finalizeClosing. A repeat call finds them issued.
export async function issueClosingInvoices(closingId: string, options: { series?: InvoiceSeries; now?: Date } = {}) {
  const closing = await prisma.closing.findUnique({ where: { id: closingId }, include: { listing: { select: { title: true, sellerId: true, feePayer: true } }, funders: { select: { userId: true, premiumCents: true } } } });
  if (!closing || closing.status !== "COMPLETE") return [];
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, select: { buyerId: true } }) : null;
  const charges = closingCharges({ ...closing, sellerId: closing.listing.sellerId, buyerId: inquiry?.buyerId ?? null });
  const now = options.now ?? new Date();
  const out: Invoice[] = [];
  for (const charge of charges) {
    const description = invoiceDescription(charge.kind, closing.listing.feePayer, closing.listing.title);
    const { invoice, issued } = await issueOnce(
      { id: invoiceId(closing.id, charge.kind, charge.userId), kind: charge.kind, closingId: closing.id, userId: charge.userId, amountCents: charge.amountCents, description },
      options.series ?? INVOICE_SERIES,
      now,
    );
    out.push(invoice);
    if (!issued) continue;
    await audit(null, "INVOICE_ISSUED", "closing", closing.id, `${invoice.number} · ${description} · ${money(invoice.amountCents / 100, 2)} to ${invoice.userId}`);
    const party = await prisma.user.findUnique({ where: { id: invoice.userId }, select: { email: true } });
    if (party) {
      await notify(
        party.email,
        `Invoice ${invoice.number} · ${closing.listing.title}`,
        `Invoice ${invoice.number}: ${description}, ${money(invoice.amountCents / 100, 2)}. It was ${charge.kind === "PREMIUM" ? "part of what you wired at settlement" : "taken from your proceeds at settlement"}, so nothing more is due. Download it from the closing page or your account.`,
      );
    }
  }
  return out;
}

// finalizeClosing runs this after the close has landed, so a failure is logged and the close stands. A later
// finalize, or the desk's issue button, issues what is missing.
export async function issueClosingInvoicesSafely(closingId: string) {
  try {
    return await issueClosingInvoices(closingId);
  } catch (error) {
    console.error(`[upb-invoices] invoices for closing ${closingId} were not issued:`, error instanceof Error ? error.message : error);
    return [];
  }
}

// What is left to credit on an invoice: its amount less the credit notes against it. Credit notes carry negative cents.
export function creditLeft(invoice: { amountCents: number }, credits: { amountCents: number }[]) {
  return invoice.amountCents + credits.reduce((sum, credit) => sum + credit.amountCents, 0);
}

type Actor = Staff & { id: string; name?: string };

// A canceled or refunded fee. With no amount, or the whole amount left, the fee is canceled: the credit note takes
// what is left and the invoice is marked voided. A smaller amount is a part refund. Fees are the admin's.
export async function creditInvoice(actor: Actor, input: { invoiceId: string; amountCents?: number | null; reason: string }, options: { series?: InvoiceSeries; now?: Date } = {}) {
  if (!deskCan(actor, "admin")) return { error: DESK_DENIED } as const;
  const reason = input.reason.replace(/\s+/g, " ").trim().slice(0, 300);
  if (reason.length < 10) return { error: "Say why the fee is canceled or refunded, in a sentence. The party reads it." } as const;
  const invoice = await prisma.invoice.findUnique({ where: { id: input.invoiceId } });
  if (!invoice || invoice.kind === "CREDIT_NOTE") return { error: "That invoice isn't there." } as const;
  if (invoice.voidedAt) return { error: "That invoice is already canceled." } as const;
  const credits = await prisma.invoice.findMany({ where: { creditOfId: invoice.id, kind: "CREDIT_NOTE" } });
  const left = creditLeft(invoice, credits);
  if (left <= 0) return { error: "That invoice is already credited in full." } as const;
  const asked = input.amountCents ?? left;
  if (!Number.isInteger(asked) || asked <= 0) return { error: "Enter the amount to credit in dollars." } as const;
  if (asked > left) return { error: `Only ${money(left / 100, 2)} is left to credit on ${invoice.number}.` } as const;
  const whole = asked === left;
  const now = options.now ?? new Date();
  const series = options.series ?? INVOICE_SERIES;
  const description = `${whole ? "Fee canceled" : "Fee refunded in part"}: ${invoice.description}. ${reason}`;
  // The cancel's credit note has an id fixed by the invoice, so two cancels at once credit it once.
  const issued = whole
    ? await issueOnce({ id: `cn-${invoice.id}-full`, kind: "CREDIT_NOTE", closingId: invoice.closingId, userId: invoice.userId, amountCents: -asked, description, creditOfId: invoice.id }, series, now)
    : { invoice: await issueInvoice({ kind: "CREDIT_NOTE", closingId: invoice.closingId, userId: invoice.userId, amountCents: -asked, description, creditOfId: invoice.id }, { series, now }), issued: true };
  const credit = issued.invoice;
  if (!issued.issued) return { error: "That invoice is already canceled." } as const;
  // Two credits at once could both pass the check above. One that finds the total past the fee steps back.
  const after = await prisma.invoice.findMany({ where: { creditOfId: invoice.id, kind: "CREDIT_NOTE" } });
  if (creditLeft(invoice, after) < 0) {
    await prisma.invoice.delete({ where: { id: credit.id } });
    return { error: "Another credit on that invoice landed a moment ago. Reload the page." } as const;
  }
  if (whole) await prisma.invoice.update({ where: { id: invoice.id }, data: { voidedAt: now } });
  const closing = invoice.closingId ? await prisma.closing.findUnique({ where: { id: invoice.closingId }, select: { listingId: true, listing: { select: { title: true } } } }) : null;
  // The ledger takes the fee back, so the desk's revenue reads net of it.
  await postRevenueOnce([
    {
      type: invoice.kind === "PREMIUM" ? "BUYER_PREMIUM" : "SELLER_COMMISSION",
      amountCents: -asked,
      listingId: closing?.listingId ?? null,
      userId: invoice.userId,
      description: `Credit note ${credit.number} against ${invoice.number}`,
      externalId: `credit:${credit.id}`,
    },
  ]);
  await audit(actor.id, "CREDIT_NOTE", invoice.closingId ? "closing" : "invoice", invoice.closingId ?? invoice.id, `${credit.number} against ${invoice.number} · ${money(asked / 100, 2)} · ${reason}`);
  const party = await prisma.user.findUnique({ where: { id: invoice.userId }, select: { email: true } });
  if (party) {
    await notify(
      party.email,
      `Credit note ${credit.number}${closing ? ` · ${closing.listing.title}` : ""}`,
      `The desk issued credit note ${credit.number} for ${money(asked / 100, 2)} against invoice ${invoice.number}${whole ? ", which cancels the fee" : ""}. Reason: ${reason} The refund is sent by wire outside the app, and you'll hear when it goes.`,
    );
  }
  return { error: null, credit } as const;
}

// A party's own invoices and credit notes, newest first, or a closing's for the closing page. The desk sees every
// party's on a closing; a party sees only their own.
export async function invoicesFor(where: { userId?: string; closingId?: string }) {
  if (!where.userId && !where.closingId) return [];
  return prisma.invoice.findMany({ where: { ...(where.userId ? { userId: where.userId } : {}), ...(where.closingId ? { closingId: where.closingId } : {}) }, orderBy: { issuedAt: "desc" } });
}

// Who may download an invoice: its own party, or the desk.
export function canReadInvoice(viewer: { id: string; role: string }, invoice: { userId: string }) {
  return viewer.role === "ADMIN" || viewer.id === invoice.userId;
}

function dollars(cents: number) {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export async function buildInvoicePdf(input: {
  invoice: Invoice;
  party: { name: string; companyName?: string | null; email: string };
  listingTitle: string | null;
  creditOf: Invoice | null;
  credits: Invoice[];
}) {
  const { invoice, party } = input;
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const quiet = rgb(0.42, 0.42, 0.46);
  const text = (value: string, x: number, y: number, size = 10, face = font, color = ink) => page.drawText(winAnsi(value).replace(/\n/g, " ").slice(0, 100), { x, y, size, font: face, color });
  const credit = invoice.kind === "CREDIT_NOTE";
  text(`UPB CAPITAL  -  ${credit ? "CREDIT NOTE" : "INVOICE"}`, 48, 744, 10, bold, quiet);
  text(invoice.number, 48, 712, 20, bold);
  text(`Issued ${invoice.issuedAt.toISOString().slice(0, 10)}${invoice.closingId ? `  -  closing ${invoice.closingId}` : ""}`, 48, 692, 9, font, quiet);
  text("Billed to", 48, 656, 9, bold, quiet);
  text(party.companyName ? `${party.companyName}, attention ${party.name}` : party.name, 48, 640);
  text(party.email, 48, 626, 10, font, quiet);
  if (input.listingTitle) text(`Sale: ${input.listingTitle}`, 48, 600);
  if (input.creditOf) text(`Against invoice ${input.creditOf.number}, issued ${input.creditOf.issuedAt.toISOString().slice(0, 10)}`, 48, 586);
  let y = 552;
  text("Description", 48, y, 9, bold, quiet);
  text("Amount", 500, y, 9, bold, quiet);
  y -= 18;
  const description = winAnsi(invoice.description);
  for (let start = 0; start < Math.min(description.length, 270); start += 90) {
    text(description.slice(start, start + 90), 48, y);
    if (start === 0) {
      const amount = dollars(invoice.amountCents);
      page.drawText(amount, { x: 548 - font.widthOfTextAtSize(amount, 10), y, size: 10, font, color: ink });
    }
    y -= 14;
  }
  y -= 10;
  const credited = input.credits.reduce((sum, row) => sum + row.amountCents, 0);
  const total = [
    ["Total", dollars(invoice.amountCents)],
    ...(input.credits.length ? [["Credited", dollars(credited)], ["Net", dollars(invoice.amountCents + credited)]] : []),
  ];
  for (const [label, amount] of total) {
    text(label, 380, y, 10, bold);
    page.drawText(amount, { x: 548 - bold.widthOfTextAtSize(amount, 10), y, size: 10, font: bold, color: ink });
    y -= 16;
  }
  y -= 12;
  for (const row of input.credits) {
    text(`Credit note ${row.number}, ${row.issuedAt.toISOString().slice(0, 10)}: ${dollars(row.amountCents)}`, 48, y, 9, font, quiet);
    y -= 13;
  }
  if (invoice.voidedAt) {
    text(`Canceled ${invoice.voidedAt.toISOString().slice(0, 10)} by credit note.`, 48, y - 6, 10, bold);
  }
  const footer = credit
    ? ["This credit note reduces the fee on the invoice named above. The refund goes by wire outside the platform."]
    : [
        invoice.kind === "PREMIUM"
          ? "The premium was part of the buyer's wire at settlement, so nothing more is due on this invoice."
          : "The commission was taken from the seller's proceeds at settlement, so nothing more is due on this invoice.",
      ];
  [...footer, "UPB Capital. Questions about this document go to the desk on the closing thread."].forEach((line, index) => text(line, 48, 72 - index * 12, 8, font, quiet));
  return pdf.save();
}
