import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export const TEMPLATE_KEYS = ["PSA", "ASSIGNMENT", "ALLONGE"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const DEFAULT_TEMPLATES: Record<TemplateKey, { title: string; body: string }> = {
  PSA: {
    title: "Purchase and sale agreement",
    body: [
      "This desk form records a sale of mortgage paper between {{seller}} (seller) and {{buyer}} (buyer).",
      "Listing: {{title}}. Collateral city: {{city}}, {{state}}. Street, when released: {{street}}.",
      "Unpaid principal: {{upb}}. Sale price: {{price}}. Buyer premium: {{premium}}. All-in: {{allIn}}.",
      "The buyer pays the all-in amount. The seller receives {{net}} after commission of {{commission}}.",
      "This is a fictional desk form, not a law-firm instrument. The parties may edit the fields before signing.",
    ].join("\n\n"),
  },
  ASSIGNMENT: {
    title: "Assignment of mortgage",
    body: [
      "{{seller}} assigns to {{buyer}} the mortgage and note described as {{title}}.",
      "The collateral is in {{city}}, {{state}}. Street: {{street}}. Borrower: {{borrower}}.",
      "Unpaid principal {{upb}}. Consideration {{price}}, dated {{date}}.",
      "The assignment is of the seller's interest in the paper. It is a desk form for this demo.",
    ].join("\n\n"),
  },
  ALLONGE: {
    title: "Allonge",
    body: [
      "Pay to the order of {{buyer}}, without recourse, the note on {{title}}.",
      "Original payee side: {{seller}}. Unpaid principal {{upb}}. Date {{date}}.",
      "Borrower {{borrower}}. Collateral {{street}}, {{city}}, {{state}}.",
      "Attach this allonge to the note. Desk form only.",
    ].join("\n\n"),
  },
};

export function fillTemplate(body: string, vars: Record<string, string>) {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => vars[key] ?? "");
}

export async function buildClosingPdf(input: { title: string; body: string; fields: { name: string; value: string }[] }) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const gold = rgb(0.776, 0.643, 0.431);
  const ink = rgb(0.12, 0.11, 0.09);
  page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: rgb(0.03, 0.03, 0.04) });
  page.drawText("UPB CAPITAL", { x: 48, y: 762, size: 11, font, color: gold });
  page.drawText(input.title.slice(0, 70), { x: 48, y: 700, size: 20, font, color: ink });
  const paragraphs = input.body.split(/\n+/).flatMap((line) => wrap(line, 90));
  paragraphs.slice(0, 22).forEach((line, index) => {
    page.drawText(line, { x: 48, y: 660 - index * 16, size: 11, font, color: ink });
  });
  const form = pdf.getForm();
  input.fields.slice(0, 6).forEach((field, index) => {
    const box = form.createTextField(field.name);
    box.setText(field.value.slice(0, 80));
    box.addToPage(page, { x: 48, y: 160 - index * 28, width: 360, height: 18 });
  });
  page.drawText("Fields below stay editable.", { x: 48, y: 200, size: 9, font, color: rgb(0.4, 0.38, 0.34) });
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
