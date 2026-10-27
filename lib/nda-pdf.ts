import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { NDA_TERMS } from "@/lib/nda-terms";

export type NdaPdfInput = {
  listingTitle: string;
  listingId: string;
  signerName: string;
  signerEmail: string;
  method: "TYPED" | "DRAWN";
  signedAt: Date;
  ipAddress: string;
  userAgent: string;
  signaturePng?: Buffer | null;
};

export function pngFromDataUrl(dataUrl: string) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim());
  if (!match) return null;
  const bytes = Buffer.from(match[1].replace(/\s/g, ""), "base64");
  if (bytes.length < 32 || bytes.length > 1_500_000) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  return bytes;
}

function wrap(text: string, width: number) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > width) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export async function buildNdaPdf(input: NdaPdfInput) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const serif = await pdf.embedFont(StandardFonts.TimesRoman);
  const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const gold = rgb(0.776, 0.643, 0.431);
  const ink = rgb(0.12, 0.11, 0.09);
  const mute = rgb(0.4, 0.38, 0.34);

  page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: rgb(0.03, 0.03, 0.04) });
  page.drawText("UPB CAPITAL", { x: 48, y: 762, size: 11, font: serif, color: gold });
  page.drawText("Confidentiality agreement", { x: 48, y: 690, size: 26, font: serif, color: ink });
  page.drawText(input.listingTitle.slice(0, 90), { x: 48, y: 662, size: 12, font: italic, color: mute });

  const facts = [
    `Listing  ${input.listingId}`,
    `Signer   ${input.signerName}  <${input.signerEmail}>`,
    `Method   ${input.method === "DRAWN" ? "Drawn signature" : "Typed signature"}`,
    `Signed   ${input.signedAt.toISOString()}`,
    `Address  ${input.ipAddress || "unavailable"}`,
    `Agent    ${input.userAgent.slice(0, 110) || "unavailable"}`,
  ];
  facts.forEach((line, index) => {
    page.drawText(line, { x: 48, y: 620 - index * 18, size: 10, font: serif, color: ink });
  });

  let y = 490;
  page.drawText("Terms", { x: 48, y, size: 12, font: serif, color: gold });
  y -= 22;
  for (const line of wrap(NDA_TERMS, 88)) {
    page.drawText(line, { x: 48, y, size: 11, font: serif, color: ink });
    y -= 16;
  }

  y -= 20;
  page.drawText("Signature", { x: 48, y, size: 12, font: serif, color: gold });
  y -= 16;
  if (input.method === "DRAWN" && input.signaturePng) {
    const image = await pdf.embedPng(input.signaturePng);
    const scale = Math.min(220 / image.width, 70 / image.height, 1);
    page.drawImage(image, { x: 48, y: y - image.height * scale, width: image.width * scale, height: image.height * scale });
  } else {
    page.drawText(input.signerName, { x: 48, y: y - 28, size: 22, font: italic, color: ink });
  }
  page.drawText("Fictional demo instrument. Not legal advice.", { x: 48, y: 36, size: 9, font: serif, color: mute });
  return Buffer.from(await pdf.save());
}
