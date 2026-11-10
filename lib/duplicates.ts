import type { ListingStatus } from "@prisma/client";
import { audit } from "@/lib/audit";
import { notifyDesk } from "@/lib/email";
import { deskDecisionAllowed } from "@/lib/listing-status";
import type { Outcome } from "@/lib/loan-file";
import { prisma } from "@/lib/prisma";
import { deskCan, DESK_DENIED, type Staff } from "@/lib/staff";

// A loan can't be on the book twice: anything in review, live or in contract counts.
export const DUPLICATE_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED", "PENDING"] as const satisfies readonly ListingStatus[];

// The review comment starts with this, and the desk queue looks for it.
export const DUPLICATE_COMMENT = "Possible duplicate";

// Strongest first: a pair of loans is reported once, under the first reason that matches.
export type DuplicateReason = "MIN" | "LOAN_NUMBER" | "STREET_ZIP_UPB" | "STREET_CITY" | "BORROWER_ZIP";

export const DUPLICATE_REASONS: Record<DuplicateReason, string> = {
  MIN: "same MERS MIN",
  LOAN_NUMBER: "same loan number and servicer",
  STREET_ZIP_UPB: "same street and ZIP, UPB within 1%",
  STREET_CITY: "same street and city",
  BORROWER_ZIP: "same borrower name and ZIP",
};

export type DuplicateKeys = {
  min: string | null;
  loan: string | null;
  streetZip: string | null;
  streetCity: string | null;
  borrowerZip: string | null;
  upb: number;
};

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
  mersMin?: string | null;
  borrowerName?: string | null;
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

// A MIN is issued once and stays with the loan however often it is sold or its servicing moves, so it is the
// strongest key. It is 18 digits; dashes and spaces are formatting, and a run of zeros is a placeholder.
function minKey(min: string | null | undefined) {
  const digits = (min ?? "").replace(/\D/g, "");
  return digits.length === 18 && !/^0+$/.test(digits) ? digits : null;
}

const NAME_NOISE = new Set(["mr", "mrs", "ms", "miss", "dr", "and", "et", "al", "etal", "llc", "inc", "corp", "corporation", "co", "company", "ltd", "lp", "llp"]);
// Words a tape puts where the name would be: "Unknown", "Name withheld", "Not provided on tape", "Borrower 1".
const NAME_PLACEHOLDERS = new Set(["unknown", "none", "na", "tbd", "redacted", "withheld", "name", "borrower", "not", "provided", "on", "tape", "see", "file", "unit"]);

// "SMITH, JOHN A." and "John A Smith" are one borrower: case, punctuation, initials, titles and word order don't
// count. A single word or a placeholder can't identify anyone.
function borrowerKey(name: string | null | undefined) {
  const parts = words((name ?? "").replace(/['’]/g, ""), {}).filter((word) => word.length > 1 && !/^\d+$/.test(word) && !NAME_NOISE.has(word));
  if (parts.length < 2 || parts.every((word) => NAME_PLACEHOLDERS.has(word))) return null;
  return [...new Set(parts)].sort().join(" ");
}

export function duplicateKeys(note: KeyedNote): DuplicateKeys {
  const street = streetKey(note.streetAddress);
  const zip = (note.zip ?? "").replace(/\D/g, "").slice(0, 5);
  const city = cityKey(note.city);
  const loan = loanKey(note.loanNumber);
  const servicer = servicerKey(note.servicerName);
  const borrower = borrowerKey(note.borrowerName);
  return {
    min: minKey(note.mersMin),
    loan: loan && servicer ? `${loan}|${servicer}` : null,
    streetZip: street && zip.length === 5 ? `${street}|${zip}` : null,
    streetCity: street && city ? `${street}|${city}|${note.state.trim().toUpperCase()}` : null,
    // A name alone matches too many people, so it counts only with the property's ZIP. Two loans to one borrower in
    // one ZIP can be two rentals, and the desk clears those once it has compared them.
    borrowerZip: borrower && zip.length === 5 ? `${borrower}|${zip}` : null,
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
  mersMin: true,
  borrowerName: true,
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
  // As typed and as bare digits. Tapes store the digits, but older rows and desk edits may keep the dashes.
  const mins = unique(notes.flatMap((note) => (minKey(note.mersMin) ? [note.mersMin, minKey(note.mersMin)] : [])));
  // As typed. A name spelled another way still comes in through its ZIP, which a name match needs anyway.
  const names = unique(notes.map((note) => (borrowerKey(note.borrowerName) ? note.borrowerName : null)));
  // The database narrows to loans sharing a ZIP, city, loan number, MIN or borrower name. The keys below decide what
  // matches.
  const near = [
    zips.length ? { zip: { in: zips } } : null,
    cities.length ? { city: { in: cities, mode: "insensitive" as const } } : null,
    loanNumbers.length ? { loanNumber: { in: loanNumbers, mode: "insensitive" as const } } : null,
    mins.length ? { mersMin: { in: mins } } : null,
    names.length ? { borrowerName: { in: names, mode: "insensitive" as const } } : null,
  ].filter((filter) => filter != null);
  if (!near.length) return [];
  const candidates = await prisma.note.findMany({
    where: { listingId: { in: others.map((listing) => listing.id) }, tradeStatus: { not: "SOLD" }, OR: near },
    select: NOTE_FIELDS,
  });
  if (!candidates.length) return [];

  type Candidate = (typeof candidates)[number] & { keys: DuplicateKeys };
  const byMin = new Map<string, Candidate[]>();
  const byLoan = new Map<string, Candidate[]>();
  const byStreetZip = new Map<string, Candidate[]>();
  const byStreetCity = new Map<string, Candidate[]>();
  const byBorrowerZip = new Map<string, Candidate[]>();
  const add = (index: Map<string, Candidate[]>, key: string | null, candidate: Candidate) => {
    if (key) index.set(key, [...(index.get(key) ?? []), candidate]);
  };
  for (const row of candidates) {
    const candidate = { ...row, keys: duplicateKeys(row) };
    add(byMin, candidate.keys.min, candidate);
    add(byLoan, candidate.keys.loan, candidate);
    add(byStreetZip, candidate.keys.streetZip, candidate);
    add(byStreetCity, candidate.keys.streetCity, candidate);
    add(byBorrowerZip, candidate.keys.borrowerZip, candidate);
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
    if (keys.min) take(byMin.get(keys.min), "MIN");
    if (keys.loan) take(byLoan.get(keys.loan), "LOAN_NUMBER");
    if (keys.streetZip) take(byStreetZip.get(keys.streetZip), "STREET_ZIP_UPB", (candidate) => withinOnePercent(keys.upb, candidate.keys.upb));
    if (keys.streetCity) take(byStreetCity.get(keys.streetCity), "STREET_CITY");
    if (keys.borrowerZip) take(byBorrowerZip.get(keys.borrowerZip), "BORROWER_ZIP");
  }
  return matches;
}

// ---------------------------------------------------------------------------------------------------------------
// The approval hold. A match holds the desk's approval, never the seller's filing: a relist of the same loan is
// legitimate, so the seller submits as before and the desk compares the loans and clears the match with a note.
//
// A clearance stands for the listing until what identifies one of its loans changes. Every path that changes it (a
// filing, a seller's edit, an answered tape difference, a servicer report) runs flagDuplicates again, and that lifts
// the clearance, since the desk compared the loans as they were. The desk compares again even when the matches are
// the same ones, which is simpler and safer than tracking which pairs it saw. A listing filed later that matches this
// one is held on its own review.

export const DUPLICATE_HOLD =
  "A loan on this listing looks like one on another open listing. Approval waits until the desk compares them and clears the match with a note.";

export function duplicateGateMessage(matches: number, clearedAt: Date | null | undefined) {
  return matches > 0 && !clearedAt ? DUPLICATE_HOLD : null;
}

// What stops an approval, in words, or null when nothing does.
export async function duplicateHold(listingId: string) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { duplicateClearedAt: true } });
  if (!listing || listing.duplicateClearedAt) return null;
  return duplicateGateMessage((await duplicatesFor(listingId)).length, null);
}

const fail = (error: string): Outcome<never> => ({ ok: false, error });
const clean = (text: string | null | undefined, max: number) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// Listing review is the sales side's, so clearing a match is too. The note says what the desk compared. It stays on
// the desk's side: sellers never read it, since it may name the other listing.
export async function clearDuplicates(actor: Staff & { id: string }, input: { listingId: string; note: string; now?: Date }): Promise<Outcome<{ matches: number }>> {
  if (actor.role !== "ADMIN" || !deskCan(actor, "sales")) return fail(DESK_DENIED);
  const note = clean(input.note, 500);
  if (note.length < 3) return fail("Say what the desk compared and why both loans may stand.");
  const listing = await prisma.listing.findUnique({ where: { id: input.listingId }, select: { id: true, status: true, duplicateClearedAt: true } });
  if (!listing) return fail("That listing isn't on file.");
  if (!deskDecisionAllowed("APPROVE", listing.status)) return fail("A match is cleared before the listing is approved.");
  if (listing.duplicateClearedAt) return fail("The match is already cleared.");
  const matches = await duplicatesFor(listing.id);
  if (!matches.length) return fail("No loan on this listing matches another open listing now.");
  await prisma.listing.update({ where: { id: listing.id }, data: { duplicateClearedAt: input.now ?? new Date(), duplicateClearedById: actor.id, duplicateClearNote: note } });
  const compared = [...new Set(matches.map((match) => match.listing.id))];
  const reasons = [...new Set(matches.map((match) => DUPLICATE_REASONS[match.reason]))].join("; ");
  await audit(actor.id, "DUPLICATE_CLEARED", "listing", listing.id, `${matches.length === 1 ? "1 match" : `${matches.length} matches`} with ${compared.join(", ")} (${reasons}) · ${note}`);
  return { ok: true, value: { matches: matches.length } };
}

// Run when a note or pool is submitted, and again when what identifies a loan changes. A match never blocks the
// seller, since a relist of the same loan is legitimate, but it holds approval until the desk compares the loans.
// Sellers read every review comment, so the comment names no other listing or seller, and the desk email carries the
// detail.
export async function flagDuplicates(listingId: string, authorId: string) {
  try {
    const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { title: true, duplicateClearedAt: true } });
    // The loans changed since the desk cleared them, so a clearance no longer covers them. See the hold above.
    const lifted = Boolean(listing?.duplicateClearedAt);
    if (lifted) {
      await prisma.listing.update({ where: { id: listingId }, data: { duplicateClearedAt: null, duplicateClearedById: null, duplicateClearNote: null } });
      await audit(authorId, "DUPLICATE_CLEARANCE_LIFTED", "listing", listingId, "What identifies a loan changed, so the duplicate check runs again.");
    }
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
        comment: `${DUPLICATE_COMMENT}, flagged automatically. ${subject} like ${where} (${reasons}). Approval waits until the desk compares them. Nothing is needed from the seller unless the desk asks.`,
      },
    });
    const app = process.env.NEXT_PUBLIC_APP_URL || "";
    const lines = matches.slice(0, 10).map(
      (match) =>
        `${match.note.city}, ${match.note.state}, UPB $${Math.round(match.note.upb).toLocaleString("en-US")}: ${DUPLICATE_REASONS[match.reason]}. ` +
        `On ${match.listing.title} (${match.listing.status.toLowerCase().replaceAll("_", " ")}) from ${match.seller.name}. ${app}/admin/listings/${match.listing.id}`,
    );
    const more = matches.length > 10 ? `\nAnd ${matches.length - 10} more.` : "";
    const again = lifted ? " The earlier clearance is lifted, since what identifies a loan changed." : "";
    await notifyDesk(
      `${DUPLICATE_COMMENT} · ${listing?.title ?? "New listing"}`,
      `${subject} like ${where}. The seller could still submit, since a relist of the same loan can be legitimate. Approval waits until the desk compares the loans and clears the match with a note.${again}\n\n${lines.join("\n")}${more}\n\nReview: ${app}/admin/listings/${listingId}`,
    );
    return matches;
  } catch (error) {
    console.error("[upb-duplicates] check failed:", error);
    return [];
  }
}
