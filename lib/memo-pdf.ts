import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Resolution } from "@/lib/underwriting";

export async function buildMemoPdf(input: {
  title: string;
  city: string;
  state: string;
  bid: number;
  upb: number;
  value: number;
  performing: boolean;
  yieldPct: number | null;
  irrPct: number | null;
  cashOnCash: number | null;
  paybackMonths: number | null;
  scenarios: Resolution[];
  avm: number | null;
}) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const gold = rgb(0.776, 0.643, 0.431);
  const ink = rgb(0.12, 0.11, 0.09);
  const money = (value: number) => `$${Math.round(value).toLocaleString("en-US")}`;
  const pct = (value: number | null) => (value == null ? "—" : `${value.toFixed(1)}%`);
  page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: rgb(0.03, 0.03, 0.04) });
  page.drawText("UPB CAPITAL  ·  UNDERWRITING MEMO", { x: 48, y: 762, size: 11, font, color: gold });
  page.drawText(input.title.slice(0, 70), { x: 48, y: 700, size: 22, font, color: ink });
  page.drawText(`${input.city}, ${input.state}  ·  Bid ${money(input.bid)}`, { x: 48, y: 676, size: 12, font: italic, color: rgb(0.4, 0.38, 0.34) });
  const lines = [
    `UPB ${money(input.upb)}    Value ${money(input.value)}    AVM ${input.avm == null ? "—" : money(input.avm)}`,
    input.performing
      ? `Yield ${pct(input.yieldPct)}    IRR ${pct(input.irrPct)}    Cash-on-cash ${pct(input.cashOnCash)}    Payback ${input.paybackMonths == null ? "—" : `${input.paybackMonths.toFixed(1)} months`}`
      : "Non-performing. The figures below are exit scenarios, not a coupon yield.",
    "Unlevered. The bid is the cash in. Premium is not in these returns.",
  ];
  lines.forEach((line, index) => page.drawText(line.slice(0, 110), { x: 48, y: 640 - index * 18, size: 11, font, color: ink }));
  let y = 560;
  page.drawText("Resolutions", { x: 48, y, size: 13, font, color: gold });
  y -= 22;
  for (const row of input.scenarios) {
    page.drawText(
      `${row.label}  ·  ${row.months} mo  ·  cost ${money(row.cost)}  ·  net ${money(row.net)}  ·  ${pct(row.annualized)} simple`,
      { x: 48, y, size: 10, font, color: ink },
    );
    y -= 16;
    if (y < 80) break;
  }
  page.drawText("Desk model for a fictional file. Not an appraisal and not legal advice.", { x: 48, y: 36, size: 9, font, color: rgb(0.4, 0.38, 0.34) });
  return Buffer.from(await pdf.save());
}
