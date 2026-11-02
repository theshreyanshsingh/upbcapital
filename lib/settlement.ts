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
};

export type StatementLine = { label: string; cents: number | null; detail?: string };

// Each party sees its own side only. The desk sees both.
export function statementLines(closing: StatementClosing, side: StatementSide, brokerFeeCents = 0): { heading: string; lines: StatementLine[] }[] {
  const price = Math.round(closing.salePrice * 100);
  const buyer = {
    heading: "Buyer",
    lines: [
      { label: "Purchase price", cents: price },
      { label: "Buyer premium", cents: closing.buyerPremiumCents },
      { label: "Due from buyer", cents: closing.buyerTotalCents },
      {
        label: "Funds received",
        cents: closing.fundsReceivedCents,
        detail: closing.fundsReceivedAt ? `${closing.fundsReceivedAt.toISOString().slice(0, 10)}${closing.fundsReference ? ` · ${closing.fundsReference}` : ""}` : "Not recorded",
      },
    ],
  };
  const seller = {
    heading: "Seller",
    lines: [
      { label: "Sale price", cents: price },
      { label: "Seller commission", cents: -closing.sellerCommissionCents },
      { label: "Net proceeds to seller", cents: closing.netToSellerCents },
      {
        label: "Proceeds sent",
        cents: closing.proceedsSentCents,
        detail: closing.proceedsSentAt ? `${closing.proceedsSentAt.toISOString().slice(0, 10)}${closing.proceedsReference ? ` · ${closing.proceedsReference}` : ""}` : "Not recorded",
      },
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
