import { createHash } from "node:crypto";
import { loanOpenTo, ndaOpensRoom } from "@/lib/acl";
import { audit } from "@/lib/audit";
import { closingLoans } from "@/lib/closing";
import { covenantScheduleText } from "@/lib/closing-docs";
import { dealAccess } from "@/lib/data-room";
import { namesBorrower as namesBorrowerIn } from "@/lib/covenant-text";
import { fieldState, LOAN_FIELDS } from "@/lib/loan-file";
import { prisma } from "@/lib/prisma";

// Servicing covenants that pass with the loans from an earlier sale: an agency sale's servicing standard, a
// loss-mitigation waterfall, a foreclosure timeline or an occupancy rule. The tape carries them as free text in
// Note.inheritedCovenants, as the seller states them. A buyer reads them on the listing, acknowledges them in the bid
// form, and the purchase agreement carries them as a schedule with the acknowledgement's date.
//
// Changes after an acknowledgement. Note has no updatedAt, and the text can change on a live listing by more than one
// path (a servicer's report fills it, the desk fixes it to a document), so there is no timestamp to compare the
// acknowledgement against. Each acknowledgement's audit row keeps a short hash of the text acknowledged instead, the
// way the ROAD Act acknowledgement keeps its record in the log (lib/inquiry.ts). A different hash now means the text
// changed and the buyer acknowledges it again. Inquiry.covenantsAcknowledgedAt dates the acknowledgement for the
// papers. A counter moves the price, not the covenants, so it asks nothing.

export const COVENANTS_HEADING = "Covenants that pass with these loans";

export const ACK_MISSING = "These loans carry servicing covenants that pass to the buyer. Read them and tick the box before you bid.";
export const ACK_CHANGED = "The covenants on these loans changed since the page loaded. Read them again and tick the box.";
export const ACK_WITHHELD =
  "A covenant on these loans names the borrower, so it shows once the data room opens to you, like the street. Sign the confidentiality agreement, read it, then bid.";
export const SEAT_ACK_STALE = "The covenants that pass with these loans changed after you took your seat. Read them on the listing and acknowledge them again, then reconfirm.";

const ACK_ACTION = "COVENANTS_ACK";

// The fields a covenant check reads: the text, the desk's checks, and the identity fields it is compared against.
export const COVENANT_SELECT = {
  id: true,
  tradeStatus: true,
  inheritedCovenants: true,
  verifiedFields: true,
  city: true,
  state: true,
  zip: true,
  streetAddress: true,
  borrowerName: true,
  loanNumber: true,
  mersMin: true,
  eNoteId: true,
  eRegistryController: true,
  eRegistryLocation: true,
} as const;

type CovenantNote = { id: string; inheritedCovenants?: string | null; verifiedFields?: unknown } & object;

export type LoanCovenant = {
  noteId: string;
  // The loan's place on the listing, from 1, as the pool table numbers it.
  position: number;
  text: string;
  // Desk-verified against a document. Anything else reads as the seller's statement.
  verified: boolean;
  // The text carries one of the loan's identity fields, so it follows the street's rule.
  identifying: boolean;
};

export type ListingCovenants = { loans: LoanCovenant[]; total: number; summary: string | null; hash: string | null };

// Tapes put these where there is nothing to say. They are not covenants.
const NOTHING = new Set(["none", "n a", "na", "no", "nil", "not applicable", "none stated", "no covenants"]);

export function covenantText(value: string | null | undefined) {
  const text = (value ?? "").trim();
  const plain = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return !plain || NOTHING.has(plain) ? "" : text;
}

export function covenantSummary(count: number, total: number) {
  if (!count) return null;
  if (total === 1) return "This loan carries covenants that pass to the buyer.";
  return `${count} of ${total} loans ${count === 1 ? "carries" : "carry"} covenants that pass to the buyer.`;
}

// The text cut to a line or two at a word, for anywhere it isn't being acknowledged.
export function summarizeCovenant(text: string, max = 160) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

// ---------------------------------------------------------------------------------------------------------------
// A text that names the borrower: the rule lives in lib/covenant-text.ts, which the exports share. The loan file's
// identity fields, less the descriptive ones, are what that module looks for; tests/covenants.test.ts checks the two
// lists agree.

const DESCRIPTIVE = new Set(["litigationNote", "originatorLicense"]);
// Read on first use, not when this module loads: lib/awards.ts loads this module, and lib/loan-file.ts can still be
// loading when it does.
let identityFields: string[] | null = null;
export function loanFileIdentityFields() {
  identityFields ??= LOAN_FIELDS.filter((spec) => spec.identity && spec.kind === "text" && !DESCRIPTIVE.has(spec.field)).map((spec) => spec.field);
  return identityFields;
}

export function namesBorrower(text: string, note: object) {
  return namesBorrowerIn(text, note, loanFileIdentityFields());
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the covenants

export function covenantsHash(loans: readonly { noteId: string; text: string }[]) {
  if (!loans.length) return null;
  const body = [...loans]
    .sort((a, b) => (a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0))
    .map((loan) => `${loan.noteId}\n${loan.text}`)
    .join("\n\n");
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

// Each loan's covenants, trimmed, with empty ones left out, and a summary. `scope` limits it to the loans a bid or a
// closing covers; positions stay the listing's.
export function listingCovenants(listing: { notes: readonly CovenantNote[] }, scope?: Iterable<string> | null): ListingCovenants {
  const within = scope ? new Set(scope) : null;
  const loans: LoanCovenant[] = [];
  let total = 0;
  listing.notes.forEach((note, index) => {
    if (within && !within.has(note.id)) return;
    total += 1;
    const text = covenantText(note.inheritedCovenants);
    if (!text) return;
    loans.push({ noteId: note.id, position: index + 1, text, verified: fieldState(note, "inheritedCovenants").state === "verified", identifying: namesBorrower(text, note) });
  });
  return { loans, total, summary: covenantSummary(loans.length, total), hash: covenantsHash(loans) };
}

// What a bid form shows: each loan's covenants in full, and the version the buyer's tick acknowledges. A text withheld
// from this viewer comes through as null with no version, since nobody acknowledges what they can't read.
export type BidCovenants = {
  hash: string | null;
  summary: string;
  loans: { noteId: string; label: string; text: string | null; verified: boolean }[];
};

// The loan as the pool table names it, with the street only once the loan opens to the viewer.
export function covenantLabel(note: { city: string; state: string; streetAddress?: string | null }, position: number, pool: boolean, open: boolean) {
  const place = `${open && note.streetAddress ? `${note.streetAddress}, ` : ""}${note.city}, ${note.state}`;
  return pool ? `Loan ${position} · ${place}` : place;
}

type ViewNote = CovenantNote & { city: string; state: string; streetAddress?: string | null; tradeStatus?: string };

// The listing page's view: every loan's covenants for the section, those withheld from this viewer, and the bid form's
// covenants for a bid on one loan (noteId) or the whole listing (null). It reads the texts once, here, so the page can
// take a withheld text off its notes afterwards.
export function covenantView<T extends ViewNote>(listing: { kind: string; notes: readonly T[] }, open: (note: T) => boolean) {
  const all = listingCovenants(listing);
  const texts = { notes: listing.notes.map((note) => ({ ...note })) };
  const pool = listing.kind === "POOL";
  const byId = new Map(listing.notes.map((note) => [note.id, note]));
  const shown = (noteId: string) => open(byId.get(noteId)!);
  const withheld = new Set(all.loans.filter((loan) => loan.identifying && !shown(loan.noteId)).map((loan) => loan.noteId));
  const rows = all.loans.map((loan) => ({
    noteId: loan.noteId,
    label: covenantLabel(byId.get(loan.noteId)!, loan.position, pool, shown(loan.noteId)),
    text: withheld.has(loan.noteId) ? null : loan.text,
    verified: loan.verified,
  }));
  const forBid = (noteId: string | null): BidCovenants | null => {
    const scoped = noteId ? listingCovenants(texts, [noteId]) : all;
    if (!scoped.loans.length || !scoped.summary) return null;
    const loans = rows.filter((row) => scoped.loans.some((loan) => loan.noteId === row.noteId));
    return { hash: loans.some((loan) => loan.text == null) ? null : scoped.hash, summary: scoped.summary, loans };
  };
  return { summary: all.summary, hash: all.hash, rows, withheld, forBid };
}

export type CovenantView = ReturnType<typeof covenantView>;

// ---------------------------------------------------------------------------------------------------------------
// The acknowledgement

export type CovenantAck = { at: Date; hash: string; loans: number };

async function scopeCovenants(listingId: string, noteId: string | null) {
  const notes = await prisma.note.findMany({ where: { listingId }, select: COVENANT_SELECT });
  return { notes, covenants: listingCovenants({ notes }, noteId ? [noteId] : null) };
}

// Whether a loan's street is open to this buyer, by the listing page's rule: the room opened to them, or they are
// buying the loan (lib/acl.ts).
async function loanOpener(userId: string, listingId: string) {
  const [listing, nda, deal] = await Promise.all([
    prisma.listing.findUnique({ where: { id: listingId }, select: { status: true } }),
    prisma.ndaAcknowledgment.findUnique({ where: { userId_listingId: { userId, listingId } }, select: { accessStatus: true } }),
    dealAccess(listingId, userId),
  ]);
  return (note: { id: string; tradeStatus?: string | null }) =>
    loanOpenTo({ tradeStatus: note.tradeStatus ?? "AVAILABLE", listingStatus: listing?.status ?? "", signedNda: ndaOpensRoom(nda), wholeParty: deal.whole, loanParty: deal.loans.has(note.id) });
}

// Whether every identifying text in these covenants is open to this buyer.
async function canReadAll(userId: string, listingId: string, covenants: ListingCovenants, notes: { id: string; tradeStatus: string }[]) {
  const identifying = covenants.loans.filter((loan) => loan.identifying);
  if (!identifying.length) return true;
  const open = await loanOpener(userId, listingId);
  const byId = new Map(notes.map((note) => [note.id, note]));
  return identifying.every((loan) => open(byId.get(loan.noteId) ?? { id: loan.noteId }));
}

// A bid's covenants for this buyer away from the listing page, as a standing bid's confirmation or a group's seat form
// shows them: one loan's, or the whole listing's. Null when no loan it covers carries any.
export async function bidCovenantsFor(userId: string, listingId: string, noteId: string | null = null) {
  const [listing, notes] = await Promise.all([
    prisma.listing.findUnique({ where: { id: listingId }, select: { kind: true } }),
    prisma.note.findMany({ where: { listingId }, select: COVENANT_SELECT }),
  ]);
  if (!listing || !listingCovenants({ notes }).hash) return null;
  const open = await loanOpener(userId, listingId);
  return covenantView({ kind: listing.kind, notes }, open).forBid(noteId);
}

function ackProblem(ack: unknown, hash: string) {
  const given = typeof ack === "string" ? ack.trim() : "";
  if (!given) return ACK_MISSING;
  return given === hash ? null : ACK_CHANGED;
}

// The check a bid, a buy-it-now confirmation, a confirmed standing bid or a group seat passes: when any loan it covers
// carries covenants, the form's tick must name the version shown. `ack` is the form's covenantsAck field. Null `ack`
// in the result means no loan carries any.
export async function covenantCheck(input: { userId: string; listingId: string; noteId?: string | null; ack: unknown; now?: Date }) {
  const { notes, covenants } = await scopeCovenants(input.listingId, input.noteId ?? null);
  if (!covenants.hash) return { error: null, ack: null } as const;
  if (!(await canReadAll(input.userId, input.listingId, covenants, notes))) return { error: ACK_WITHHELD } as const;
  const problem = ackProblem(input.ack, covenants.hash);
  if (problem) return { error: problem } as const;
  return { error: null, ack: { at: input.now ?? new Date(), hash: covenants.hash, loans: covenants.loans.length } satisfies CovenantAck } as const;
}

// The record beside the bid or the seat: the version acknowledged and how many loans carried covenants.
export async function recordCovenantAck(actorId: string, entityType: "inquiry" | "group", entityId: string, ack: CovenantAck) {
  await audit(actorId, ACK_ACTION, entityType, entityId, `${ack.hash} · ${ack.loans} loan${ack.loans === 1 ? "" : "s"} with covenants`);
}

const hashOf = (detail: string) => detail.split(" · ")[0] ?? "";

// The latest version each entity's acknowledgement named, keyed `${entityId}:${actorId}` and `${entityId}`.
async function ackedHashes(entityIds: string[]) {
  const rows = entityIds.length
    ? await prisma.auditEvent.findMany({ where: { entityId: { in: entityIds }, action: ACK_ACTION }, select: { entityId: true, actorId: true, detail: true, createdAt: true }, orderBy: { createdAt: "desc" } })
    : [];
  const latest = new Map<string, string>();
  for (const row of rows) {
    if (!latest.has(row.entityId)) latest.set(row.entityId, hashOf(row.detail));
    const key = `${row.entityId}:${row.actorId ?? ""}`;
    if (!latest.has(key)) latest.set(key, hashOf(row.detail));
  }
  return latest;
}

// A seat's covenants: opening or joining a group ticks the box as a bid does. Reconfirming after a counter asks
// nothing, unless the covenants changed since the seat's own acknowledgement, which is then given again on the
// listing.
export async function seatCovenantCheck(input: { userId: string; listingId: string; noteId: string | null; groupId?: string | null; ack?: unknown; reconfirm?: boolean; now?: Date }) {
  if (!input.reconfirm) return covenantCheck({ ...input, ack: input.ack });
  const { covenants } = await scopeCovenants(input.listingId, input.noteId);
  if (!covenants.hash || !input.groupId) return { error: null, ack: null } as const;
  const acked = (await ackedHashes([input.groupId])).get(`${input.groupId}:${input.userId}`);
  return acked === covenants.hash ? ({ error: null, ack: null } as const) : ({ error: SEAT_ACK_STALE } as const);
}

// A group's offer carries the covenants once every buyer's seat acknowledged the version that stands now. The desk
// takes no seat of its own to acknowledge. Run after the offer is written or reconfirmed.
export async function syncGroupCovenants(groupId: string, now = new Date()) {
  const group = await prisma.groupBuy.findUnique({ where: { id: groupId }, include: { positions: { include: { user: { select: { role: true } } } } } });
  if (!group?.inquiryId) return false;
  const { covenants } = await scopeCovenants(group.listingId, group.noteId);
  if (!covenants.hash) return false;
  const seats = group.positions.filter((seat) => seat.status !== "DROPPED" && seat.user.role !== "ADMIN");
  const acked = await ackedHashes([group.id, group.inquiryId]);
  if (!seats.length || seats.some((seat) => acked.get(`${group.id}:${seat.userId}`) !== covenants.hash)) return false;
  if (acked.get(group.inquiryId) === covenants.hash) return true;
  const inquiry = await prisma.inquiry.update({ where: { id: group.inquiryId }, data: { covenantsAcknowledgedAt: now }, select: { buyerId: true } });
  await recordCovenantAck(inquiry.buyerId, "inquiry", group.inquiryId, { at: now, hash: covenants.hash, loans: covenants.loans.length });
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Where an acknowledgement stands

type AckedInquiry = { id: string; listingId: string; noteId: string | null; covenantsAcknowledgedAt: Date | null };

export type AckStanding = { acknowledgedAt: Date | null; current: boolean };

// A bid's acknowledgement against the covenants on its loans as they stand. `notes` are the listing's, when the
// caller has them. Null when no loan the bid covers carries covenants.
export async function bidCovenantStanding(inquiry: AckedInquiry, notes?: readonly CovenantNote[]): Promise<AckStanding | null> {
  const rows = notes ?? (await prisma.note.findMany({ where: { listingId: inquiry.listingId }, select: COVENANT_SELECT }));
  const hash = listingCovenants({ notes: rows }, inquiry.noteId ? [inquiry.noteId] : null).hash;
  if (!hash) return null;
  if (!inquiry.covenantsAcknowledgedAt) return { acknowledgedAt: null, current: false };
  const acked = (await ackedHashes([inquiry.id])).get(inquiry.id);
  return { acknowledgedAt: inquiry.covenantsAcknowledgedAt, current: acked === hash };
}

// Why this bid can't be awarded yet for its covenants, or null. For the award checks (lib/awards.ts checkAward).
export async function covenantAwardBlock(inquiryId: string) {
  const inquiry = await prisma.inquiry.findUnique({ where: { id: inquiryId }, select: { id: true, listingId: true, noteId: true, covenantsAcknowledgedAt: true } });
  if (!inquiry) return null;
  const standing = await bidCovenantStanding(inquiry);
  if (!standing || standing.current) return null;
  return standing.acknowledgedAt
    ? "The covenants on these loans changed after the buyer acknowledged them. The buyer acknowledges them again on the listing before this bid can be awarded."
    : "The buyer hasn't acknowledged the covenants that pass with these loans. They acknowledge them on the listing before this bid can be awarded.";
}

// Every bid an award could still take (lib/awards.ts LIVE) that covenantAwardBlock would stop, read in bulk for the
// desk's risk queue (lib/risk-queue.ts): the same standing, from the listings' loans and the acknowledgements' log.
export async function covenantAwardBlocks() {
  const bids = await prisma.inquiry.findMany({
    where: { type: "OFFER", status: { in: ["OPEN", "REVIEWED"] } },
    select: { id: true, listingId: true, noteId: true, amount: true, createdAt: true, covenantsAcknowledgedAt: true, buyer: { select: { name: true } } },
  });
  if (!bids.length) return [];
  const flagged = await prisma.note.findMany({ where: { listingId: { in: [...new Set(bids.map((bid) => bid.listingId))] }, inheritedCovenants: { not: null } }, select: { listingId: true, inheritedCovenants: true } });
  const carrying = [...new Set(flagged.filter((note) => covenantText(note.inheritedCovenants)).map((note) => note.listingId))];
  if (!carrying.length) return [];
  const [notes, listings] = await Promise.all([
    prisma.note.findMany({ where: { listingId: { in: carrying } }, select: { ...COVENANT_SELECT, listingId: true } }),
    prisma.listing.findMany({ where: { id: { in: carrying } }, select: { id: true, title: true, deskOwnerId: true, bidMode: true, bidDeadline: true, status: true } }),
  ]);
  const notesOf = new Map<string, typeof notes>();
  for (const note of notes) notesOf.set(note.listingId, [...(notesOf.get(note.listingId) ?? []), note]);
  const listingOf = new Map(listings.map((listing) => [listing.id, listing]));
  const owing = bids.filter((bid) => listingOf.has(bid.listingId));
  const acked = await ackedHashes(owing.filter((bid) => bid.covenantsAcknowledgedAt).map((bid) => bid.id));
  return owing.flatMap((bid) => {
    const hash = listingCovenants({ notes: notesOf.get(bid.listingId) ?? [] }, bid.noteId ? [bid.noteId] : null).hash;
    if (!hash || (bid.covenantsAcknowledgedAt && acked.get(bid.id) === hash)) return [];
    return [{ ...bid, amount: bid.amount == null ? null : Number(bid.amount), stale: Boolean(bid.covenantsAcknowledgedAt), listing: listingOf.get(bid.listingId)! }];
  });
}

const LIVE_BIDS = ["OPEN", "REVIEWED", "ACCEPTED"] as const;
const LIVE_GROUPS = ["GATHERING", "OFFERED", "COUNTERED", "CLOSING"] as const;

// This buyer's live bids and group seats on the listing whose acknowledgement is missing or older than the covenants.
// A group's own bid follows its seats, so it isn't listed as the lead's.
export async function covenantsOwed(userId: string, listingId: string) {
  const notes = await prisma.note.findMany({ where: { listingId }, select: COVENANT_SELECT });
  const owed = { bids: [] as { id: string; hash: string; loans: number }[], groups: [] as { id: string; hash: string; loans: number }[] };
  if (!listingCovenants({ notes }).hash) return owed;
  const [bids, seats, grouped] = await Promise.all([
    prisma.inquiry.findMany({ where: { listingId, buyerId: userId, type: "OFFER", status: { in: [...LIVE_BIDS] } }, select: { id: true, noteId: true, covenantsAcknowledgedAt: true } }),
    prisma.groupPosition.findMany({ where: { userId, status: { in: ["PLEDGED", "RECONFIRM"] }, group: { listingId, status: { in: [...LIVE_GROUPS] } } }, select: { group: { select: { id: true, noteId: true } } } }),
    prisma.groupBuy.findMany({ where: { listingId, inquiryId: { not: null } }, select: { inquiryId: true } }),
  ]);
  const groupBids = new Set(grouped.map((group) => group.inquiryId));
  const acked = await ackedHashes([...bids.map((bid) => bid.id), ...seats.map((seat) => seat.group.id)]);
  for (const bid of bids) {
    if (groupBids.has(bid.id)) continue;
    const scoped = listingCovenants({ notes }, bid.noteId ? [bid.noteId] : null);
    if (scoped.hash && (!bid.covenantsAcknowledgedAt || acked.get(bid.id) !== scoped.hash)) owed.bids.push({ id: bid.id, hash: scoped.hash, loans: scoped.loans.length });
  }
  for (const { group } of seats) {
    const scoped = listingCovenants({ notes }, group.noteId ? [group.noteId] : null);
    if (scoped.hash && acked.get(`${group.id}:${userId}`) !== scoped.hash) owed.groups.push({ id: group.id, hash: scoped.hash, loans: scoped.loans.length });
  }
  return owed;
}

// The listing page's form for a buyer whose bids or seats wait on the covenants as they stand now. The tick names the
// version of every covenant on the listing, which covers each bid's own loans.
export async function acknowledgeAgain(user: { id: string }, listingId: string, ack: unknown, now = new Date()) {
  const { notes, covenants } = await scopeCovenants(listingId, null);
  if (!covenants.hash) return { error: "These loans carry no covenants to acknowledge." } as const;
  if (!(await canReadAll(user.id, listingId, covenants, notes))) return { error: ACK_WITHHELD } as const;
  const problem = ackProblem(ack, covenants.hash);
  if (problem) return { error: problem } as const;
  const owed = await covenantsOwed(user.id, listingId);
  for (const bid of owed.bids) {
    await prisma.inquiry.update({ where: { id: bid.id }, data: { covenantsAcknowledgedAt: now } });
    await recordCovenantAck(user.id, "inquiry", bid.id, { at: now, hash: bid.hash, loans: bid.loans });
  }
  for (const group of owed.groups) {
    await recordCovenantAck(user.id, "group", group.id, { at: now, hash: group.hash, loans: group.loans });
    await syncGroupCovenants(group.id, now);
  }
  return { error: null, count: owed.bids.length + owed.groups.length } as const;
}

// ---------------------------------------------------------------------------------------------------------------
// The papers and the record

type ClosingScope = { id: string; listingId: string; inquiryId: string | null; deskBidId?: string | null; noteId?: string | null; noteIds?: string[] };

export type ClosingCovenants = {
  covenants: ListingCovenants;
  // Each loan with covenants, as the purchase agreement names it, in the loan schedule's order.
  lines: { place: string; text: string; verified: boolean }[];
  deskPurchase: boolean;
  standing: AckStanding | null;
};

// The covenants on a closing's loans and the buyer's acknowledgement. Null when none of its loans carry any.
export async function closingCovenants(closing: ClosingScope, listingNotes?: readonly (ViewNote & { zip?: string })[]): Promise<ClosingCovenants | null> {
  const notes = listingNotes ?? (await prisma.note.findMany({ where: { listingId: closing.listingId }, select: COVENANT_SELECT }));
  const loans = closingLoans({ noteId: closing.noteId ?? null, noteIds: closing.noteIds ?? [] }, [...notes]);
  const covenants = listingCovenants({ notes: loans });
  if (!covenants.loans.length) return null;
  const pool = loans.length > 1;
  const byId = new Map(loans.map((note) => [note.id, note]));
  // The papers go to the closing's parties, who see the street, so each loan is named as the loan schedule names it.
  const lines = covenants.loans.map((loan) => {
    const note = byId.get(loan.noteId)!;
    const where = `${note.streetAddress ? `${note.streetAddress}, ` : ""}${note.city}, ${note.state}${note.zip ? ` ${note.zip}` : ""}`;
    return { place: pool ? `Loan ${loan.position} on the loan schedule, ${where}.` : `The loan at ${where}.`, text: loan.text, verified: loan.verified };
  });
  const inquiry = closing.inquiryId
    ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, select: { id: true, listingId: true, noteId: true, covenantsAcknowledgedAt: true } })
    : null;
  return { covenants, lines, deskPurchase: Boolean(closing.deskBidId), standing: inquiry ? await bidCovenantStanding(inquiry, notes) : null };
}

const day = (value: Date) => value.toISOString().slice(0, 10);

// The acknowledgement in the papers' words.
export function acknowledgementLine(found: Pick<ClosingCovenants, "deskPurchase" | "standing">) {
  if (found.deskPurchase) return "UPB Capital buys these loans for its own book and takes them subject to these covenants.";
  const standing = found.standing;
  if (standing?.acknowledgedAt && standing.current) return `The buyer acknowledged these covenants on ${day(standing.acknowledgedAt)}, before bidding, and agreed to service the loans to them.`;
  if (standing?.acknowledgedAt) {
    return `The buyer acknowledged an earlier text of these covenants on ${day(standing.acknowledgedAt)}. The text changed after that, so the buyer acknowledges it again before signing.`;
  }
  return "The buyer has not acknowledged these covenants on UPB Capital, and acknowledges them before signing.";
}

// The purchase agreement's schedule, or "" when no loan the closing covers carries covenants.
export async function covenantScheduleFor(closing: ClosingScope, listingNotes?: readonly (ViewNote & { zip?: string })[]) {
  const found = await closingCovenants(closing, listingNotes);
  return found ? covenantScheduleText({ loans: found.lines, acknowledgement: acknowledgementLine(found) }) : "";
}

// The closing page's line and the sale file's row: how many loans carry covenants, and where the acknowledgement
// stands.
export function covenantStatus(found: Pick<ClosingCovenants, "deskPurchase" | "standing">) {
  if (found.deskPurchase) return "Desk purchase";
  if (found.standing?.acknowledgedAt) return found.standing.current ? "Acknowledged" : "Changed after acknowledgement";
  return "Not acknowledged";
}

export async function covenantSaleRow(closing: ClosingScope) {
  const found = await closingCovenants(closing);
  if (!found) return null;
  return {
    at: found.standing?.acknowledgedAt ?? null,
    status: covenantStatus(found),
    detail: `${found.covenants.summary} ${acknowledgementLine(found)} The purchase agreement carries them as a schedule.`,
  };
}
