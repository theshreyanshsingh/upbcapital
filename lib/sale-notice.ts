import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { PAYMENT_POLICIES, type PaymentPolicy } from "@/lib/borrower-notices";

export type SaleNoticeLoan = { streetAddress: string; city: string; state: string; zip: string; borrowerName: string; loanNumber: string };

export type SaleNoticeInput = {
  owner: string;
  ownerContact: string;
  transfer: Date | null;
  agent: string;
  recording: string;
  policy: PaymentPolicy | null;
  loans: SaleNoticeLoan[];
};

const clean = (text: string) => text.replace(/[^\x20-\x7E]/g, "-");

export function wrap(text: string, font: PDFFont, size: number, width: number) {
  const lines: string[] = [];
  // Split first: clean() would turn the line breaks themselves into dashes.
  for (const paragraph of text.split(/\r?\n/).map(clean)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

// One page per loan, with the contents 12 CFR 1026.39(d) asks for. Blanks stay in square brackets for the
// owner to fill. It is a draft: the new owner checks it, has counsel review it, and sends it.
export async function buildSaleNoticePdf(input: SaleNoticeInput) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const quiet = rgb(0.42, 0.42, 0.46);
  const transfer = input.transfer ? input.transfer.toISOString().slice(0, 10) : "[date of transfer]";
  for (const loan of input.loans) {
    const page = pdf.addPage([612, 792]);
    let y = 744;
    const write = (text: string, options: { size?: number; font?: PDFFont; color?: typeof ink; gap?: number } = {}) => {
      const size = options.size ?? 10.5;
      for (const line of wrap(text, options.font ?? font, size, 516)) {
        page.drawText(line, { x: 48, y, size, font: options.font ?? font, color: options.color ?? ink });
        y -= size + 4;
      }
      y -= options.gap ?? 8;
    };
    write("DRAFT FOR THE NEW OWNER TO REVIEW AND SEND. UPB CAPITAL DOES NOT SEND THIS NOTICE.", { size: 8.5, font: bold, color: quiet, gap: 14 });
    write("Notice of Sale or Transfer of Your Mortgage Loan", { size: 17, font: bold, gap: 14 });
    write(`To: ${loan.borrowerName || "[borrower name]"}`);
    write(`Property: ${[loan.streetAddress, loan.city, `${loan.state} ${loan.zip}`.trim()].filter(Boolean).join(", ")}`, { gap: 2 });
    write(`Loan number: ${loan.loanNumber || "[loan number]"}`, { gap: 16 });
    write("Your mortgage loan has been sold or transferred to a new owner. This notice tells you who owns it now and whom to contact.", { gap: 14 });
    write("New owner", { font: bold, gap: 2 });
    write(`${input.owner}\n${input.ownerContact || "[mailing address]\n[telephone number]"}`, { gap: 12 });
    write("Date of transfer", { font: bold, gap: 2 });
    write(transfer, { gap: 12 });
    write("Questions about your payments", { font: bold, gap: 2 });
    write(`For questions about your payments, and to send any notice that you are using a right to cancel (rescind) the loan, contact:\n${input.agent || "[name, address and telephone number of the servicer or agent]"}`, { gap: 12 });
    write("Where the transfer is recorded", { font: bold, gap: 2 });
    write(input.recording, { gap: 12 });
    write("Partial payments", { font: bold, gap: 2 });
    write(`${input.policy ? PAYMENT_POLICIES[input.policy] : "[state whether partial payments are accepted, held, or returned]"} If this loan is sold, your new lender may have a different policy.`, { gap: 12 });
    const footer = [
      "Prepared by UPB Capital from the closing record as a draft. The new owner is responsible for this notice and its",
      "accuracy, and for sending it on or before the 30th day after the date of transfer (12 CFR 1026.39). Have counsel review it",
      "before it is sent. If the servicer is also changing, the servicers send their own transfer letters (12 CFR 1024.33).",
    ];
    footer.forEach((line, index) => page.drawText(line, { x: 48, y: 72 - index * 11, size: 7.5, font, color: quiet }));
  }
  return pdf.save();
}
