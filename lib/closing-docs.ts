import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export const TEMPLATE_KEYS = ["PSA", "ASSIGNMENT", "ALLONGE", "LOST_NOTE_AFFIDAVIT", "DEPOSIT_AGREEMENT"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

// The names the closing page links each form by.
export const TEMPLATE_LABELS: Record<TemplateKey, string> = {
  PSA: "Purchase agreement",
  ASSIGNMENT: "Assignment",
  ALLONGE: "Allonge",
  LOST_NOTE_AFFIDAVIT: "Lost note affidavit",
  DEPOSIT_AGREEMENT: "Deposit agreement",
};

// An assignment, an allonge and a lost note affidavit travel with each loan, so a pool gets one part per loan. The
// purchase and deposit agreements cover the whole sale.
export const PER_LOAN_TEMPLATES: readonly TemplateKey[] = ["ASSIGNMENT", "ALLONGE", "LOST_NOTE_AFFIDAVIT"];

const DESK_DRAFT = "Desk draft pending counsel review.";

// The articles are short on purpose. The master agreements in lib/agreements.ts carry the full terms, and
// {{masterTerms}} says whether they are incorporated. Their periods fill from the same constants.
export const DEFAULT_TEMPLATES: Record<TemplateKey, { title: string; body: string }> = {
  PSA: {
    title: "Purchase and sale agreement",
    body: [
      `${DESK_DRAFT} This form is not final, and the parties may edit the fields before signing.`,
      "This purchase and sale agreement records a sale of mortgage paper between {{seller}} (seller) and {{buyer}} (buyer), arranged on UPB Capital.",
      "Listing: {{title}}. Collateral city: {{city}}, {{state}}. Street, when released: {{street}}.",
      "Unpaid principal on the tape: {{upb}}. Sale price: {{price}}. Buyer premium: {{premium}}. All-in: {{allIn}}.",
      "The buyer pays the all-in amount. The seller receives {{net}} after commission of {{commission}}.",
      "1. As-is sale. Each loan is sold as is, where is, and with all faults, except for the warranty and representations in articles 2 and 3. The buyer relies on its own diligence, not on UPB's reviews, price ranges or estimates.",
      "2. Seller's warranty. The seller warrants, as of closing, that it owns each loan free of any other interest it has not disclosed and released; that the chain of endorsements and assignments from the original lender to the seller is complete, or is completed at closing, with a lost note affidavit for any lost original; and that each mortgage is a lien on the collateral in the lien position the tape states.",
      "3. Representations. The seller represents that the tape and files are true in all material respects as of the cut-off date, and that it disclosed every bankruptcy, foreclosure, modification and lawsuit on the loans it knows of. The buyer represents that its buyer file is true, that it may buy and hold the loans, that its money is from lawful sources, and that it is not on a sanctions list. Each side represents that its signer may bind it.",
      "4. Repurchase. If the buyer writes the seller through the desk, within {{repurchaseDays}} days after closing, about a breach of article 2 or 3 that materially and adversely affects a loan, the seller has {{cureDays}} days to cure it. If it does not, the seller repurchases that loan at the price paid for it, plus the buyer's documented costs of the purchase and of the claim, less principal the buyer collected. Repurchase is the buyer's only remedy for a breach of a representation, except for fraud.",
      "5. Proration. The price is set from the tape's unpaid principal. If the unpaid principal at closing differs, the price moves in the same proportion, and the settlement statement shows the change before money moves. Interest before the closing date belongs to the seller, and from it to the buyer.",
      "6. Deposit. {{depositTerms}} It is applied to the price at closing. It is refunded in full if the seller fails to close, if the sale ends with neither side at fault, or if the buyer walks away {{diligenceWindow}}. It is forfeited to the seller if the buyer fails to close after that window, for a reason that is not the seller's fault, as the seller's only remedy for that failure.",
      "7. No going around the desk. If either side closes a sale of these loans with the other anywhere else within {{feeTailMonths}} months of UPB's introduction, it owes UPB the fees UPB would have charged on the desk.",
      "8. Confidentiality. Each side keeps the borrower's details, the files and this sale's terms confidential, and shares them only with its counsel, lenders, auditors and servicer.",
      "9. Electronic signatures. The parties sign this agreement electronically, and an electronic signature binds them as ink would. The original notes, allonges and assignments are signed and delivered on paper.",
      "10. Governing law. This agreement is governed by the laws of [State], set by counsel.",
      "11. Master agreements. {{masterTerms}}",
    ].join("\n\n"),
  },
  ASSIGNMENT: {
    title: "Assignment of mortgage",
    body: [
      "{{seller}} assigns to {{buyer}} the mortgage and note described as {{title}}, with the seller's rights under them.",
      "The collateral is in {{city}}, {{state}}. Street: {{street}}. Borrower: {{borrower}}.",
      "Unpaid principal {{upb}}. Consideration {{price}}, dated {{date}}.",
      "The assignment is of the seller's interest in the paper, without recourse except as the purchase and sale agreement provides.",
      `${DESK_DRAFT} [Counsel to add the recording form, notary block and return address the county requires.]`,
    ].join("\n\n"),
  },
  ALLONGE: {
    title: "Allonge",
    body: [
      "Pay to the order of {{buyer}}, without recourse, the note on {{title}}.",
      "Original payee side: {{seller}}. Unpaid principal {{upb}}. Date {{date}}.",
      "Borrower {{borrower}}. Collateral {{street}}, {{city}}, {{state}}.",
      `Attach this allonge firmly to the note, so it becomes part of it. ${DESK_DRAFT}`,
    ].join("\n\n"),
  },
  LOST_NOTE_AFFIDAVIT: {
    title: "Lost note affidavit",
    body: [
      `${DESK_DRAFT} Many states set their own wording, and some require a notary or a court filing. [Counsel to confirm by state.]`,
      "{{signer}}, {{signerTitle}} of {{seller}} (the seller), states under penalty of perjury:",
      "1. The loan. The seller owns the promissory note described here and the mortgage that secures it. Borrower: {{borrower}}. Collateral: {{street}}, {{city}}, {{state}}. Loan number: {{loanNumber}}. Note date: {{noteDate}}. Unpaid principal: {{upb}}.",
      "2. The loss. The seller, or its custodian, held the original note and was entitled to enforce it when it was lost. The loss was not the result of a transfer or a lawful seizure. The note has not been endorsed, pledged or assigned to anyone else.",
      "3. The search. The seller searched its own files and its custodian's, and cannot find the original. A true copy of the note is attached.",
      "4. The sale. The seller sells the note and the mortgage to {{buyer}} (the buyer) under their purchase and sale agreement, for {{price}}, and assigns the buyer its right to enforce the note.",
      "5. Indemnity. The seller indemnifies the buyer, and anyone who takes the note from it, against any loss, cost or claim, including reasonable legal fees, that comes from the loss of the original or from anyone who presents it. If the original turns up, the seller delivers it to the buyer, endorsed, within [10] business days.",
      "Signed {{date}} by {{signer}}, {{signerTitle}}, for {{seller}}.",
      "[Counsel to add the notary acknowledgement for the state.]",
    ].join("\n\n"),
  },
  DEPOSIT_AGREEMENT: {
    title: "Deposit agreement",
    body: [
      `${DESK_DRAFT} This form is not final. [Counsel to confirm who holds the deposit, and on what terms.]`,
      "This deposit agreement is between {{buyer}} (buyer) and {{seller}} (seller), for the sale of {{title}} at {{price}} under their purchase and sale agreement, arranged on UPB Capital.",
      "1. Amount. {{depositTerms}} The buyer wires it to the account in the closing instructions, with the reference {{closingRef}}. The deposit is not a fee to UPB.",
      "2. Holding. The deposit is held [by the escrow agent named in the closing instructions] until the sale closes or ends. It earns no interest for either side.",
      "3. At closing. The deposit is applied to the buyer's all-in amount of {{allIn}}, and the buyer wires the balance.",
      "4. Refund. The deposit is refunded to the buyer in full within [5] business days when:",
      "- the seller fails to close, or breaches the purchase and sale agreement;\n- the sale ends with neither side at fault, such as a loan paying off, a court order, or the desk ending the sale; or\n- the buyer walks away {{diligenceWindow}}.",
      "5. Forfeit. The deposit goes to the seller when the buyer fails to close after the diligence window ends, for a reason that is not the seller's fault. It is liquidated damages and the seller's only remedy for that failure, since the seller's real loss would be hard to measure. [Counsel to confirm enforceability by state.]",
      "6. Release. The desk records which case applies on the closing, and a second desk member approves a refund or a forfeit before the money moves. A party who disagrees writes the desk on the closing thread within [5] business days.",
      "7. Master agreements. Buyer: {{buyerMaster}}. Seller: {{sellerMaster}}. Where the purchase and sale agreement incorporates them, their deposit terms are the same as these.",
      "8. Governing law. This agreement is governed by the laws of [State], set by counsel. The parties sign it electronically on {{date}}.",
    ].join("\n\n"),
  },
};

export function fillTemplate(body: string, vars: Record<string, string>) {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => vars[key] ?? "");
}

// A purchase agreement saved before {{masterTerms}} existed still says whether the masters are incorporated.
export function formBody(kind: TemplateKey, body: string) {
  return kind === "PSA" && !/\{\{\s*masterTerms\s*\}\}/.test(body) ? `${body}\n\nMaster agreements. {{masterTerms}}` : body;
}

// The tokens a form uses, in order, for the forms page.
export function templateTokens(body: string) {
  return [...new Set([...body.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((match) => match[1]))];
}

// The standard fonts encode WinAnsi only, and a name typed with a character outside it would stop the PDF. Such a
// character is written without its accent, or as "?" when there is no accent to drop.
const WIN_ANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
// Letters whose stroke isn't an accent, so they don't decompose.
const STROKED: Record<string, string> = { "Ł": "L", "ł": "l", "Đ": "D", "đ": "d", "ı": "i" };
const printable = (code: number) => (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff);

export function winAnsi(text: string) {
  return [...text]
    .map((char) => {
      if (char === "\n") return char;
      if (char === "\r") return "";
      if (char === "\t") return " ";
      if (printable(char.codePointAt(0)!) || WIN_ANSI_EXTRA.includes(char)) return char;
      const plain = (STROKED[char] ?? char).normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
      return plain && [...plain].every((part) => printable(part.codePointAt(0)!)) ? plain : "?";
    })
    .join("");
}

// One part per instrument: a pool's assignment or allonge is one part per loan. The first page of each part
// carries its editable fields, and a part longer than a page continues on the next ones instead of being cut.
export async function buildClosingPdf(input: { title: string; body?: string; pages?: string[]; fields: { name: string; value: string }[] }) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const gold = rgb(0.776, 0.643, 0.431);
  const ink = rgb(0.12, 0.11, 0.09);
  const form = pdf.getForm();
  const parts = (input.pages ?? [input.body ?? ""]).map(winAnsi);
  parts.forEach((body, part) => {
    const lines = body.split(/\n+/).flatMap((line) => wrap(line, 90));
    const chunks = [lines.slice(0, 22)];
    for (let start = 22; start < lines.length; start += 38) chunks.push(lines.slice(start, start + 38));
    chunks.forEach((rows, index) => {
      const page = pdf.addPage([612, 792]);
      page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: rgb(0.03, 0.03, 0.04) });
      page.drawText("UPB CAPITAL", { x: 48, y: 762, size: 11, font, color: gold });
      page.drawText(winAnsi(`${input.title}${index > 0 ? " (continued)" : ""}`).slice(0, 70), { x: 48, y: 700, size: 20, font, color: ink });
      rows.forEach((line, row) => page.drawText(line, { x: 48, y: 660 - row * 16, size: 11, font, color: ink }));
      if (index > 0) return;
      input.fields.slice(0, 6).forEach((field, fieldIndex) => {
        const box = form.createTextField(part === 0 ? field.name : `${field.name}_${part + 1}`);
        box.setText(winAnsi(field.value).replace(/\n/g, " ").slice(0, 80));
        box.addToPage(page, { x: 48, y: 160 - fieldIndex * 28, width: 360, height: 18 });
      });
      page.drawText("Fields below stay editable.", { x: 48, y: 200, size: 9, font, color: rgb(0.4, 0.38, 0.34) });
    });
  });
  return Buffer.from(await pdf.save());
}

function wrap(line: string, width: number) {
  const words = line.split(/\s+/);
  const rows: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width) {
      if (current) rows.push(current);
      current = word;
    } else current = next;
  }
  if (current) rows.push(current);
  return rows.length ? rows : [""];
}
