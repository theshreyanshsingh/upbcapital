import type { Prisma } from "@prisma/client";
import { unset } from "@/lib/db-filters";
import { prettyDate } from "@/lib/format";

// Listing provenance and freshness: the seller's statement that a listing's loans are theirs to sell, and its word
// that they are still for sale. These rules are pure, so the filing forms, the book, the gates and the seller's and
// desk's pages read the same ones. The reminder and pause job, and what reconfirming writes, are in lib/provenance.ts.

// The wording's version, stored with each statement. A change to the wording is a new version and a new entry in
// TEXTS, so the desk can still read what an earlier seller agreed to.
export const PROVENANCE_VERSION = "2026-11";

// A seller speaks for its own loans. A broker speaks to the note holder's mandate and the holder's own statement.
export type StatementKind = "SELLER" | "BROKER";

const TEXTS: Record<string, Record<StatementKind, string>> = {
  [PROVENANCE_VERSION]: {
    // Counsel: the seller's representation at filing, and the promise to withdraw.
    SELLER:
      "I own these loans, or hold the owner's written mandate to sell them. They are not pledged, sold, under contract or listed anywhere else on terms that would stop this sale. If that changes, I will withdraw this listing.",
    // Counsel: the broker's representation for a client's loans.
    BROKER:
      "I hold the note holder's signed mandate to sell these loans, and the holder's written statement that they own them and that they are not pledged, sold, under contract or listed anywhere else on terms that would stop this sale. If that changes, I will withdraw this listing.",
  },
};

// Under every checkbox. Counsel: whether the desk may rely on it as a representation.
export const STATEMENT_NOTE = "The desk relies on this statement. The wording is UPB's draft, and counsel confirms it.";

export const STATEMENT_MISSING_TEXT = "Tick the ownership statement to send this to the desk.";
export const STATEMENT_CHANGED_TEXT = "The ownership statement's wording changed. Reload the page, read it again and tick it.";

// The words of one version, or null for a version this desk no longer knows.
export function statementText(kind: StatementKind, version: string | null | undefined = PROVENANCE_VERSION) {
  return (version && TEXTS[version]?.[kind]) || null;
}

// A broker files as the seller of record for the note holder, so a listing with a broker carries the broker's words.
export function statementKind(listing: { brokerId?: string | null }): StatementKind {
  return listing.brokerId ? "BROKER" : "SELLER";
}

// Why a form's statement doesn't count, or null when it does. The checkbox sends the version it showed, so a page
// left open across a change in wording is asked again rather than recorded against words it never showed.
export function statementProblem(value: unknown) {
  if (value === PROVENANCE_VERSION) return null;
  return typeof value === "string" && value.trim() ? STATEMENT_CHANGED_TEXT : STATEMENT_MISSING_TEXT;
}

// ---------------------------------------------------------------------------------------------------------------
// Freshness

type Fresh = { status?: string; approvedAt?: Date | null; availableConfirmedAt?: Date | null; stalePausedAt?: Date | null };

// A live listing held off the book until its seller confirms the loans are still for sale. Only an approved listing
// is held: one that went into contract on a bid it already had shows as in contract.
export function stalePaused(listing: Fresh) {
  return listing.status === "APPROVED" && Boolean(listing.stalePausedAt);
}

// The same rule as a where-fragment, for listing queries. Merge it with AND.
export function notStalePaused(): Prisma.ListingWhereInput {
  return { OR: [...unset("stalePausedAt").OR, { status: { not: "APPROVED" } }] };
}

// When the seller last stood behind the listing: their latest confirmation, or the approval for one never reconfirmed.
// A listing approved again after changes counts from that approval, since the seller just resubmitted it.
export function availableSince(listing: Fresh) {
  const confirmed = listing.availableConfirmedAt ?? null;
  const approved = listing.approvedAt ?? null;
  if (!confirmed || !approved) return confirmed ?? approved;
  return confirmed.getTime() > approved.getTime() ? confirmed : approved;
}

// A reminder that asked about the current stretch, not one sent before the seller's last word or a later approval.
export function remindedSince(listing: Fresh & { availabilityRemindedAt?: Date | null }) {
  const since = availableSince(listing);
  const reminded = listing.availabilityRemindedAt ?? null;
  return reminded && (!since || reminded.getTime() >= since.getTime()) ? reminded : null;
}

// The line buyers read on a live listing, or null when there is nothing to say.
export function availabilityLine(listing: Fresh) {
  if (stalePaused(listing)) {
    return { paused: true, text: `Paused ${prettyDate(listing.stalePausedAt)}. The seller hasn't confirmed these loans are still available, so the listing takes no new bids. Bids already in stay open.` };
  }
  const since = listing.status === "APPROVED" ? availableSince(listing) : null;
  return since ? { paused: false, text: `Confirmed available ${prettyDate(since)}` } : null;
}
