import { createHash } from "node:crypto";
import { audit } from "@/lib/audit";
import { appOrigin } from "@/lib/billing";
import { seasoningMonths } from "@/lib/buy-box";
import { unset } from "@/lib/db-filters";
import { DESK_DENIED, deskCan } from "@/lib/desk-roles";
import { notify, notifyDesk } from "@/lib/email";
import { money } from "@/lib/format";
import type { Tally } from "@/lib/jobs";
import { labelOf, LIEN_POSITIONS, PAYMENT_STATUSES, US_STATES } from "@/lib/labels";
import { launchPending, launchTime } from "@/lib/launch-rules";
import { prisma } from "@/lib/prisma";
import { excludes, peopleOf, readEmails } from "@/lib/private-listings";
import { canSubmitOffer } from "@/lib/verification";

// Forward flow. A seller's programme sells loans in recurring tranches to buyers who accepted its terms once. Each
// tranche is an ordinary listing the desk reviews. From approval the programme's committed buyers have it to
// themselves for its first-look hours, with a bid form their price grid pre-fills; nothing is bid until the buyer
// confirms. Then it is released, and the market's new-listing alerts and matching run as approval would have run
// them. Who sees a tranche during its first look is decided in lib/private-listings.ts.

export const CADENCES = [
  { value: "MONTHLY", label: "Monthly" },
  { value: "QUARTERLY", label: "Quarterly" },
  { value: "AD_HOC", label: "Ad hoc" },
] as const;
export const FIRST_LOOK_HOURS = { min: 24, max: 168, standard: 72 } as const;
export const NAME_MAX = 120;
export const TERMS_MAX = 10_000;
// Rows a buyer's grid holds, and the blank rows the form offers below the saved ones.
export const GRID_MAX = 24;
export const GRID_BLANKS = 4;
export const ANY = "ANY";
// A tranche is a listing still with the desk: filed, in review, or back with the seller for changes.
export const ATTACHABLE = ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED"] as const;
// A ceiling well above any real programme, so a slipped key isn't saved as a volume or a cap.
const MAX_CENTS = 500_000_000_000;
const INVITES_AT_ONCE = 25;
const INVITE_BATCHES = 12;
const HOUR = 60 * 60 * 1000;

export const PROGRAM_LABEL: Record<string, string> = { DRAFT: "Awaiting approval", OPEN: "Open", PAUSED: "Paused", CLOSED: "Closed" };
export const COMMITMENT_LABEL: Record<string, string> = { INVITED: "Invited", ACTIVE: "Active", PAUSED: "Paused", ENDED: "Ended" };
export const TRANCHE_LABEL: Record<string, string> = { FIRST_LOOK: "First look", RELEASED: "Released", AWARDED: "Awarded", WITHDRAWN: "Withdrawn" };

export function cadenceLabel(value: string) {
  return CADENCES.find((cadence) => cadence.value === value)?.label ?? value;
}

type Actor = { id: string; role: string; deskRole?: string | null };
type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string) => ({ ok: false as const, error });
const NOT_YOURS = "That programme isn't yours.";

const LIENS: string[] = LIEN_POSITIONS.map((row) => row.value);
const STATUSES: string[] = PAYMENT_STATUSES.map((row) => row.value);
const STATES: string[] = [...US_STATES];

// ---------------------------------------------------------------------------------------------------------------
// Criteria: what qualifies a loan for the programme. An empty list or a missing limit means any.

export type FlowCriteria = { lienPositions: string[]; paymentStatuses: string[]; states: string[]; maxUpb: number | null; minSeasoningMonths: number | null };

function listOf(raw: unknown, allowed: string[]) {
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,;]+/) : [];
  return [...new Set(values.map((value) => String(value).trim().toUpperCase()).filter((value) => allowed.includes(value)))];
}

function dollarsOf(raw: unknown) {
  const value = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

const blank = (raw: unknown) => String(raw ?? "").trim() === "";

// Missing or unreadable parts read as no limit, so a programme saved before a field existed still reads.
export function criteriaOf(raw: unknown): FlowCriteria {
  const json = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const seasoning = dollarsOf(json.minSeasoningMonths);
  return {
    lienPositions: listOf(json.lienPositions, LIENS),
    paymentStatuses: listOf(json.paymentStatuses, STATUSES),
    states: listOf(json.states, STATES),
    maxUpb: dollarsOf(json.maxUpb),
    minSeasoningMonths: seasoning == null ? null : Math.floor(seasoning),
  };
}

// The criteria in the desk's words, one line each.
export function criteriaLines(criteria: FlowCriteria) {
  const join = (values: string[]) => values.join(", ");
  return [
    criteria.lienPositions.length ? `${join(criteria.lienPositions.map((value) => labelOf("lien", value)))} lien` : "Any lien position",
    criteria.paymentStatuses.length ? join(criteria.paymentStatuses.map((value) => labelOf("payment", value))) : "Any payment status",
    criteria.states.length ? `In ${join(criteria.states)}` : "Any state",
    criteria.maxUpb != null ? `Up to ${money(criteria.maxUpb)} UPB a loan` : "No UPB limit a loan",
    criteria.minSeasoningMonths != null ? `Seasoned ${criteria.minSeasoningMonths} months or more` : "No seasoning minimum",
  ];
}

export type CriteriaLoan = { id?: string; state: string; lienPosition: string; paymentStatus: string; upb: number; originationDate?: Date | null };
export type LoanFlag = { index: number; id: string | null; reasons: string[] };

// Each loan outside the criteria, with why. A flag doesn't stop the tranche: the seller sees it before submitting,
// and the desk sees it in review.
export function criteriaFlags(loans: CriteriaLoan[], criteria: FlowCriteria, now = new Date()): LoanFlag[] {
  const flags: LoanFlag[] = [];
  loans.forEach((loan, index) => {
    const reasons: string[] = [];
    if (criteria.lienPositions.length && !criteria.lienPositions.includes(loan.lienPosition)) reasons.push(`${labelOf("lien", loan.lienPosition)} lien`);
    if (criteria.paymentStatuses.length && !criteria.paymentStatuses.includes(loan.paymentStatus)) reasons.push(labelOf("payment", loan.paymentStatus));
    if (criteria.states.length && !criteria.states.includes(loan.state.toUpperCase())) reasons.push(`in ${loan.state || "no state"}`);
    if (criteria.maxUpb != null && loan.upb > criteria.maxUpb) reasons.push(`UPB ${money(loan.upb)} is over ${money(criteria.maxUpb)}`);
    if (criteria.minSeasoningMonths != null) {
      const months = seasoningMonths(loan.originationDate ?? null, now);
      if (months == null) reasons.push("no origination date to show seasoning");
      else if (months < criteria.minSeasoningMonths) reasons.push(`seasoned ${months} month${months === 1 ? "" : "s"}, under ${criteria.minSeasoningMonths}`);
    }
    if (reasons.length) flags.push({ index, id: loan.id ?? null, reasons });
  });
  return flags;
}

export function flagLine(flag: LoanFlag) {
  const text = flag.reasons.join(", ");
  return `Loan ${flag.index + 1}: ${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

// ---------------------------------------------------------------------------------------------------------------
// The programme form.

export type ProgramInput = {
  name: unknown;
  cadence: unknown;
  firstLookHours: unknown;
  expectedVolume: unknown;
  terms: unknown;
  lienPositions: unknown;
  paymentStatuses: unknown;
  states: unknown;
  maxUpb: unknown;
  minSeasoningMonths: unknown;
};

export function readProgram(input: ProgramInput) {
  const name = String(input.name ?? "").replace(/\s+/g, " ").trim();
  if (name.length < 3 || name.length > NAME_MAX) return { error: `Name the programme in 3 to ${NAME_MAX} characters.` } as const;
  const cadence = CADENCES.find((option) => option.value === input.cadence)?.value;
  if (!cadence) return { error: "Choose monthly, quarterly or ad hoc." } as const;
  const hours = Number(String(input.firstLookHours ?? "").trim());
  if (!Number.isInteger(hours) || hours < FIRST_LOOK_HOURS.min || hours > FIRST_LOOK_HOURS.max) {
    return { error: `Set the first look between ${FIRST_LOOK_HOURS.min} and ${FIRST_LOOK_HOURS.max} hours.` } as const;
  }
  const volume = dollarsOf(input.expectedVolume);
  if (!blank(input.expectedVolume) && volume == null) return { error: "Enter the expected volume in dollars, or leave it blank." } as const;
  if (volume != null && Math.round(volume * 100) > MAX_CENTS) return { error: `Enter an expected volume up to ${money(MAX_CENTS / 100)}.` } as const;
  const terms = String(input.terms ?? "").replace(/\r\n/g, "\n").trim();
  if (terms.length < 20) return { error: "Write the programme terms buyers accept, in 20 characters or more." } as const;
  if (terms.length > TERMS_MAX) return { error: `Keep the terms under ${TERMS_MAX.toLocaleString("en-US")} characters.` } as const;
  const typedStates = String(input.states ?? "").split(/[\s,;]+/).map((value) => value.trim().toUpperCase()).filter(Boolean);
  const unknown = typedStates.filter((value) => !STATES.includes(value));
  if (unknown.length) return { error: `Use two-letter state codes. Check ${unknown.slice(0, 5).join(", ")}.` } as const;
  const maxUpb = dollarsOf(input.maxUpb);
  if (!blank(input.maxUpb) && maxUpb == null) return { error: "Enter the largest UPB a loan may have, or leave it blank." } as const;
  const seasoning = blank(input.minSeasoningMonths) ? null : Number(String(input.minSeasoningMonths).trim());
  if (seasoning != null && (!Number.isInteger(seasoning) || seasoning < 0 || seasoning > 480)) return { error: "Enter the minimum seasoning in whole months, or leave it blank." } as const;
  const criteria: FlowCriteria = {
    lienPositions: listOf(input.lienPositions, LIENS),
    paymentStatuses: listOf(input.paymentStatuses, STATUSES),
    states: listOf(typedStates, STATES),
    maxUpb,
    minSeasoningMonths: seasoning || null,
  };
  return {
    error: null,
    data: { name, cadence, firstLookHours: hours, expectedVolumeCents: volume == null ? null : Math.round(volume * 100), terms, criteria },
  } as const;
}

// The version a buyer accepts: a short fingerprint of the terms text, so a record names exactly what they read.
export function termsVersion(terms: string) {
  return createHash("sha256").update(terms.trim()).digest("hex").slice(0, 12);
}

async function sellerName(sellerId: string) {
  const seller = await prisma.user.findUnique({ where: { id: sellerId }, select: { name: true, companyName: true, email: true } });
  return { name: seller?.companyName || seller?.name || "A seller", email: seller?.email ?? null };
}

// Creating a programme sends it to the desk. It opens when the desk approves it.
export async function createProgram(seller: Actor, input: ProgramInput): Promise<Outcome<{ id: string }>> {
  if (seller.role !== "INSTITUTIONAL_SELLER") return fail("Forward-flow programmes are for institutional sellers.");
  const read = readProgram(input);
  if (read.error !== null) return fail(read.error);
  const program = await prisma.flowProgram.create({ data: { sellerId: seller.id, status: "DRAFT", ...read.data } });
  await audit(seller.id, "FLOW_PROGRAM_SUBMITTED", "flowProgram", program.id, program.name);
  const { name } = await sellerName(seller.id);
  await notifyDesk(
    `Programme for approval · ${program.name}`,
    `${name} submitted a forward-flow programme: ${cadenceLabel(program.cadence).toLowerCase()} tranches with a ${program.firstLookHours}-hour first look for committed buyers. Read its terms and approve it here: ${appOrigin()}/admin/flow/${program.id}`,
    { capability: "sales" },
  );
  return { ok: true, value: { id: program.id } };
}

// The seller can change a programme until the desk approves it. After that the terms buyers accepted stand.
export async function updateProgram(seller: Actor, programId: string, input: ProgramInput): Promise<Outcome<{ id: string }>> {
  const program = await prisma.flowProgram.findUnique({ where: { id: programId }, select: { id: true, sellerId: true, status: true } });
  if (!program || program.sellerId !== seller.id) return fail(NOT_YOURS);
  if (program.status !== "DRAFT") return fail("An approved programme's terms and criteria are set. Close it and start a new one to change them.");
  const read = readProgram(input);
  if (read.error !== null) return fail(read.error);
  const changed = await prisma.flowProgram.updateMany({ where: { id: program.id, status: "DRAFT" }, data: read.data });
  if (changed.count !== 1) return fail("The desk decided on this programme a moment ago. Reload it.");
  await audit(seller.id, "FLOW_PROGRAM_EDITED", "flowProgram", program.id, read.data.name);
  return { ok: true, value: { id: program.id } };
}

// ---------------------------------------------------------------------------------------------------------------
// The desk approves, pauses, resumes or closes a programme. A paused programme takes no new tranches, and a tranche
// it approves goes straight to the market; first looks already running finish. Closing releases them at once.

const MOVES: Record<string, { from: string[]; to: string }> = {
  APPROVE: { from: ["DRAFT"], to: "OPEN" },
  PAUSE: { from: ["OPEN"], to: "PAUSED" },
  RESUME: { from: ["PAUSED"], to: "OPEN" },
  CLOSE: { from: ["DRAFT", "OPEN", "PAUSED"], to: "CLOSED" },
};

export async function decideProgram(desk: Actor, input: { programId: string; decision: unknown; note: unknown }, now = new Date()): Promise<Outcome<{ status: string }>> {
  if (desk.role !== "ADMIN" || !deskCan(desk, "sales")) return fail(DESK_DENIED);
  const move = MOVES[String(input.decision ?? "")];
  if (!move) return fail("Approve, pause, resume or close.");
  const note = String(input.note ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  const program = await prisma.flowProgram.findUnique({ where: { id: input.programId } });
  if (!program) return fail("That programme no longer exists.");
  if (!move.from.includes(program.status)) return fail(`That doesn't apply to a programme that is ${PROGRAM_LABEL[program.status]?.toLowerCase() ?? program.status}.`);
  if (move.to === "CLOSED" && program.status === "DRAFT" && note.length < 3) return fail("Tell the seller why the programme isn't approved.");
  const data =
    move.to === "OPEN" && program.status === "DRAFT"
      ? { status: "OPEN", approvedById: desk.id, approvedAt: now, startsAt: now }
      : move.to === "CLOSED"
        ? { status: "CLOSED", endsAt: now }
        : { status: move.to };
  const moved = await prisma.flowProgram.updateMany({ where: { id: program.id, status: program.status }, data });
  if (moved.count !== 1) return fail("The programme changed a moment ago. Reload it and decide again.");
  await audit(desk.id, `FLOW_PROGRAM_${String(input.decision)}`, "flowProgram", program.id, `${program.name}${note ? ` · ${note}` : ""}`);
  const seller = await sellerName(program.sellerId);
  const link = `${appOrigin()}/seller/flow/${program.id}`;
  const said = note ? `\n\n${note}` : "";
  if (move.to === "OPEN" && program.status === "DRAFT") {
    if (seller.email) await notify(seller.email, `Programme approved · ${program.name}`, `The desk approved ${program.name}. Invite your buyers and add tranches here: ${link}${said}`);
  } else if (move.to === "CLOSED") {
    await releaseProgramTranches(program.id, now);
    if (seller.email) await notify(seller.email, `Programme closed · ${program.name}`, `${program.status === "DRAFT" ? "The desk didn't approve" : "The desk closed"} ${program.name}. Tranches still in first look are open to the market now. ${link}${said}`);
    await tellCommitted(program.id, `Programme closed · ${program.name}`, `${program.name} is closed. Its tranches no longer come to you first. Bids you placed stand as they are.`);
  } else if (seller.email) {
    await notify(
      seller.email,
      `Programme ${move.to === "PAUSED" ? "paused" : "resumed"} · ${program.name}`,
      move.to === "PAUSED"
        ? `The desk paused ${program.name}. It takes no new tranches, and a tranche approved while it is paused goes straight to the market. First looks already running finish as planned. ${link}${said}`
        : `The desk resumed ${program.name}. It takes tranches again. ${link}${said}`,
    );
  }
  return { ok: true, value: { status: move.to } };
}

// The seller ends their own programme, approved or not.
export async function closeOwnProgram(seller: Actor, programId: string, now = new Date()): Promise<Outcome<null>> {
  const program = await prisma.flowProgram.findUnique({ where: { id: programId }, select: { id: true, name: true, sellerId: true, status: true } });
  if (!program || program.sellerId !== seller.id) return fail(NOT_YOURS);
  if (program.status === "CLOSED") return { ok: true, value: null };
  const moved = await prisma.flowProgram.updateMany({ where: { id: program.id, status: program.status }, data: { status: "CLOSED", endsAt: now } });
  if (moved.count !== 1) return fail("The programme changed a moment ago. Reload it.");
  await audit(seller.id, "FLOW_PROGRAM_CLOSED", "flowProgram", program.id, program.name);
  await releaseProgramTranches(program.id, now);
  await tellCommitted(program.id, `Programme closed · ${program.name}`, `The seller closed ${program.name}. Its tranches no longer come to you first. Bids you placed stand as they are.`);
  await notifyDesk(`Programme closed · ${program.name}`, `The seller closed ${program.name}. Tranches still in first look are open to the market now.`, { capability: "sales" });
  return { ok: true, value: null };
}

async function tellCommitted(programId: string, subject: string, body: string) {
  for (const buyer of await committedBuyers(programId, ["ACTIVE", "PAUSED"])) await notify(buyer.email, subject, `${body}\n\n${appOrigin()}/buyer/flow`);
}

async function committedBuyers(programId: string, statuses: string[]) {
  const rows = await prisma.flowCommitment.findMany({ where: { programId, status: { in: statuses } }, select: { buyerId: true } });
  if (!rows.length) return [];
  return prisma.user.findMany({ where: { id: { in: rows.map((row) => row.buyerId) } }, select: { id: true, email: true } });
}

// ---------------------------------------------------------------------------------------------------------------
// Tranches. The seller adds one of their listings still with the desk, or uploads a tape for the programme, and
// the listing is tagged before anything scores it. It goes through the desk's review as any other listing.

// The programme a tape upload files into: the seller's own, and open.
export async function tapeProgram(sellerId: string, programId: string) {
  const program = await prisma.flowProgram.findUnique({ where: { id: programId }, select: { id: true, name: true, sellerId: true, status: true, criteria: true } });
  return program && program.sellerId === sellerId && program.status === "OPEN" ? program : null;
}

export async function attachCandidates(sellerId: string) {
  return prisma.listing.findMany({
    where: { sellerId, status: { in: [...ATTACHABLE] }, ...unset("flowProgramId") },
    select: { id: true, title: true, status: true, kind: true, createdAt: true, _count: { select: { notes: true } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

const LOAN_FIELDS = { id: true, state: true, lienPosition: true, paymentStatus: true, upb: true, originationDate: true } as const;

// What adding this listing would flag, for the seller to read before submitting it as a tranche.
export async function trancheCheck(seller: Actor, programId: string, listingId: string, now = new Date()) {
  const [program, listing] = await Promise.all([
    prisma.flowProgram.findUnique({ where: { id: programId }, select: { sellerId: true, criteria: true } }),
    prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, title: true, sellerId: true, status: true, flowProgramId: true, notes: { select: LOAN_FIELDS } } }),
  ]);
  if (!program || program.sellerId !== seller.id || !listing || listing.sellerId !== seller.id) return null;
  return { listing, flags: criteriaFlags(listing.notes, criteriaOf(program.criteria), now) };
}

export async function addTranche(seller: Actor, input: { programId: string; listingId: string }, now = new Date()): Promise<Outcome<{ trancheId: string; sequence: number; flagged: number }>> {
  const program = await prisma.flowProgram.findUnique({ where: { id: input.programId } });
  if (!program || program.sellerId !== seller.id) return fail(NOT_YOURS);
  if (program.status !== "OPEN") return fail(`Tranches join an open programme. This one is ${PROGRAM_LABEL[program.status]?.toLowerCase() ?? program.status}.`);
  const listing = await prisma.listing.findUnique({ where: { id: input.listingId }, select: { id: true, title: true, sellerId: true, status: true, flowProgramId: true, notes: { select: LOAN_FIELDS } } });
  if (!listing || listing.sellerId !== seller.id) return fail("That listing isn't yours.");
  if (listing.flowProgramId) return fail("That listing is already in a programme.");
  if (!(ATTACHABLE as readonly string[]).includes(listing.status)) return fail("Only a listing still with the desk can join: filed, in review or back for changes.");
  // Tagged on the status this read, so a listing approved or tagged in the same moment isn't taken.
  const tagged = await prisma.listing.updateMany({ where: { id: listing.id, status: listing.status, ...unset("flowProgramId") }, data: { flowProgramId: program.id } });
  if (tagged.count !== 1) return fail("That listing changed a moment ago. Reload and try again.");
  const sequence = (await prisma.flowTranche.count({ where: { programId: program.id } })) + 1;
  let trancheId: string;
  try {
    trancheId = (await prisma.flowTranche.create({ data: { programId: program.id, listingId: listing.id, sequence, status: "FIRST_LOOK" } })).id;
  } catch {
    await prisma.listing.updateMany({ where: { id: listing.id, flowProgramId: program.id }, data: { flowProgramId: null } });
    return fail("That listing is already a tranche.");
  }
  const flags = criteriaFlags(listing.notes, criteriaOf(program.criteria), now);
  await audit(seller.id, "FLOW_TRANCHE_ADDED", "listing", listing.id, `Tranche ${sequence} of ${program.name}${flags.length ? ` · ${flags.length} loan${flags.length === 1 ? "" : "s"} outside the criteria` : ""}`);
  await notifyDesk(
    `Tranche ${sequence} · ${program.name}`,
    `${listing.title} is tranche ${sequence} of ${program.name}. ${flags.length ? `${flags.length} of its ${listing.notes.length} loans sit outside the programme's criteria.` : "Every loan fits the programme's criteria."} Review it as usual. Approval starts the ${program.firstLookHours}-hour first look: ${appOrigin()}/admin/listings/${listing.id}`,
    { capability: "sales" },
  );
  // Matches for buyers outside the programme go until the release.
  await rescoreQuietly(listing.id);
  return { ok: true, value: { trancheId, sequence, flagged: flags.length } };
}

// Before approval the seller can take a listing back out of the programme. It is then an ordinary listing.
export async function removeTranche(seller: Actor, trancheId: string): Promise<Outcome<{ programId: string }>> {
  const tranche = await prisma.flowTranche.findUnique({ where: { id: trancheId }, include: { program: { select: { sellerId: true, name: true } } } });
  if (!tranche || tranche.program.sellerId !== seller.id) return fail("That tranche isn't yours.");
  if (tranche.status !== "FIRST_LOOK" || tranche.firstLookEndsAt) return fail("This tranche is past approval, so it stays in the programme.");
  const removed = await prisma.flowTranche.deleteMany({ where: { id: tranche.id, status: "FIRST_LOOK", ...unset("firstLookEndsAt") } });
  if (removed.count !== 1) return fail("The desk approved this tranche a moment ago, so it stays in the programme.");
  await prisma.listing.updateMany({ where: { id: tranche.listingId, flowProgramId: tranche.programId }, data: { flowProgramId: null } });
  await audit(seller.id, "FLOW_TRANCHE_REMOVED", "listing", tranche.listingId, `Out of ${tranche.program.name}`);
  await rescoreQuietly(tranche.listingId);
  return { ok: true, value: { programId: tranche.programId } };
}

async function rescoreQuietly(listingId: string) {
  const { rescoreListing } = await import("@/lib/matching");
  await rescoreListing(listingId, false).catch(() => undefined);
}

// What approval would have sent: saved-search alerts and buy-box matches, now the whole market can see it.
async function openToMarket(listingId: string, now: Date) {
  const [{ alertMatchingSearches }, { rescoreListing }] = await Promise.all([import("@/lib/search-alerts"), import("@/lib/matching")]);
  await alertMatchingSearches(listingId, now);
  await rescoreListing(listingId, true, now);
}

// ---------------------------------------------------------------------------------------------------------------
// First look and release.

// The desk's approval calls this once. It returns when the first look ends, and the caller holds the market's
// alerts for the release; or null, when the listing is in no programme or goes straight to the market, and the
// caller alerts as usual. A programme that isn't open, or has no active committed buyer, gets no first look.
export async function startFirstLook(listingId: string, now = new Date()): Promise<{ endsAt: Date } | null> {
  const tranche = await prisma.flowTranche.findUnique({ where: { listingId }, include: { program: true } });
  if (!tranche || tranche.status !== "FIRST_LOOK") return null;
  if (tranche.firstLookEndsAt) return { endsAt: tranche.firstLookEndsAt };
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, title: true, status: true, approvedAt: true, launchAt: true } });
  if (!listing || listing.status !== "APPROVED") return null;
  const buyers = tranche.program.status === "OPEN" ? await committedBuyers(tranche.programId, ["ACTIVE"]) : [];
  if (!buyers.length) {
    const released = await prisma.flowTranche.updateMany({ where: { id: tranche.id, status: "FIRST_LOOK", ...unset("firstLookEndsAt") }, data: { status: "RELEASED", releasedAt: now } });
    if (released.count === 1) {
      const why = tranche.program.status === "OPEN" ? "no active committed buyer" : `the programme is ${PROGRAM_LABEL[tranche.program.status]?.toLowerCase()}`;
      await audit(null, "FLOW_RELEASED", "listing", listingId, `Tranche ${tranche.sequence} of ${tranche.program.name} · no first look: ${why}`);
    }
    return null;
  }
  // A coming-soon tranche's first look runs from its launch, when its room and bids open.
  const from = listing.approvedAt && listing.approvedAt.getTime() > now.getTime() ? listing.approvedAt : now;
  const endsAt = new Date(from.getTime() + tranche.program.firstLookHours * HOUR);
  const claimed = await prisma.flowTranche.updateMany({ where: { id: tranche.id, status: "FIRST_LOOK", ...unset("firstLookEndsAt") }, data: { firstLookEndsAt: endsAt } });
  if (claimed.count !== 1) {
    const again = await prisma.flowTranche.findUnique({ where: { id: tranche.id }, select: { status: true, firstLookEndsAt: true } });
    return again?.status === "FIRST_LOOK" && again.firstLookEndsAt ? { endsAt: again.firstLookEndsAt } : null;
  }
  await audit(null, "FLOW_FIRST_LOOK", "listing", listingId, `Tranche ${tranche.sequence} of ${tranche.program.name} · ${buyers.length} committed buyer${buyers.length === 1 ? "" : "s"} until ${launchTime(endsAt)}`);
  const coming = launchPending(listing, now) && listing.launchAt ? ` Its room and bids open at its launch on ${launchTime(listing.launchAt)}.` : "";
  for (const buyer of buyers) {
    await notify(
      buyer.email,
      `First look · ${listing.title}`,
      [
        `${listing.title} is tranche ${tranche.sequence} of ${tranche.program.name}. The programme's committed buyers see it until ${launchTime(endsAt)}, before it opens to the market.${coming}`,
        "Your price grid pre-fills the bid form. Nothing is bid until you check the figure and confirm it.",
        `Open it here: ${appOrigin()}/marketplace/${listing.id}`,
      ].join("\n\n"),
    );
  }
  return { endsAt };
}

export function dueReleases(now = new Date(), listingIds?: string[]) {
  return prisma.flowTranche.findMany({
    where: { status: "FIRST_LOOK", firstLookEndsAt: { lte: now }, ...(listingIds ? { listingId: { in: listingIds } } : {}) },
    include: { program: { select: { name: true } } },
  });
}

// Claimed before anything is sent, so an overlapping run alerts nobody twice. The listing then counts as new from
// now, as a coming-soon listing does from its launch: the book's order, the early-access window and the roundups
// all start at the release.
export async function releaseTranche(tranche: { id: string; listingId: string; sequence: number; program: { name: string } }, now = new Date()) {
  const claimed = await prisma.flowTranche.updateMany({ where: { id: tranche.id, status: "FIRST_LOOK" }, data: { status: "RELEASED", releasedAt: now } });
  if (claimed.count !== 1) return false;
  const listing = await prisma.listing.findUnique({ where: { id: tranche.listingId }, select: { id: true, title: true, status: true, launchAt: true, seller: { select: { email: true } } } });
  await audit(null, "FLOW_RELEASED", "listing", tranche.listingId, `Tranche ${tranche.sequence} of ${tranche.program.name}`);
  if (!listing) return true;
  if (listing.status !== "APPROVED") {
    await syncTranche(listing.id);
    return true;
  }
  // A launch still ahead keeps its date, and the launch job alerts the market then.
  if (!launchPending(listing, now)) await prisma.listing.updateMany({ where: { id: listing.id, status: "APPROVED" }, data: { approvedAt: now } });
  await openToMarket(listing.id, now);
  await notify(
    listing.seller.email,
    `Released · ${listing.title}`,
    `The first look for your programme's committed buyers has ended. ${listing.title} is open to the market now under its usual visibility, and matching buyers were told.`,
  );
  return true;
}

async function releaseProgramTranches(programId: string, now: Date) {
  const open = await prisma.flowTranche.findMany({ where: { programId, status: "FIRST_LOOK" }, include: { program: { select: { name: true } } } });
  for (const tranche of open) await releaseTranche(tranche, now).catch((error) => console.error(`[upb-flow] release failed for tranche ${tranche.id}:`, error instanceof Error ? error.message : error));
}

// A tranche follows its listing: in contract or sold is awarded, withdrawn or declined is withdrawn. An award that
// falls through puts it back, so a first look the award cut short ends and releases as usual.
export function trancheStatusFor(tranche: { status: string; releasedAt: Date | null }, listingStatus: string | null) {
  if (tranche.status === "WITHDRAWN") return "WITHDRAWN";
  if (!listingStatus || listingStatus === "WITHDRAWN" || listingStatus === "REJECTED") return "WITHDRAWN";
  if (listingStatus === "PENDING" || listingStatus === "SOLD") return "AWARDED";
  if (tranche.status === "AWARDED") return tranche.releasedAt ? "RELEASED" : "FIRST_LOOK";
  return tranche.status;
}

export async function syncTranche(listingId: string) {
  const tranche = await prisma.flowTranche.findUnique({ where: { listingId }, select: { id: true, status: true, releasedAt: true } });
  if (!tranche) return null;
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { status: true } });
  const next = trancheStatusFor(tranche, listing?.status ?? null);
  if (next !== tranche.status) await prisma.flowTranche.updateMany({ where: { id: tranche.id, status: tranche.status }, data: { status: next } });
  return next;
}

// Awards and withdrawals reach a listing by more paths than tell this module, so each run brings every open tranche
// in line with its listing. A tranche approved without its first look starting, as when the approval failed part
// way, starts it here, or goes to the market.
async function syncTranches(now: Date, listingIds?: string[]) {
  const tranches = await prisma.flowTranche.findMany({
    where: { status: { in: ["FIRST_LOOK", "RELEASED", "AWARDED"] }, ...(listingIds ? { listingId: { in: listingIds } } : {}) },
    select: { id: true, listingId: true, status: true, releasedAt: true, firstLookEndsAt: true },
  });
  if (!tranches.length) return;
  const listings = await prisma.listing.findMany({ where: { id: { in: tranches.map((row) => row.listingId) } }, select: { id: true, status: true } });
  const statusOf = new Map(listings.map((row) => [row.id, row.status as string]));
  for (const tranche of tranches) {
    const listingStatus = statusOf.get(tranche.listingId) ?? null;
    const next = trancheStatusFor(tranche, listingStatus);
    if (next !== tranche.status) await prisma.flowTranche.updateMany({ where: { id: tranche.id, status: tranche.status }, data: { status: next } });
    else if (next === "FIRST_LOOK" && !tranche.firstLookEndsAt && listingStatus === "APPROVED" && !(await startFirstLook(tranche.listingId, now))) {
      await openToMarket(tranche.listingId, now);
    }
  }
}

// The flow job. One bad tranche is logged and counted, and the run goes on to the next.
export async function runFlowReleases(now = new Date(), options: { listingIds?: string[] } = {}): Promise<Tally> {
  const tally: Tally = { sent: 0, failed: 0, error: "" };
  await syncTranches(now, options.listingIds);
  for (const tranche of await dueReleases(now, options.listingIds)) {
    try {
      if (await releaseTranche(tranche, now)) tally.sent += 1;
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200);
      tally.failed += 1;
      tally.error ||= `tranche ${tranche.id}: ${reason}`;
      console.error(`[upb-jobs] flow release failed for tranche ${tranche.id}:`, reason);
    }
  }
  return tally;
}

// ---------------------------------------------------------------------------------------------------------------
// Buyers. The seller or the desk invites an approved buyer; the buyer accepts the terms once and keeps a price grid
// that pre-fills each tranche's bid form. Sellers see counts, never a buyer's grid.

export type GridRow = { paymentStatus: string; lienPosition: string; maxLtv: number | null; pct: number };

function gridRow(raw: { paymentStatus?: unknown; lienPosition?: unknown; maxLtv?: unknown; pct?: unknown }): GridRow | null {
  const pct = Number(String(raw.pct ?? "").replace(/[%\s]/g, ""));
  if (!Number.isFinite(pct) || pct <= 0 || pct > 150) return null;
  const status = String(raw.paymentStatus ?? ANY).toUpperCase();
  const lien = String(raw.lienPosition ?? ANY).toUpperCase();
  const ltv = blank(raw.maxLtv) ? null : Number(String(raw.maxLtv).replace(/[%\s]/g, ""));
  return {
    paymentStatus: STATUSES.includes(status) ? status : ANY,
    lienPosition: LIENS.includes(lien) ? lien : ANY,
    maxLtv: ltv != null && Number.isFinite(ltv) && ltv > 0 ? ltv : null,
    pct: Math.round(pct * 100) / 100,
  };
}

export function gridOf(raw: unknown): GridRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row) => (row && typeof row === "object" ? [gridRow(row as Record<string, unknown>)].filter((item): item is GridRow => item != null) : []));
}

// The form's rows, side by side. A row without a percent is left out; one with a bad figure is refused.
export function readGrid(input: { statuses: unknown[]; liens: unknown[]; ltvs: unknown[]; pcts: unknown[] }) {
  const grid: GridRow[] = [];
  for (let index = 0; index < input.pcts.length; index += 1) {
    if (blank(input.pcts[index])) continue;
    const row = gridRow({ paymentStatus: input.statuses[index], lienPosition: input.liens[index], maxLtv: input.ltvs[index], pct: input.pcts[index] });
    if (!row) return { error: `Row ${index + 1}: enter a percent of UPB between 0 and 150.` } as const;
    if (!blank(input.ltvs[index]) && (row.maxLtv == null || row.maxLtv > 300)) return { error: `Row ${index + 1}: enter the maximum LTV as a percent, or leave it blank.` } as const;
    grid.push(row);
  }
  if (grid.length > GRID_MAX) return { error: `Keep the grid to ${GRID_MAX} rows.` } as const;
  return { error: null, grid } as const;
}

export type GridLoan = { upb: number; estimatedValue: number; lienPosition: string; paymentStatus: string };

// The row that prices a loan: one naming its status and lien beats an "any" row, then the tightest LTV band it fits.
export function gridRowFor(loan: GridLoan, grid: GridRow[]) {
  const ltv = loan.estimatedValue > 0 ? (loan.upb / loan.estimatedValue) * 100 : null;
  const fits = grid.filter(
    (row) =>
      (row.paymentStatus === ANY || row.paymentStatus === loan.paymentStatus) &&
      (row.lienPosition === ANY || row.lienPosition === loan.lienPosition) &&
      (row.maxLtv == null || (ltv != null && ltv <= row.maxLtv)),
  );
  const named = (row: GridRow) => (row.paymentStatus === ANY ? 0 : 2) + (row.lienPosition === ANY ? 0 : 1);
  return [...fits].sort((a, b) => named(b) - named(a) || (a.maxLtv ?? 1e9) - (b.maxLtv ?? 1e9))[0] ?? null;
}

export type GridSuggestion = { amount: number; priced: number; unpriced: number; capped: boolean; cap: number | null; upb: number };

// The bid the grid suggests: each loan's percent times its unpaid balance, added up and held to the buyer's cap per
// tranche. Null when no loan fits a row. It only fills the form.
export function gridSuggestion(loans: GridLoan[], grid: GridRow[], capCents?: number | null): GridSuggestion | null {
  let sum = 0;
  let priced = 0;
  let upb = 0;
  for (const loan of loans) {
    const row = gridRowFor(loan, grid);
    if (!row) continue;
    priced += 1;
    upb += loan.upb;
    sum += (row.pct / 100) * loan.upb;
  }
  if (!priced) return null;
  const cap = capCents != null && capCents > 0 ? capCents / 100 : null;
  const capped = cap != null && sum > cap;
  return { amount: Math.floor(capped && cap != null ? cap : sum), priced, unpriced: loans.length - priced, capped, cap, upb };
}

export function suggestionLine(suggestion: GridSuggestion) {
  const loans = (count: number) => `${count} loan${count === 1 ? "" : "s"}`;
  const parts = [`Pre-filled from your programme grid: ${loans(suggestion.priced)} at ${((suggestion.amount / suggestion.upb) * 100).toFixed(1)}% of their UPB.`];
  if (suggestion.unpriced) parts.push(`${loans(suggestion.unpriced)} ${suggestion.unpriced === 1 ? "sits" : "sit"} outside your grid and add${suggestion.unpriced === 1 ? "s" : ""} nothing.`);
  if (suggestion.capped && suggestion.cap != null) parts.push(`Held to your ${money(suggestion.cap)} cap per tranche.`);
  parts.push("Check the figure before you confirm.");
  return parts.join(" ");
}

export type InviteResult = { invited: string[]; skipped: { email: string; reason: string }[] };

// Each address must belong to a buyer whose file the desk approved. One the seller excludes is skipped, as on a
// private listing. A buyer who left can be asked back, and accepts the terms again.
export async function inviteToProgram(actor: Actor, input: { programId: string; emails: unknown }): Promise<Outcome<InviteResult>> {
  const program = await prisma.flowProgram.findUnique({ where: { id: input.programId } });
  const desk = actor.role === "ADMIN";
  if (!program || (!desk && program.sellerId !== actor.id)) return fail(NOT_YOURS);
  if (desk && !deskCan(actor, "sales")) return fail(DESK_DENIED);
  if (program.status !== "OPEN") return fail("Buyers join an open programme.");
  const { emails, bad } = readEmails(input.emails);
  if (bad.length) return fail(`Check ${bad.length === 1 ? "this address" : "these addresses"}: ${bad.slice(0, 5).join(", ")}.`);
  if (!emails.length) return fail("Enter one or more email addresses.");
  if (emails.length > INVITES_AT_ONCE) return fail(`Invite up to ${INVITES_AT_ONCE} addresses at a time.`);
  const { consumeRateLimit } = await import("@/lib/rate-limit");
  if (!desk && !(await consumeRateLimit(`flow-invite:${actor.id}`, INVITE_BATCHES, HOUR))) return fail("That is a lot of invitations in an hour. Try again shortly.");
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, email: true, role: true, accountStatus: true, companyName: true } });
  const ids = users.map((user) => user.id);
  const [profiles, existing, exclusions, people, seller] = await Promise.all([
    prisma.buyerProfile.findMany({ where: { userId: { in: ids } }, select: { userId: true, status: true } }),
    prisma.flowCommitment.findMany({ where: { programId: program.id, buyerId: { in: ids } } }),
    prisma.sellerExclusion.findMany({ where: { sellerId: program.sellerId }, select: { sellerId: true, buyerId: true, email: true, company: true } }),
    peopleOf(users),
    sellerName(program.sellerId),
  ]);
  const fileOf = new Map(profiles.map((row) => [row.userId, row.status as string]));
  const held = new Map(existing.map((row) => [row.buyerId, row]));
  const result: InviteResult = { invited: [], skipped: [] };
  for (const email of emails) {
    const user = users.find((row) => row.email.toLowerCase() === email);
    const approved = user && user.role === "BUYER" && canSubmitOffer({ role: user.role, accountStatus: user.accountStatus, verificationStatus: fileOf.get(user.id) ?? null }).ok;
    if (!user || !approved) {
      result.skipped.push({ email, reason: "not an approved buyer" });
      continue;
    }
    const person = people.find((row) => row.id === user.id);
    if (person && exclusions.some((row) => excludes(row, person))) {
      result.skipped.push({ email, reason: "on the seller's excluded buyers" });
      continue;
    }
    const current = held.get(user.id);
    if (current && current.status !== "ENDED") {
      result.skipped.push({ email, reason: "already in the programme" });
      continue;
    }
    if (current) {
      await prisma.flowCommitment.updateMany({ where: { id: current.id, status: "ENDED" }, data: { status: "INVITED", invitedById: actor.id, acceptedAt: null, termsVersion: null } });
    } else {
      await prisma.flowCommitment.create({ data: { programId: program.id, buyerId: user.id, status: "INVITED", invitedById: actor.id } });
    }
    await notify(
      user.email,
      `Forward-flow programme · ${program.name}`,
      [
        `${seller.name} invites you to ${program.name}, a forward-flow programme on UPB Capital. Tranches come ${program.cadence === "AD_HOC" ? "as the seller has loans" : cadenceLabel(program.cadence).toLowerCase()}, and committed buyers see each one for ${program.firstLookHours} hours before the market.`,
        "Read the terms and join here. You accept them once, set a price grid that pre-fills your bids, and confirm every bid yourself.",
        `${appOrigin()}/buyer/flow`,
      ].join("\n\n"),
    );
    result.invited.push(email);
  }
  if (result.invited.length) await audit(actor.id, "FLOW_INVITE", "flowProgram", program.id, result.invited.join(", "));
  return { ok: true, value: result };
}

async function ownCommitment(buyer: Actor, commitmentId: string) {
  const commitment = await prisma.flowCommitment.findUnique({ where: { id: commitmentId }, include: { program: true } });
  return commitment && commitment.buyerId === buyer.id ? commitment : null;
}

const NOT_IN = "That programme invitation isn't yours.";

// The terms are accepted once, against the version the buyer read. The buyer's file must still be approved.
export async function acceptTerms(buyer: Actor, input: { commitmentId: string; version: unknown }, now = new Date()): Promise<Outcome<{ version: string }>> {
  const commitment = await ownCommitment(buyer, input.commitmentId);
  if (!commitment) return fail(NOT_IN);
  if (commitment.status !== "INVITED") return fail("You already answered this invitation.");
  if (commitment.program.status !== "OPEN" && commitment.program.status !== "PAUSED") return fail("This programme is closed.");
  const version = termsVersion(commitment.program.terms);
  if (String(input.version ?? "") !== version) return fail("The terms changed since you opened the page. Read them again before you accept.");
  const [user, profile] = await Promise.all([
    prisma.user.findUnique({ where: { id: buyer.id }, select: { role: true, accountStatus: true } }),
    prisma.buyerProfile.findUnique({ where: { userId: buyer.id }, select: { status: true } }),
  ]);
  if (!user || !canSubmitOffer({ role: user.role, accountStatus: user.accountStatus, verificationStatus: profile?.status ?? null }).ok || user.role !== "BUYER") {
    return fail("Your buyer file needs the desk's approval before you join a programme.");
  }
  const accepted = await prisma.flowCommitment.updateMany({ where: { id: commitment.id, status: "INVITED" }, data: { status: "ACTIVE", acceptedAt: now, termsVersion: version } });
  if (accepted.count !== 1) return fail("You already answered this invitation.");
  await audit(buyer.id, "FLOW_TERMS_ACCEPTED", "flowProgram", commitment.programId, `${commitment.program.name} · terms version ${version}`);
  return { ok: true, value: { version } };
}

export async function setGrid(buyer: Actor, input: { commitmentId: string; grid: GridRow[]; cap: unknown }): Promise<Outcome<null>> {
  const commitment = await ownCommitment(buyer, input.commitmentId);
  if (!commitment) return fail(NOT_IN);
  if (commitment.status === "ENDED") return fail("You left this programme.");
  const cap = dollarsOf(input.cap);
  if (!blank(input.cap) && cap == null) return fail("Enter your cap per tranche in dollars, or leave it blank.");
  if (cap != null && Math.round(cap * 100) > MAX_CENTS) return fail(`Enter a cap per tranche up to ${money(MAX_CENTS / 100)}.`);
  await prisma.flowCommitment.update({ where: { id: commitment.id }, data: { grid: input.grid, maxPerTrancheCents: cap == null ? null : Math.round(cap * 100) } });
  await audit(buyer.id, "FLOW_GRID_SET", "flowProgram", commitment.programId, `${input.grid.length} row${input.grid.length === 1 ? "" : "s"}${cap != null ? ` · cap ${money(cap)}` : ""}`);
  return { ok: true, value: null };
}

const BUYER_MOVES: Record<string, { from: string[]; to: string; action: string }> = {
  DECLINE: { from: ["INVITED"], to: "ENDED", action: "FLOW_INVITE_DECLINED" },
  PAUSE: { from: ["ACTIVE"], to: "PAUSED", action: "FLOW_PAUSED" },
  RESUME: { from: ["PAUSED"], to: "ACTIVE", action: "FLOW_RESUMED" },
  LEAVE: { from: ["ACTIVE", "PAUSED"], to: "ENDED", action: "FLOW_LEFT" },
};

// Paused, a buyer sees no tranche first until they resume. Left, they need a new invitation. Open bids stand.
export async function moveCommitment(buyer: Actor, input: { commitmentId: string; move: unknown }): Promise<Outcome<{ status: string }>> {
  const move = BUYER_MOVES[String(input.move ?? "")];
  if (!move) return fail("Choose pause, resume or leave.");
  const commitment = await ownCommitment(buyer, input.commitmentId);
  if (!commitment) return fail(NOT_IN);
  if (!move.from.includes(commitment.status)) return fail("Your place in this programme changed a moment ago. Reload the page.");
  if (move.to === "ACTIVE" && commitment.termsVersion !== termsVersion(commitment.program.terms)) return fail("Accept the programme's current terms before you resume.");
  if (move.to === "ACTIVE" && commitment.program.status === "CLOSED") return fail("This programme is closed.");
  const moved = await prisma.flowCommitment.updateMany({ where: { id: commitment.id, status: commitment.status }, data: { status: move.to } });
  if (moved.count !== 1) return fail("Your place in this programme changed a moment ago. Reload the page.");
  await audit(buyer.id, move.action, "flowProgram", commitment.programId, commitment.program.name);
  return { ok: true, value: { status: move.to } };
}

// ---------------------------------------------------------------------------------------------------------------
// The listing page: the first-look banner, and the bid the buyer's grid suggests.

export type FirstLookView = { endsAt: Date | null; programName: string; suggestion: (GridSuggestion & { line: string }) | null };

export async function firstLookView(listingId: string, viewer: { id: string; role: string }, loans: GridLoan[]): Promise<FirstLookView | null> {
  const tranche = await prisma.flowTranche.findUnique({ where: { listingId }, include: { program: { select: { name: true } } } });
  if (!tranche || (tranche.status !== "FIRST_LOOK" && tranche.status !== "RELEASED")) return null;
  const commitment =
    viewer.role === "BUYER" ? await prisma.flowCommitment.findUnique({ where: { programId_buyerId: { programId: tranche.programId, buyerId: viewer.id } } }) : null;
  const found = commitment?.status === "ACTIVE" ? gridSuggestion(loans, gridOf(commitment.grid), commitment.maxPerTrancheCents) : null;
  const endsAt = tranche.status === "FIRST_LOOK" ? tranche.firstLookEndsAt : null;
  if (!endsAt && !found) return null;
  return { endsAt, programName: tranche.program.name, suggestion: found ? { ...found, line: suggestionLine(found) } : null };
}

// ---------------------------------------------------------------------------------------------------------------
// What the seller and the desk read.

type CommitmentCounts = Record<"INVITED" | "ACTIVE" | "PAUSED" | "ENDED", number>;

function countCommitments(rows: { programId: string; status: string }[]) {
  const counts = new Map<string, CommitmentCounts>();
  for (const row of rows) {
    const entry = counts.get(row.programId) ?? { INVITED: 0, ACTIVE: 0, PAUSED: 0, ENDED: 0 };
    if (row.status in entry) entry[row.status as keyof CommitmentCounts] += 1;
    counts.set(row.programId, entry);
  }
  return counts;
}

const EMPTY_COUNTS: CommitmentCounts = { INVITED: 0, ACTIVE: 0, PAUSED: 0, ENDED: 0 };

export async function commitmentCounts(programId: string) {
  const rows = await prisma.flowCommitment.findMany({ where: { programId }, select: { programId: true, status: true } });
  return countCommitments(rows).get(programId) ?? EMPTY_COUNTS;
}

// Programmes with their tranche and commitment counts, newest first. No buyer is named.
export async function programList(where: { sellerId?: string } = {}) {
  const programs = await prisma.flowProgram.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: { tranches: { select: { id: true, status: true, firstLookEndsAt: true, listingId: true, sequence: true } } },
    take: 200,
  });
  const ids = programs.map((program) => program.id);
  const [commitments, sellers] = await Promise.all([
    ids.length ? prisma.flowCommitment.findMany({ where: { programId: { in: ids } }, select: { programId: true, status: true } }) : [],
    prisma.user.findMany({ where: { id: { in: [...new Set(programs.map((program) => program.sellerId))] } }, select: { id: true, name: true, companyName: true } }),
  ]);
  const counts = countCommitments(commitments);
  const sellerOf = new Map(sellers.map((seller) => [seller.id, seller.companyName || seller.name]));
  return programs.map((program) => ({ ...program, seller: sellerOf.get(program.sellerId) ?? "", commitments: counts.get(program.id) ?? EMPTY_COUNTS }));
}

export type TrancheReport = {
  id: string;
  sequence: number;
  status: string;
  firstLookEndsAt: Date | null;
  releasedAt: Date | null;
  listing: { id: string; title: string; status: string } | null;
  loans: number;
  upb: number;
  flagged: number;
  firstLookBids: number;
  marketBids: number;
  awardPct: number | null;
  committedBidders: number;
  committed: number;
};

// Each tranche: its loans and UPB, bids in the first look against bids after the release, the award as a percent of
// UPB, and how many of the programme's committed buyers bid. Counts only: no bidder and no bid amount but the award.
export async function trancheReports(programId: string, now = new Date()): Promise<TrancheReport[]> {
  const [program, tranches, commitments] = await Promise.all([
    prisma.flowProgram.findUnique({ where: { id: programId }, select: { criteria: true } }),
    prisma.flowTranche.findMany({ where: { programId }, orderBy: { sequence: "asc" } }),
    prisma.flowCommitment.findMany({ where: { programId }, select: { buyerId: true, acceptedAt: true } }),
  ]);
  if (!tranches.length) return [];
  const listingIds = tranches.map((tranche) => tranche.listingId);
  const [listings, bids] = await Promise.all([
    prisma.listing.findMany({ where: { id: { in: listingIds } }, select: { id: true, title: true, status: true, notes: { select: LOAN_FIELDS } } }),
    prisma.inquiry.findMany({ where: { listingId: { in: listingIds }, type: "OFFER" }, select: { listingId: true, buyerId: true, status: true, amount: true, createdAt: true } }),
  ]);
  const criteria = criteriaOf(program?.criteria);
  const committed = new Set(commitments.filter((row) => row.acceptedAt).map((row) => row.buyerId));
  const byId = new Map(listings.map((listing) => [listing.id, listing]));
  return tranches.map((tranche) => {
    const listing = byId.get(tranche.listingId) ?? null;
    const loans = listing?.notes ?? [];
    const upb = loans.reduce((sum, note) => sum + Number(note.upb), 0);
    const own = bids.filter((bid) => bid.listingId === tranche.listingId);
    const released = tranche.releasedAt;
    const accepted = own.filter((bid) => bid.status === "ACCEPTED");
    const award = accepted.reduce((sum, bid) => sum + Number(bid.amount ?? 0), 0);
    return {
      id: tranche.id,
      sequence: tranche.sequence,
      status: tranche.status,
      firstLookEndsAt: tranche.firstLookEndsAt,
      releasedAt: released,
      listing: listing ? { id: listing.id, title: listing.title, status: listing.status } : null,
      loans: loans.length,
      upb,
      flagged: criteriaFlags(loans, criteria, now).length,
      firstLookBids: own.filter((bid) => !released || bid.createdAt < released).length,
      marketBids: own.filter((bid) => released && bid.createdAt >= released).length,
      awardPct: accepted.length && upb > 0 ? (award / upb) * 100 : null,
      committedBidders: new Set(own.filter((bid) => committed.has(bid.buyerId)).map((bid) => bid.buyerId)).size,
      committed: committed.size,
    };
  });
}

// For the desk's review of one listing: whether it is a programme's tranche, and which of its loans sit outside the
// programme's criteria.
export async function deskTranche(listingId: string, now = new Date()) {
  const tranche = await prisma.flowTranche.findUnique({ where: { listingId }, include: { program: { select: { id: true, name: true, criteria: true, firstLookHours: true } } } });
  if (!tranche) return null;
  const loans = await prisma.note.findMany({ where: { listingId }, select: LOAN_FIELDS });
  return { ...tranche, loans: loans.length, flags: criteriaFlags(loans, criteriaOf(tranche.program.criteria), now) };
}

// The desk's view of each commitment: who, where they stand, their grid and cap. Never shown to the seller.
export async function deskCommitments(programId: string) {
  const rows = await prisma.flowCommitment.findMany({ where: { programId }, orderBy: { createdAt: "asc" } });
  const users = rows.length ? await prisma.user.findMany({ where: { id: { in: rows.map((row) => row.buyerId) } }, select: { id: true, name: true, email: true, companyName: true } }) : [];
  const byId = new Map(users.map((user) => [user.id, user]));
  return rows.map((row) => ({ ...row, grid: gridOf(row.grid), buyer: byId.get(row.buyerId) ?? null }));
}

// A buyer's programmes: those they are in or invited to, with each one's tranches in first look now.
export async function buyerPrograms(buyerId: string) {
  const rows = await prisma.flowCommitment.findMany({ where: { buyerId }, include: { program: true }, orderBy: { createdAt: "desc" } });
  if (!rows.length) return [];
  const programIds = rows.map((row) => row.programId);
  const [tranches, sellers] = await Promise.all([
    prisma.flowTranche.findMany({ where: { programId: { in: programIds }, status: "FIRST_LOOK", firstLookEndsAt: { not: null } }, orderBy: { sequence: "asc" } }),
    prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.program.sellerId))] } }, select: { id: true, name: true, companyName: true } }),
  ]);
  const titles = tranches.length
    ? await prisma.listing.findMany({ where: { id: { in: tranches.map((tranche) => tranche.listingId) }, status: "APPROVED" }, select: { id: true, title: true } })
    : [];
  const titleOf = new Map(titles.map((row) => [row.id, row.title]));
  const sellerOf = new Map(sellers.map((seller) => [seller.id, seller.companyName || seller.name]));
  return rows.map((row) => ({
    ...row,
    grid: gridOf(row.grid),
    criteria: criteriaOf(row.program.criteria),
    version: termsVersion(row.program.terms),
    seller: sellerOf.get(row.program.sellerId) ?? "",
    // Only an active buyer is shown the tranches, since only they can open them.
    open:
      row.status === "ACTIVE"
        ? tranches
            .filter((tranche) => tranche.programId === row.programId && titleOf.has(tranche.listingId))
            .map((tranche) => ({ listingId: tranche.listingId, title: titleOf.get(tranche.listingId) ?? "", sequence: tranche.sequence, endsAt: tranche.firstLookEndsAt }))
        : [],
  }));
}

// Hours and minutes left, for the desk's and the buyer's timers.
export function timeLeft(endsAt: Date, now = new Date()) {
  const left = endsAt.getTime() - now.getTime();
  if (left <= 0) return "ended";
  const hours = Math.floor(left / HOUR);
  const minutes = Math.floor((left % HOUR) / 60000);
  return hours >= 1 ? `${hours}h ${minutes}m left` : `${minutes}m left`;
}
