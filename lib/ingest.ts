import { flagDuplicates } from "@/lib/duplicates";
import { notifyDesk } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { rescoreListing } from "@/lib/matching";
import { screenInBackground, screenListing } from "@/lib/screening";
import { putBytes } from "@/lib/storage";
import { parseTapeBuffer, normalizeTapeRows } from "@/lib/tape";
import { suggestMapping } from "@/lib/tape-fields";

// The same limits as a tape uploaded in the app, so the API isn't a way around them.
const MAX_TAPE_BYTES = 10 * 1024 * 1024;
const MAX_LOANS = 2000;

export async function ingestTape(input: { sellerId: string; title: unknown; summary?: unknown; csv: unknown }) {
  if (typeof input.title !== "string" || typeof input.csv !== "string" || (input.summary != null && typeof input.summary !== "string")) {
    return { error: "Send title, csv and summary as text." as const };
  }
  const title = input.title.trim().slice(0, 140);
  if (title.length < 3) return { error: "Name the pool." as const };
  const bytes = Buffer.from(input.csv);
  if (bytes.length > MAX_TAPE_BYTES) return { error: "Tapes are limited to 10 MB." as const };
  const matrix = parseTapeBuffer(bytes, "tape.csv");
  // Header aliases cover the servicing columns too, so an API tape carries the same record as an uploaded one.
  const mapping = suggestMapping(matrix.headers);
  const { loans, errors } = normalizeTapeRows({ rows: matrix.rows, mapping, priceMode: "COLUMN" });
  if (errors.length) return { error: errors.slice(0, 4).map((issue) => (issue.row ? `Row ${issue.row}: ${issue.message}.` : issue.message)).join(" ") };
  if (!loans.length) return { error: "The tape had no loans." as const };
  if (loans.length > MAX_LOANS) return { error: "Tapes are limited to 2,000 loans in this desk." as const };
  const listing = await prisma.listing.create({
    data: {
      kind: "POOL",
      sellerId: input.sellerId,
      status: "SUBMITTED",
      title,
      summary: input.summary?.trim() || "Pushed through the seller API.",
      notes: { create: loans },
    },
  });
  // Buyers and the desk get the source file, as they do for an uploaded tape.
  const storedName = `${crypto.randomUUID()}-tape.csv`;
  await putBytes(storedName, bytes, "text/csv");
  await prisma.document.create({
    data: { listingId: listing.id, type: "TAPE", originalName: "tape.csv", storedName, mime: "text/csv", size: bytes.length },
  });
  await notifyDesk(`API tape · ${title}`, `${loans.length} loans arrived through the seller API.`);
  await flagDuplicates(listing.id, input.sellerId);
  screenInBackground(() => screenListing(listing.id, input.sellerId));
  await rescoreListing(listing.id, false);
  return { listingId: listing.id, loans: loans.length };
}
