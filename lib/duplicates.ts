import type { ListingStatus } from "@prisma/client";
import { notifyDesk } from "@/lib/email";
import { prisma } from "@/lib/prisma";

// A loan can't be on the book twice: anything in review, live or in contract counts.
export const DUPLICATE_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED", "PENDING"] as const satisfies readonly ListingStatus[];

// The review comment starts with this, and the desk queue looks for it.
export const DUPLICATE_COMMENT = "Possible duplicate";

export type DuplicateReason = "LOAN_NUMBER" | "STREET_ZIP_UPB" | "STREET_CITY";

export const DUPLICATE_REASONS: Record<DuplicateReason, string> = {
  LOAN_NUMBER: "same loan number and servicer",
  STREET_ZIP_UPB: "same street and ZIP, UPB within 1%",
  STREET_CITY: "same street and city",
};

export type DuplicateKeys = { loan: string | null; streetZip: string | null; streetCity: string | null; upb: number };

export type DuplicateMatch = {
  // The loan on the listing being checked.
  noteId: string;
  reason: DuplicateReason;
  listing: { id: string; title: string; status: ListingStatus };
  note: { id: string; city: string; state: string; upb: number };
  seller: { id: string; name: string };
};

type KeyedNote = {
  streetAddress: string;
  city: string;
  state: string;
  zip?: string | null;
  upb: number;
  loanNumber?: string | null;
  servicerName?: string | null;
};

const STREET_WORDS: Record<string, string> = {
  street: "st", str: "st", avenue: "ave", av: "ave", road: "rd", drive: "dr", lane: "ln", court: "ct", boulevard: "blvd",
  place: "pl", terrace: "ter", circle: "cir", highway: "hwy", parkway: "pkwy", trail: "trl", square: "sq", point: "pt",
  north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
  apartment: "unit", apt: "unit", suite: "unit", ste: "unit", no: "unit",
};

const CITY_WORDS: Record<string, string> = { saint: "st", fort: "ft", mount: "mt" };

const SERVICER_NOISE = new Set([
  "the", "llc", "inc", "corp", "corporation", "co", "company", "ltd", "lp", "llp", "na", "servicing", "services", "service", "loan", "mortgage",
]);

function words(text: string, map: Record<string, string>) {
  return text
    .toLowerCase()
    .replace(/#/g, " unit ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => map[word] ?? word);
}

// "123 Main Street, Apt #4" and "123 MAIN ST UNIT 4" are one address. A street without a number, such as the
// "Not provided on tape" placeholder, can't identify a loan.
function streetKey(street: string) {
  const text = words(street, STREET_WORDS).join(" ").replace(/\bunit( unit)+\b/g, "unit");
  return /\d/.test(text) && text.length >= 4 ? text : null;
}

function cityKey(city: string) {
  return words(city, CITY_WORDS).join("") || null;
}

// Servicers pad loan numbers with zeros and dashes differently, and the same servicer appears with and without "LLC".
function loanKey(loanNumber: string | null | undefined) {
  const key = (loanNumber ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^0+(?=.)/, "");
  return key.length >= 3 ? key : null;
}

function servicerKey(servicer: string | null | undefined) {
  const all = words(servicer ?? "", {});
  const kept = all.filter((word) => !SERVICER_NOISE.has(word));
  return (kept.length ? kept : all).join("") || null;
}

export function duplicateKeys(note: KeyedNote): DuplicateKeys {
  const street = streetKey(note.streetAddress);
  const zip = (note.zip ?? "").replace(/\D/g, "").slice(0, 5);
  const city = cityKey(note.city);
  const loan = loanKey(note.loanNumber);
  const servicer = servicerKey(note.servicerName);
  return {
    loan: loan && servicer ? `${loan}|${servicer}` : null,
    streetZip: street && zip.length === 5 ? `${street}|${zip}` : null,
    streetCity: street && city ? `${street}|${city}|${note.state.trim().toUpperCase()}` : null,
    upb: Number(note.upb) || 0,
  };
}

function withinOnePercent(a: number, b: number) {
  return a > 0 && b > 0 && Math.abs(a - b) <= 0.01 * Math.max(a, b);
}

const NOTE_FIELDS = {
  id: true,
  listingId: true,
  streetAddress: true,
  city: true,
  state: true,
  zip: true,
  upb: true,
  loanNumber: true,
  servicerName: true,
} as const;

// Loans on other listings in review, live or in contract that look like this listing's loans. A loan already sold
// out of a pool isn't counted on either side: its new owner relisting it is a resale, not a duplicate.
export async function duplicatesFor(listingId: string): Promise<DuplicateMatch[]> {
  const notes = await prisma.note.findMany({ where: { listingId, tradeStatus: { not: "SOLD" } }, select: NOTE_FIELDS });
  if (!notes.length) return [];
  const others = await prisma.listing.findMany({
    where: { id: { not: listingId }, status: { in: [...DUPLICATE_STATUSES] } },
    select: { id: true, title: true, status: true, seller: { select: { id: true, name: true, companyName: true } } },
  });
  if (!others.length) return [];
  const unique = (items: (string | null | undefined)[]) => [...new Set(items.map((item) => item?.trim() ?? "").filter(Boolean))];
  const zips = unique(notes.map((note) => note.zip.replace(/\D/g, "").slice(0, 5))).filter((zip) => zip.length === 5);
  const cities = unique(notes.map((note) => note.city));
  // As typed, and without dashes or padding, since servicers write the same number both ways.
  const loanNumbers = unique(notes.flatMap((note) => [note.loanNumber, note.loanNumber?.replace(/[^A-Za-z0-9]/g, ""), loanKey(note.loanNumber)]));
  // The database narrows to loans sharing a ZIP, city or loan number. The keys below decide what matches.
  const near = [
    zips.length ? { zip: { in: zips } } : null,
    cities.length ? { city: { in: cities, mode: "insensitive" as const } } : null,
    loanNumbers.length ? { loanNumber: { in: loanNumbers, mode: "insensitive" as const } } : null,
  ].filter((filter) => filter != null);
  if (!near.length) return [];
  const candidates = await prisma.note.findMany({
    where: { listingId: { in: others.map((listing) => listing.id) }, tradeStatus: { not: "SOLD" }, OR: near },
    select: NOTE_FIELDS,
  });
  if (!candidates.length) return [];

  type Candidate = (typeof candidates)[number] & { keys: DuplicateKeys };
  const byLoan = new Map<string, Candidate[]>();
  const byStreetZip = new Map<string, Candidate[]>();
  const byStreetCity = new Map<string, Candidate[]>();
  const add = (index: Map<string, Candidate[]>, key: string | null, candidate: Candidate) => {
    if (key) index.set(key, [...(index.get(key) ?? []), candidate]);
  };
  for (const row of candidates) {
    const candidate = { ...row, keys: duplicateKeys(row) };
    add(byLoan, candidate.keys.loan, candidate);
    add(byStreetZip, candidate.keys.streetZip, candidate);
    add(byStreetCity, candidate.keys.streetCity, candidate);
  }

  const listings = new Map(others.map((listing) => [listing.id, listing]));
  const matches: DuplicateMatch[] = [];
  for (const note of notes) {
    const keys = duplicateKeys(note);
    const seen = new Set<string>();
    // Each pair of loans is reported once, under the strongest reason.
    const take = (found: Candidate[] | undefined, reason: DuplicateReason, fits: (candidate: Candidate) => boolean = () => true) => {
      for (const candidate of found ?? []) {
        if (seen.has(candidate.id) || !fits(candidate)) continue;
        seen.add(candidate.id);
        const listing = listings.get(candidate.listingId)!;
        matches.push({
          noteId: note.id,
          reason,
          listing: { id: listing.id, title: listing.title, status: listing.status },
          note: { id: candidate.id, city: candidate.city, state: candidate.state, upb: Number(candidate.upb) },
          seller: { id: listing.seller.id, name: listing.seller.companyName || listing.seller.name },
        });
      }
    };
    if (keys.loan) take(byLoan.get(keys.loan), "LOAN_NUMBER");
    if (keys.streetZip) take(byStreetZip.get(keys.streetZip), "STREET_ZIP_UPB", (candidate) => withinOnePercent(keys.upb, candidate.keys.upb));
    if (keys.streetCity) take(byStreetCity.get(keys.streetCity), "STREET_CITY");
  }
  return matches;
}

// Run when a note or pool is submitted. A match never blocks the seller, since a relist of the same loan is
// legitimate; the desk hears about it and decides. Sellers read every review comment, so the comment names no other
// listing or seller, and the desk email carries the detail.
export async function flagDuplicates(listingId: string, authorId: string) {
  try {
    const matches = await duplicatesFor(listingId);
    if (!matches.length) return matches;
    const loans = new Set(matches.map((match) => match.noteId)).size;
    const listings = new Set(matches.map((match) => match.listing.id)).size;
    const reasons = [...new Set(matches.map((match) => DUPLICATE_REASONS[match.reason]))].join("; ");
    const subject = loans === 1 ? "One loan looks" : `${loans} loans look`;
    const where = listings === 1 ? "a loan on another listing" : `loans on ${listings} other listings`;
    await prisma.reviewComment.create({
      data: {
        listingId,
        authorId,
        action: "COMMENT",
        comment: `${DUPLICATE_COMMENT}, flagged automatically. ${subject} like ${where} (${reasons}). The desk will compare them before release. Nothing is needed from the seller.`,
      },
    });
    const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { title: true } });
    const app = process.env.NEXT_PUBLIC_APP_URL || "";
    const lines = matches.slice(0, 10).map(
      (match) =>
        `${match.note.city}, ${match.note.state}, UPB $${Math.round(match.note.upb).toLocaleString("en-US")}: ${DUPLICATE_REASONS[match.reason]}. ` +
        `On ${match.listing.title} (${match.listing.status.toLowerCase().replaceAll("_", " ")}) from ${match.seller.name}. ${app}/admin/listings/${match.listing.id}`,
    );
    const more = matches.length > 10 ? `\nAnd ${matches.length - 10} more.` : "";
    await notifyDesk(
      `${DUPLICATE_COMMENT} · ${listing?.title ?? "New listing"}`,
      `${subject} like ${where}. The seller was not blocked.\n\n${lines.join("\n")}${more}\n\nReview: ${app}/admin/listings/${listingId}`,
    );
    return matches;
  } catch (error) {
    console.error("[upb-duplicates] check failed:", error);
    return [];
  }
}
