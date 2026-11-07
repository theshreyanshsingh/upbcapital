import { prettyDate } from "@/lib/format";
import { labelOf } from "@/lib/labels";
import { upbBucket } from "@/lib/strata";

// Coming soon. The desk can approve a listing with a launch time, so demand builds before the room opens: until then
// it shows on the book as a teaser buyers can save, and nothing that trades or opens the file runs. These rules are
// pure, so the book, the gates and the offer panel read the same ones. The job that opens a listing at its time is in
// lib/launch.ts.

const DAY = 24 * 60 * 60 * 1000;
// Far enough out to market a sale, near enough that the file on the book is still the file at launch.
export const MAX_LAUNCH_DAYS = 90;

type Launchable = { launchAt?: Date | null } | null | undefined;

// True while an approved listing waits for its launch time. A listing with no launch time went live on approval.
export function launchPending(listing: Launchable, now = new Date()) {
  return Boolean(listing?.launchAt && listing.launchAt.getTime() > now.getTime());
}

// A launch time as the desk prints every deadline: in UTC, with the time.
export function launchTime(at: Date) {
  return `${prettyDate(at)}, ${at.toISOString().slice(11, 16)} UTC`;
}

export type LaunchGate = "inquiry" | "bid" | "buyNow" | "nda" | "room" | "event" | "invite";

const OPENS: Record<LaunchGate, string> = {
  inquiry: "Bids and requests open",
  bid: "Bids open",
  buyNow: "Buy it now opens",
  nda: "The confidentiality agreement opens",
  room: "The data room opens",
  event: "It can join a sale event",
  invite: "Standing-bid invites open",
};

// Why this step waits for the launch, or null once the listing is live.
export function launchBlock(listing: Launchable, gate: LaunchGate, now = new Date()) {
  if (!listing?.launchAt || !launchPending(listing, now)) return null;
  return `This listing is coming soon. ${OPENS[gate]} when it goes live on ${launchTime(listing.launchAt)}.`;
}

// The approval form's launch field, a datetime-local read as UTC like the bid deadline. Blank means live now.
export function readLaunchAt(raw: string, now = new Date()): { at: Date | null; error: string | null } {
  const value = raw.trim();
  if (!value) return { at: null, error: null };
  const at = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? new Date(`${value}:00Z`) : null;
  if (!at || Number.isNaN(at.getTime())) return { at: null, error: "Enter the launch date and time." };
  if (at.getTime() <= now.getTime()) return { at: null, error: "Set a launch time in the future, or leave it blank to go live now." };
  if (at.getTime() > now.getTime() + MAX_LAUNCH_DAYS * DAY) return { at: null, error: `Set a launch time within ${MAX_LAUNCH_DAYS} days.` };
  return { at, error: null };
}

// What approval writes. approvedAt is the moment the listing goes live, so the Pro early-access window, saved-search
// roundups and the book's newest-first order all count from the launch. The approval itself stays in the review log.
export function approvalFields(at: Date | null, now = new Date()) {
  return at ? { approvedAt: at, launchAt: at, launchNotifiedAt: null } : { approvedAt: now, launchAt: null };
}

type TeaserLoan = { state: string; lienPosition: string; paymentStatus: string; upb: number | { toString(): string } };

export type ComingSoonCard = {
  id: string;
  title: string;
  kind: string;
  states: string;
  lien: string;
  performance: string;
  loanCount: number;
  upbBand: string;
  launchAt: string;
  launchLabel: string;
};

function shared(values: string[], kind: "lien" | "payment") {
  const unique = [...new Set(values)];
  return unique.length === 1 ? labelOf(kind, unique[0]) : "Mixed";
}

// The teaser a coming-soon listing shows on the book: the facts a buyer screens on, a band for the balance and the
// launch time. No ask, no city or street, no borrower: those wait for the launch and the NDA as on any listing.
export function comingSoonCard(listing: { id: string; title: string; kind: string; launchAt: Date; notes: TeaserLoan[] }): ComingSoonCard {
  const states = [...new Set(listing.notes.map((note) => note.state))].sort();
  const upb = listing.notes.reduce((sum, note) => sum + Number(note.upb), 0);
  return {
    id: listing.id,
    title: listing.title,
    kind: listing.kind,
    states: states.length > 3 ? `${states.slice(0, 3).join(", ")} +${states.length - 3}` : states.join(", "),
    lien: shared(listing.notes.map((note) => note.lienPosition), "lien"),
    performance: shared(listing.notes.map((note) => note.paymentStatus), "payment"),
    loanCount: listing.notes.length,
    upbBand: upbBucket(upb),
    launchAt: listing.launchAt.toISOString(),
    launchLabel: launchTime(listing.launchAt),
  };
}
