import { degrees, PDFDocument, rgb, StandardFonts } from "pdf-lib";

// A buyer's copy of a data-room PDF carries their name on every page, so a file that leaks says whose copy it was.
// Only PDFs are stamped. Images and spreadsheets go out as stored, and a PDF that won't parse goes out unstamped
// rather than not at all.

export function watermarkLine(holder: string, at = new Date()) {
  const day = at.toISOString().slice(0, 10);
  const name = holder.replace(/\s+/g, " ").trim().slice(0, 80) || "Buyer";
  return `Confidential · ${name} · ${day} · UPB Capital`;
}

export function isPdf(document: { mime: string; originalName: string }, bytes?: Uint8Array) {
  if (document.mime === "application/pdf" || /\.pdf$/i.test(document.originalName)) return true;
  // A PDF stored under another type still starts with its signature.
  return Boolean(bytes && bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);
}

// The standard fonts carry only Latin-1, so anything else in a name becomes a plain question mark instead of an error.
function printable(text: string) {
  return text.replace(/[^\x20-\x7E -ÿ]/g, "?");
}

// Returns the stamped PDF, or null when the bytes don't parse as one (encrypted, damaged, or not a PDF).
export async function watermarkPdf(bytes: Uint8Array, line: string) {
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    return null;
  }
  try {
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const text = printable(line);
    for (const page of pdf.getPages()) {
      // The visible box, which on a scan can sit away from the origin.
      const { x: left, y: bottom, width, height } = page.getCropBox();
      // Across the middle, light enough to read through.
      const diagonal = Math.hypot(width, height);
      const size = Math.max(10, Math.min(36, (diagonal * 0.8) / Math.max(1, font.widthOfTextAtSize(text, 1))));
      const span = font.widthOfTextAtSize(text, size);
      const angle = Math.atan2(height, width);
      page.drawText(text, {
        x: left + width / 2 - (Math.cos(angle) * span) / 2,
        y: bottom + height / 2 - (Math.sin(angle) * span) / 2,
        size,
        font,
        color: rgb(0.5, 0.5, 0.5),
        opacity: 0.14,
        rotate: degrees((angle * 180) / Math.PI),
      });
      // And a footer line that reads plainly on a printout.
      const footer = Math.min(8, Math.max(5, width / 80));
      page.drawText(text, {
        x: left + Math.max(12, (width - font.widthOfTextAtSize(text, footer)) / 2),
        y: bottom + 12,
        size: footer,
        font,
        color: rgb(0.35, 0.35, 0.35),
        opacity: 0.7,
      });
    }
    return Buffer.from(await pdf.save());
  } catch {
    return null;
  }
}

// What a bidder downloads: a stamped PDF, or the stored bytes for anything else. Photos go out as taken. `failed`
// says a PDF didn't parse and went out unstamped, so the caller can log it.
export async function bidderCopy<B extends Uint8Array>(document: { type: string; mime: string; originalName: string }, bytes: B, holder: string, at = new Date()) {
  if (document.type === "PHOTO" || !isPdf(document, bytes)) return { bytes: bytes as B | Buffer, stamped: false, failed: false };
  const stamped = await watermarkPdf(bytes, watermarkLine(holder, at));
  return stamped ? { bytes: stamped as B | Buffer, stamped: true, failed: false } : { bytes: bytes as B | Buffer, stamped: false, failed: true };
}
