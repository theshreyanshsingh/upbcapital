import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export type Variance = { state: "none" | "match" | "short" | "over"; diffCents: number };

// A dollar either way is rounding on a wire, not a shortfall.
export function variance(expectedCents: number, recordedCents: number | null | undefined): Variance {
  if (recordedCents == null) return { state: "none", diffCents: 0 };
  const diff = recordedCents - expectedCents;
  if (Math.abs(diff) <= 100) return { state: "match", diffCents: diff };
  return { state: diff < 0 ? "short" : "over", diffCents: diff };
}

export type StatementSide = "buyer" | "seller" | "desk";

type StatementClosing = {
  id: string;
  salePrice: number;
  buyerPremiumCents: number;
  sellerCommissionCents: number;
  buyerTotalCents: number;
  netToSellerCents: number;
  openedAt: Date;
  closedAt: Date | null;
  status: string;
  fundsReceivedCents: number | null;
  fundsReceivedAt: Date | null;
  fundsReference: string | null;
  proceedsSentCents: number | null;
  proceedsSentAt: Date | null;
  proceedsReference: string | null;
  depositCents?: number | null;
  depositReceivedCents?: number | null;
  depositReceivedAt?: Date | null;
  depositReference?: string | null;
};

// One seat holder's part of a group closing.
export type FunderShare = { amount: number; premiumCents: number; status: string; fundedAt: Date | null };

export type StatementLine = { label: string; cents: number | null; detail?: string };

// Who is looking decides which figures they get. A broker who is not a party sees only their own fee.
export function statementSide(input: { role: string; userId: string; sellerId: string; buyerId: string | null; funderIds: string[] }): StatementSide | "observer" {
  if (input.role === "ADMIN") return "desk";
  if (input.userId === input.sellerId) return "seller";
  if (input.userId === input.buyerId || input.funderIds.includes(input.userId)) return "buyer";
  return "observer";
}

// The deposit counts toward what the buyer owes, so the balance wire is checked against the total less the deposit.
export function balanceDueCents(closing: { buyerTotalCents: number; depositReceivedCents?: number | null }) {
  return closing.buyerTotalCents - (closing.depositReceivedCents ?? 0);
}

export function buyerFundsCheck(closing: { buyerTotalCents: number; fundsReceivedCents: number | null; depositReceivedCents?: number | null }) {
  return variance(balanceDueCents(closing), closing.fundsReceivedCents);
}

// The steps that say money is in need the wire on record first. Returns what is missing, or null. The desk buying
// for its own book has no buyer wire to wait for.
export function moneyGate(
  stepKey: string,
  closing: { deskBidId?: string | null; buyerTotalCents: number; fundsReceivedCents: number | null; depositCents?: number | null; depositReceivedCents?: number | null },
  funders: { status: string }[],
) {
  if (closing.deskBidId) return null;
  if (stepKey === "BUYER_DEPOSIT") {
    if (closing.depositCents == null) return null;
    const check = variance(closing.depositCents, closing.depositReceivedCents);
    if (check.state === "none") return "The buyer's deposit isn't recorded.";
    if (check.state === "short") return `The deposit recorded is ${varianceNote(check)}.`;
    return null;
  }
  if (stepKey !== "PAYMENT_RECEIVED" && stepKey !== "CLOSED") return null;
  const check = buyerFundsCheck(closing);
  if (check.state === "none") return "Buyer funds aren't recorded.";
  if (check.state === "short") return `Buyer funds are ${varianceNote(check)}, counting the deposit.`;
  const waiting = funders.filter((funder) => funder.status !== "FUNDED").length;
  if (waiting) return `${waiting} of ${funders.length} group share${funders.length === 1 ? "" : "s"} ${waiting === 1 ? "isn't" : "aren't"} marked funded.`;
  return null;
}

export function varianceNote(check: Variance) {
  if (check.state === "match") return "matches";
  if (check.state === "short") return `short ${dollars(-check.diffCents)}`;
  if (check.state === "over") return `over by ${dollars(check.diffCents)}`;
  return "";
}

function wireDetail(at: Date | null | undefined, reference: string | null | undefined, check?: Variance) {
  if (!at) return "Not recorded";
  const note = check ? varianceNote(check) : "";
  return `${at.toISOString().slice(0, 10)}${reference ? ` · ${reference}` : ""}${note ? ` · ${note}` : ""}`;
}

function shareSection(share: FunderShare) {
  const price = Math.round(share.amount * 100);
  const due = price + share.premiumCents;
  return {
    heading: "Your share",
    lines: [
      { label: "Your share of the price", cents: price },
      { label: "Your share of the premium", cents: share.premiumCents },
      { label: "Due from you", cents: due },
      {
        label: "Share funded",
        cents: share.status === "FUNDED" ? due : null,
        detail: share.status === "FUNDED" && share.fundedAt ? `Marked funded by the desk ${share.fundedAt.toISOString().slice(0, 10)}` : "Not recorded",
      },
    ],
  };
}

// The price and fee rows each side sees on the closing page, the same figures as its statement.
export function economicsRows(
  closing: { salePrice: number; buyerPremiumCents: number; sellerCommissionCents: number; buyerTotalCents: number; netToSellerCents: number },
  side: StatementSide | "observer",
  share: FunderShare | null = null,
): { label: string; cents: number }[] {
  const price = Math.round(closing.salePrice * 100);
  if (side === "buyer" && share) {
    const mine = Math.round(share.amount * 100);
    return [
      { label: "Your share of the price", cents: mine },
      { label: "Your share of the premium", cents: share.premiumCents },
      { label: "Your all-in", cents: mine + share.premiumCents },
    ];
  }
  const buyer = [
    { label: "Sale price", cents: price },
    { label: "Buyer premium", cents: closing.buyerPremiumCents },
    { label: "Buyer all-in", cents: closing.buyerTotalCents },
  ];
  const seller = [
    { label: "Seller commission", cents: closing.sellerCommissionCents },
    { label: "Net to seller", cents: closing.netToSellerCents },
  ];
  if (side === "buyer") return buyer;
  if (side === "seller") return [buyer[0], ...seller];
  if (side === "desk") return [...buyer, ...seller];
  return [];
}

// Each party sees its own side only. The desk sees both. A group seat holder sees their own share.
export function statementLines(
  closing: StatementClosing,
  side: StatementSide,
  brokerFeeCents = 0,
  share: FunderShare | null = null,
): { heading: string; lines: StatementLine[] }[] {
  if (side === "buyer" && share) return [shareSection(share)];
  const price = Math.round(closing.salePrice * 100);
  const hasDeposit = closing.depositCents != null || closing.depositReceivedCents != null;
  const buyer = {
    heading: "Buyer",
    lines: [
      { label: "Purchase price", cents: price },
      { label: "Buyer premium", cents: closing.buyerPremiumCents },
      { label: "Due from buyer", cents: closing.buyerTotalCents },
      ...(hasDeposit
        ? [
            {
              label: "Deposit received",
              cents: closing.depositReceivedCents ?? null,
              detail: wireDetail(closing.depositReceivedAt, closing.depositReference, closing.depositCents != null ? variance(closing.depositCents, closing.depositReceivedCents) : undefined),
            },
            { label: "Balance due", cents: balanceDueCents(closing) },
          ]
        : []),
      { label: "Funds received", cents: closing.fundsReceivedCents, detail: wireDetail(closing.fundsReceivedAt, closing.fundsReference, buyerFundsCheck(closing)) },
    ],
  };
  const seller = {
    heading: "Seller",
    lines: [
      { label: "Sale price", cents: price },
      { label: "Seller commission", cents: -closing.sellerCommissionCents },
      { label: "Net proceeds to seller", cents: closing.netToSellerCents },
      { label: "Proceeds sent", cents: closing.proceedsSentCents, detail: wireDetail(closing.proceedsSentAt, closing.proceedsReference, variance(closing.netToSellerCents, closing.proceedsSentCents)) },
    ],
  };
  if (side === "buyer") return [buyer];
  if (side === "seller") return [seller];
  const desk = {
    heading: "Desk",
    lines: [
      { label: "Buyer premium", cents: closing.buyerPremiumCents },
      { label: "Seller commission", cents: closing.sellerCommissionCents },
      ...(brokerFeeCents ? [{ label: "Broker fees owed", cents: -brokerFeeCents }] : []),
      { label: "Desk revenue", cents: closing.buyerPremiumCents + closing.sellerCommissionCents - brokerFeeCents },
    ],
  };
  return [buyer, seller, desk];
}

function dollars(cents: number | null) {
  if (cents == null) return "—";
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export async function buildStatementPdf(input: { title: string; parties: string; closing: StatementClosing; sections: { heading: string; lines: StatementLine[] }[] }) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const quiet = rgb(0.42, 0.42, 0.46);
  const clean = (text: string) => text.replace(/[^\x20-\x7E]/g, "-");
  page.drawText("UPB CAPITAL  -  SETTLEMENT STATEMENT", { x: 48, y: 744, size: 10, font: bold, color: quiet });
  page.drawText(clean(input.title).slice(0, 70), { x: 48, y: 712, size: 18, font: bold, color: ink });
  page.drawText(clean(input.parties).slice(0, 100), { x: 48, y: 692, size: 10, font, color: quiet });
  const status = input.closing.status === "COMPLETE" && input.closing.closedAt
    ? `Closed ${input.closing.closedAt.toISOString().slice(0, 10)}`
    : input.closing.status === "CANCELED" ? "Canceled" : "Open - figures may change before closing";
  page.drawText(`Closing ${input.closing.id}  -  opened ${input.closing.openedAt.toISOString().slice(0, 10)}  -  ${status}`, { x: 48, y: 676, size: 9, font, color: quiet });
  let y = 640;
  for (const section of input.sections) {
    page.drawText(section.heading, { x: 48, y, size: 12, font: bold, color: ink });
    y -= 20;
    for (const line of section.lines) {
      page.drawText(clean(line.label), { x: 60, y, size: 10, font, color: ink });
      const amount = dollars(line.cents);
      page.drawText(amount, { x: 548 - font.widthOfTextAtSize(amount, 10), y, size: 10, font, color: ink });
      if (line.detail) {
        y -= 13;
        page.drawText(clean(line.detail).slice(0, 90), { x: 72, y, size: 8, font, color: quiet });
      }
      y -= 18;
    }
    y -= 14;
  }
  const footer = [
    "Prepared by the UPB Capital desk from the closing record. Escrow is handled by wire outside the platform,",
    "so funds received and proceeds sent are recorded by the desk. Check every figure against your own wire records.",
  ];
  footer.forEach((line, index) => page.drawText(line, { x: 48, y: 72 - index * 12, size: 8, font, color: quiet }));
  return pdf.save();
}
