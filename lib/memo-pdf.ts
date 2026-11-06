import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import type { Resolution } from "@/lib/underwriting";

// Greedy word wrap to a width in points, for lines too long for one row. Shared with the lender pack.
export function wrap(text: string, font: PDFFont, size: number, width: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(next, size) > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// The standard fonts encode WinAnsi only, and drawText throws on anything else. Text typed by people (names, memos,
// details) passes through this first: common symbols become words, anything else unprintable becomes "?".
const PDF_STAND_INS: Record<string, string> = { "→": "to", "←": "from", "≥": ">=", "≤": "<=", "≈": "~", "✓": "yes", "✗": "no" };

const charsets = new WeakMap<PDFFont, Set<number>>();

export function pdfSafe(text: string, font: PDFFont) {
  const supported = charsets.get(font) ?? new Set(font.getCharacterSet());
  charsets.set(font, supported);
  return Array.from(text.normalize("NFC").replace(/[\t\r\n]+/g, " "))
    .map((char) => (supported.has(char.codePointAt(0) ?? 0) ? char : (PDF_STAND_INS[char] ?? "?")))
    .join("");
}

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
  // From yieldAtPrice: the expected IRR for non-performing paper and its 10th, 50th and 90th percentiles.
  expectedIrr?: number | null;
  irrRange?: { low: number; mid: number; high: number } | null;
  // Performing paths: contract, early payoff, default.
  paths?: { label: string; weight: number; irrPct: number | null }[];
  // Where the payoff path's weight came from, as the analyzer states it.
  prepaymentLabel?: string | null;
  timeline?: string | null;
  law?: string | null;
  weightsBasis?: string | null;
  // When the bid was solved from a target IRR.
  solved?: { target: number; bid: number; pctOfUpb: number | null; pctOfValue: number | null } | null;
  demo?: boolean;
}) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const gold = rgb(0.776, 0.643, 0.431);
  const ink = rgb(0.12, 0.11, 0.09);
  const soft = rgb(0.4, 0.38, 0.34);
  const money = (value: number) => `$${Math.round(value).toLocaleString("en-US")}`;
  const pct = (value: number | null | undefined) => (value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}%`);
  const share = (weight: number) => `${Math.round(weight * 100)}%`;
  const ofUpb = input.upb > 0 ? ` (${((input.bid / input.upb) * 100).toFixed(1)}% of UPB)` : "";
  page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: rgb(0.03, 0.03, 0.04) });
  page.drawText("UPB CAPITAL  ·  UNDERWRITING MEMO", { x: 48, y: 762, size: 11, font, color: gold });
  page.drawText(input.title.slice(0, 70), { x: 48, y: 700, size: 22, font, color: ink });
  page.drawText(`${input.city}, ${input.state}  ·  Bid ${money(input.bid)}${ofUpb}`, { x: 48, y: 676, size: 12, font: italic, color: soft });

  let y = 640;
  const write = (text: string, options: { size?: number; color?: typeof ink; gap?: number; face?: PDFFont } = {}) => {
    const size = options.size ?? 11;
    for (const line of wrap(text, options.face ?? font, size, 516)) {
      if (y < 60) return;
      page.drawText(line, { x: 48, y, size, font: options.face ?? font, color: options.color ?? ink });
      y -= size + 5;
    }
    y -= options.gap ?? 2;
  };

  write(`UPB ${money(input.upb)}    Value ${money(input.value)}    AVM ${input.avm == null ? "—" : money(input.avm)}`);
  if (input.solved) {
    const ofValue = input.solved.pctOfValue == null ? "" : `, ${input.solved.pctOfValue.toFixed(1)}% of value`;
    write(`Solved for a ${input.solved.target.toFixed(1)}% annual IRR: ${money(input.solved.bid)}, ${pct(input.solved.pctOfUpb)} of UPB${ofValue}.`);
  }
  if (input.performing) {
    write(
      `Yield ${pct(input.yieldPct)}    IRR to term ${pct(input.irrPct)}    Cash-on-cash ${pct(input.cashOnCash)}    Payback ${input.paybackMonths == null ? "—" : `${input.paybackMonths.toFixed(1)} months`}`,
    );
  } else {
    write(`Expected IRR ${pct(input.expectedIrr)} across the weighted resolutions. Not a coupon yield.`);
  }
  if (input.irrRange) {
    write(`Median outcome ${pct(input.irrRange.mid)}. Eight in ten outcomes fall between ${pct(input.irrRange.low)} and ${pct(input.irrRange.high)}.`);
  }
  write("Unlevered. The bid is the cash in. The buyer premium and closing costs are not in these returns.", { gap: 10 });

  if (input.paths?.length) {
    page.drawText("Paths", { x: 48, y, size: 13, font, color: gold });
    y -= 20;
    for (const path of input.paths) write(`${path.label}  ·  weight ${share(path.weight)}  ·  IRR ${pct(path.irrPct)}`, { size: 10, gap: 0 });
    write(input.prepaymentLabel || "Desk weights, not a prepayment or default model.", { size: 9, color: soft, gap: 10 });
  }

  if (input.scenarios.length) {
    page.drawText("Resolutions", { x: 48, y, size: 13, font, color: gold });
    y -= 20;
    if (input.timeline) write(input.timeline, { size: 10 });
    if (input.law) write(`Process law: ${input.law}`, { size: 9, color: soft });
    if (input.weightsBasis) write(input.weightsBasis, { size: 9, color: soft, gap: 6 });
    for (const row of input.scenarios) {
      write(
        `${row.label}  ·  weight ${share(row.weight)}  ·  ${row.months} mo  ·  paid out ${money(row.cost)}  ·  received ${money(row.recovery)}  ·  IRR ${pct(row.irrPct)}`,
        { size: 10, gap: 0 },
      );
    }
    write("Paid out is carry, servicing and process costs after the bid. Timelines and costs are desk estimates, not legal advice.", {
      size: 9,
      color: soft,
    });
  }
  page.drawText(`Desk model${input.demo ? " for a fictional file" : ""}. Not an appraisal and not legal advice.`, { x: 48, y: 36, size: 9, font, color: soft });
  return Buffer.from(await pdf.save());
}
