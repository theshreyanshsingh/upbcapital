import { notifyDesk } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { rescoreListing } from "@/lib/matching";
import { parseTapeBuffer, normalizeTapeRows } from "@/lib/tape";
import { suggestMapping } from "@/lib/tape-fields";

export async function ingestTape(input: { sellerId: string; title: string; summary?: string; csv: string }) {
  const title = input.title.trim();
  if (title.length < 3) return { error: "Name the pool." as const };
  const matrix = parseTapeBuffer(Buffer.from(input.csv), "tape.csv");
  const mapping = suggestMapping(matrix.headers);
  const { loans, errors } = normalizeTapeRows({ rows: matrix.rows, mapping, priceMode: "COLUMN" });
  if (errors.length) return { error: errors.slice(0, 4).map((issue) => issue.message).join(" ") };
  if (!loans.length) return { error: "The tape had no loans." as const };
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
  await notifyDesk(`API tape · ${title}`, `${loans.length} loans arrived through the seller API.`);
  await rescoreListing(listing.id, false);
  return { listingId: listing.id, loans: loans.length };
}
