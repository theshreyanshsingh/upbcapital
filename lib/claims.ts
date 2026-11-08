import type { RepurchaseClaim } from "@prisma/client";
import { CURE_DAYS, REPURCHASE_DAYS } from "@/lib/agreements";
import { closingLoans } from "@/lib/closing";
import { unset } from "@/lib/db-filters";
import { DESK_DENIED, deskCan, type Staff } from "@/lib/desk-roles";
import { notify, notifyDesk } from "@/lib/email";
import { money, prettyDate } from "@/lib/format";
import { eachItem, type Tally } from "@/lib/jobs";
import { pricesFor } from "@/lib/loan-prices";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { extensionOf, mimeFor, putBytes, safeBasename } from "@/lib/storage";
import { uploadProblem } from "@/lib/uploads";

// Repurchase claims after closing. A buyer who finds a seller representation untrue files within the survival
// window, the seller answers, and the desk decides when the two don't agree. UPB moves no money: the decision says
// what the seller owes under the agreement, and the parties settle it between themselves. Where UPB is itself a party
// to the deal, no desk member decides. Claim files stay with the claimant, the seller and the desk. Each step is an
// audit row on the claim, which is also its timeline.

const DAY = 24 * 60 * 60 * 1000;

export const DEFAULT_SURVIVAL_DAYS = REPURCHASE_DAYS;
export const DEFAULT_RESPONSE_DAYS = 10;
// The seller hears this many days before their answer is due.
export const CLAIM_REMIND_DAYS = 2;
export const MAX_CLAIM_FILES = 5;
const MAX_CLAIM_BYTES = 20 * 1024 * 1024;

// What the settings page accepts, in whole days. A stored value outside them reads as the default.
export const SURVIVAL_DAY_BOUNDS = [30, 730] as const;
export const RESPONSE_DAY_BOUNDS = [3, 30] as const;

const within = (value: number | null | undefined, [low, high]: readonly [number, number]): value is number =>
  value != null && Number.isInteger(value) && value >= low && value <= high;

export function survivalDaysOf(setting: number | null | undefined) {
  return within(setting, SURVIVAL_DAY_BOUNDS) ? setting : DEFAULT_SURVIVAL_DAYS;
}

export function responseDaysOf(setting: number | null | undefined) {
  return within(setting, RESPONSE_DAY_BOUNDS) ? setting : DEFAULT_RESPONSE_DAYS;
}

// The settings form's two fields: whole days within the bounds, or blank for the default.
export function readClaimSettings(raw: { repSurvivalDays: unknown; claimResponseDays: unknown }) {
  const read = (value: unknown, bounds: readonly [number, number]) => {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return null;
    return /^\d+$/.test(text) && within(Number(text), bounds) ? Number(text) : Number.NaN;
  };
  const repSurvivalDays = read(raw.repSurvivalDays, SURVIVAL_DAY_BOUNDS);
  const claimResponseDays = read(raw.claimResponseDays, RESPONSE_DAY_BOUNDS);
  if (Number.isNaN(repSurvivalDays)) {
    return { error: `Set the claim window as whole days from ${SURVIVAL_DAY_BOUNDS[0]} to ${SURVIVAL_DAY_BOUNDS[1]}, or leave it blank for ${DEFAULT_SURVIVAL_DAYS}.` } as const;
  }
  if (Number.isNaN(claimResponseDays)) {
    return { error: `Set the seller's answer time as whole days from ${RESPONSE_DAY_BOUNDS[0]} to ${RESPONSE_DAY_BOUNDS[1]}, or leave it blank for ${DEFAULT_RESPONSE_DAYS}.` } as const;
  }
  return { error: null, repSurvivalDays, claimResponseDays } as const;
}

export function claimWindowEnd(closedAt: Date, days: number) {
  return new Date(closedAt.getTime() + days * DAY);
}

// The representations in the master sale agreement (lib/agreements.ts), in the words a buyer would use.
export const CLAIM_REPS = ["TITLE", "LIEN_POSITION", "BALANCE", "PAY_HISTORY", "DOCUMENTS", "OCCUPANCY", "LITIGATION", "OTHER"] as const;
export type ClaimRep = (typeof CLAIM_REPS)[number];

export const REP_TEXT: Record<ClaimRep, { label: string; text: string }> = {
  TITLE: { label: "Ownership and title", text: "The seller was the sole owner and holder of the note and the mortgage, with no other lien, pledge or interest in them beyond what it disclosed." },
  LIEN_POSITION: { label: "Lien and lien position", text: "The mortgage is a valid lien on the collateral the tape describes, in the lien position the tape states, and was not released, subordinated or modified beyond what the file shows." },
  BALANCE: { label: "Balance and terms on the tape", text: "The balance, rate and next due date on the tape were true in all material respects as of its cut-off date." },
  PAY_HISTORY: { label: "Payment history and status", text: "The payment history and status on the tape were true in all material respects as of its cut-off date." },
  DOCUMENTS: { label: "Chain of title and collateral file", text: "Every endorsement or allonge and every recorded assignment runs from the original lender to the seller, or the seller delivered what was missing or a lost note affidavit." },
  OCCUPANCY: { label: "Collateral and occupancy", text: "The collateral and its occupancy are as the tape and the files describe them." },
  LITIGATION: { label: "Disclosed bankruptcy, foreclosure and lawsuits", text: "The seller disclosed every bankruptcy, foreclosure, modification, forbearance, loss mitigation request, lawsuit and borrower complaint on the loan it knew of." },
  OTHER: { label: "Another representation", text: "Another warranty or representation in the master sale agreement, such as servicing compliance, or nothing the seller gave being false or misleading." },
};

export const CLAIM_REMEDIES = ["REPURCHASE", "PRICE_ADJUSTMENT", "CURE"] as const;
export type ClaimRemedy = (typeof CLAIM_REMEDIES)[number];

export const REMEDY_LABELS: Record<ClaimRemedy, string> = {
  REPURCHASE: "Repurchase at the agreement's repurchase price",
  PRICE_ADJUSTMENT: "A price adjustment",
  CURE: "A cure",
};

export const CLAIM_STATUS_LABELS: Record<string, string> = {
  FILED: "Waiting on the seller",
  ANSWERED: "Answered by the seller",
  UNDER_REVIEW: "With the desk",
  UPHELD: "Upheld",
  PARTLY_UPHELD: "Partly upheld",
  DENIED: "Denied",
  CURED: "Cured",
  SETTLED: "Settled",
  WITHDRAWN: "Withdrawn",
};

// Before a decision. A claim here blocks a second one on the same loan and representation.
export const OPEN_STATUSES = ["FILED", "ANSWERED", "UNDER_REVIEW"] as const;
// Decided for the buyer, with the parties still to settle.
export const SETTLING_STATUSES = ["UPHELD", "PARTLY_UPHELD"] as const;
export const DECISIONS = ["UPHELD", "PARTLY_UPHELD", "DENIED", "CURED", "SETTLED"] as const;
export type ClaimDecision = (typeof DECISIONS)[number];
const FINAL = ["DENIED", "CURED", "SETTLED", "WITHDRAWN"];
// A decision that says the seller owes something, so it needs a figure.
const OWING = ["UPHELD", "PARTLY_UPHELD", "SETTLED"];

export const ANSWER_KINDS = ["ACCEPT", "DISPUTE", "CURE"] as const;
export type AnswerKind = (typeof ANSWER_KINDS)[number];

export const ANSWER_LABELS: Record<AnswerKind, string> = {
  ACCEPT: "Accepted the claim",
  DISPUTE: "Disputed the claim",
  CURE: "Answered with a cure",
};

const isOne = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);
export const isRep = (value: unknown): value is ClaimRep => isOne(CLAIM_REPS, value);
export const isRemedy = (value: unknown): value is ClaimRemedy => isOne(CLAIM_REMEDIES, value);
export const isDecision = (value: unknown): value is ClaimDecision => isOne(DECISIONS, value);
export const isAnswerKind = (value: unknown): value is AnswerKind => isOne(ANSWER_KINDS, value);

// Where UPB is a party, nothing waits on the desk: an unanswered or disputed claim is simply not agreed.
export function statusLabel(status: string, deskParty = false) {
  if (deskParty && status === "UNDER_REVIEW") return "Not agreed";
  return CLAIM_STATUS_LABELS[status] ?? status.replaceAll("_", " ").toLowerCase();
}

// The seller's answer is stored as its kind and its explanation, "DISPUTE: The pay history on the tape...".
export function answerText(kind: AnswerKind, text: string) {
  return text ? `${kind}: ${text}` : kind;
}

export function readAnswer(response: string | null | undefined): { kind: AnswerKind; text: string } | null {
  if (!response) return null;
  const match = /^(ACCEPT|DISPUTE|CURE)(?::\s?([\s\S]*))?$/.exec(response);
  if (!match) return { kind: "DISPUTE", text: response };
  return { kind: match[1] as AnswerKind, text: (match[2] ?? "").trim() };
}

function clean(value: unknown, max: number) {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim().slice(0, max) : "";
}

function dollarsToCents(raw: unknown) {
  const text = String(raw ?? "").replace(/[$,\s]/g, "");
  if (!text) return null;
  const amount = Number(text);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : Number.NaN;
}

// ---------------------------------------------------------------------------------------------------------------
// The rules, without the database.

// UPB is a party when it buys for its own book, or when the seller or anyone on the buyer side is a desk account. The
// desk can't judge its own deal, so the parties settle such a claim, or take a dispute under the master agreements'
// governing law article (lib/agreements.ts), which has no arbitration or venue terms until counsel sets them.
export function deskIsParty(input: { deskBidId: string | null; partyRoles: string[] }) {
  return Boolean(input.deskBidId) || input.partyRoles.includes("ADMIN");
}

export const DESK_PARTY_TEXT =
  "UPB is a party to this deal, so it can't decide this claim. The two sides settle it between themselves, and a dispute goes under the governing law terms of the master agreements, where counsel is still to set arbitration and venue.";
export const DESK_PARTY_REFUSAL = "UPB is a party to this deal, so no desk member decides this claim.";

// Why this account can't file on this closing now, or null. The buyer, or any seat on a group closing, files on a
// closing that closed, within the survival window. On the desk's own purchase UPB is the buyer, and a desk-book
// member files for it.
export function filingProblem(input: {
  closing: { status: string; closedAt: Date | null; deskBidId: string | null };
  userId: string;
  buyerIds: string[];
  survivalDays: number;
  now: Date;
  deskBook?: boolean;
}) {
  if (input.closing.deskBidId ? !input.deskBook : !input.buyerIds.includes(input.userId)) {
    return input.closing.deskBidId ? "UPB bought these loans for its own book, so a desk-book member files the claim for it." : "Only the buyer on this closing can file a claim.";
  }
  if (input.closing.status !== "COMPLETE" || !input.closing.closedAt) return "A claim can be filed once the closing has closed.";
  const end = claimWindowEnd(input.closing.closedAt, input.survivalDays);
  if (input.now.getTime() > end.getTime()) return `The window for claims closed on ${prettyDate(end)}, ${input.survivalDays} days after closing.`;
  return null;
}

// The buyer who filed, the seller and the desk read a claim's files. Other seats on a group closing see the claim,
// not its evidence.
export function canReadClaimFile(input: { role: string; userId: string; filedById: string; sellerId: string }) {
  return input.role === "ADMIN" || input.userId === input.filedById || input.userId === input.sellerId;
}

export function answerProblem(claim: { status: string; sellerId: string; sellerRespondedAt: Date | null }, userId: string) {
  if (userId !== claim.sellerId) return "Only the seller answers a claim.";
  if (claim.sellerRespondedAt) return "The seller has already answered this claim.";
  // A late answer still reaches the desk while it reviews.
  if (claim.status !== "FILED" && claim.status !== "UNDER_REVIEW") return "This claim is past the seller's answer.";
  return null;
}

// The desk decides once the seller has answered, or once their time is up. Where UPB is a party, no desk member does;
// otherwise anyone on the closing, on either side, leaves it to another desk member.
export function decisionProblem(input: {
  actor: Staff & { id: string };
  claim: { status: string; respondBy: Date };
  partyIds: string[];
  deskParty: boolean;
  outcome: unknown;
  amountCents: number | null;
  now: Date;
}) {
  if (input.deskParty) return DESK_PARTY_REFUSAL;
  if (!deskCan(input.actor, "compliance")) return DESK_DENIED;
  if (input.partyIds.includes(input.actor.id)) return "You are a party to this closing, so another desk member decides the claim.";
  const waiting = input.claim.status === "ANSWERED" || input.claim.status === "UNDER_REVIEW" || (input.claim.status === "FILED" && input.claim.respondBy.getTime() <= input.now.getTime());
  if (!waiting) return input.claim.status === "FILED" ? "The seller still has time to answer." : "This claim is already decided.";
  if (!isDecision(input.outcome)) return "Choose the outcome.";
  if (OWING.includes(input.outcome) && (input.amountCents == null || Number.isNaN(input.amountCents))) return "Enter what the seller owes under the agreement, or 0 where it owes a cure.";
  return null;
}

// What the claim clock does with a claim now: remind the seller, move it to the desk, or nothing.
export function claimDue(claim: { status: string; respondBy: Date; sellerRespondedAt: Date | null }, now: Date): "remind" | "overdue" | null {
  if (claim.status !== "FILED" || claim.sellerRespondedAt) return null;
  const left = claim.respondBy.getTime() - now.getTime();
  if (left <= 0) return "overdue";
  return left <= CLAIM_REMIND_DAYS * DAY ? "remind" : null;
}

// The price paid for one loan and its share of the buyer premium: the price on the loan schedule, or the loan's share
// of the pool price by unpaid principal, as the agreement's repurchase article says. The repurchase price adds the
// buyer's documented costs and takes off principal collected since closing, which only the parties know.
export function loanPriceCents(input: { salePrice: number; buyerPremiumCents: number; loans: { id: string; upb: number }[]; loanPrices: unknown; noteId: string }) {
  const saleCents = Math.round(input.salePrice * 100);
  if (input.loans.length <= 1) return { priceCents: saleCents, premiumCents: input.buyerPremiumCents };
  const prices = pricesFor(input.loanPrices, input.loans.map((loan) => loan.id), input.salePrice);
  const totalUpb = input.loans.reduce((sum, loan) => sum + Math.max(0, loan.upb), 0);
  const upb = Math.max(0, input.loans.find((loan) => loan.id === input.noteId)?.upb ?? 0);
  const priceCents = prices?.[input.noteId] != null
    ? Math.round(prices[input.noteId] * 100)
    : totalUpb > 0 ? Math.round((saleCents * upb) / totalUpb) : Math.round(saleCents / input.loans.length);
  return { priceCents, premiumCents: saleCents > 0 ? Math.round((input.buyerPremiumCents * priceCents) / saleCents) : 0 };
}

// What the decision tells both sides the seller owes. UPB moves no money either way.
export function decisionStatement(outcome: ClaimDecision, outcomeCents: number | null, remedy: string) {
  const owed = outcomeCents ? money(outcomeCents / 100, 2) : null;
  const settle = "The buyer and the seller settle it between themselves, and UPB moves no money. Each side confirms on the closing page once it is settled.";
  const owes = owed
    ? `Under the agreement the seller owes ${owed}${remedy === "REPURCHASE" && outcome === "UPHELD" ? ", the repurchase price, against the loan's return" : ""}.`
    : `Under the agreement the seller cures the breach within ${CURE_DAYS} days.`;
  if (outcome === "UPHELD") return `The desk upheld the claim. ${owes} ${settle}`;
  if (outcome === "PARTLY_UPHELD") return `The desk upheld part of the claim. ${owes} ${settle}`;
  if (outcome === "DENIED") return "The desk denied the claim. The seller owes nothing under the agreement for it.";
  if (outcome === "CURED") return "The desk found the breach cured. The seller owes nothing more for it.";
  return `The desk recorded the claim as settled between the parties${owed ? ` for ${owed}` : ""}.`;
}

export type ClaimUpload = { name: string; type?: string; bytes: Buffer };

export function uploadsProblem(uploads: ClaimUpload[]) {
  if (uploads.length > MAX_CLAIM_FILES) return `Attach up to ${MAX_CLAIM_FILES} files at a time.`;
  if (uploads.reduce((sum, upload) => sum + upload.bytes.length, 0) > MAX_CLAIM_BYTES) return "Those files are over 20 MB together. Send fewer at a time.";
  for (const upload of uploads) {
    const problem = uploadProblem(upload.name, upload.bytes.length, upload.bytes);
    if (problem) return `${upload.name.slice(0, 80)}: ${problem}`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The database side.

const appUrl = () => process.env.NEXT_PUBLIC_APP_URL || "";
const claimLink = (closingId: string) => `${appUrl()}/closings/${closingId}#claims`;

// A claim event, dated by the caller so the timeline and the settlement check read the same clock.
async function claimEvent(actorId: string | null, action: string, claimId: string, detail: string, at: Date) {
  await prisma.auditEvent.create({ data: { actorId, action, entityType: "claim", entityId: claimId, detail: detail.slice(0, 500), createdAt: at } });
}

async function saveClaimFiles(claimId: string, userId: string, uploads: ClaimUpload[], at: Date) {
  for (const upload of uploads) {
    const ext = extensionOf(upload.name);
    if (!ext) continue;
    const mime = mimeFor(ext, upload.type || "application/octet-stream");
    const storageKey = `claims/${claimId}/${crypto.randomUUID()}-${safeBasename(upload.name)}`;
    await putBytes(storageKey, upload.bytes, mime);
    await prisma.claimFile.create({
      data: { claimId, uploadedById: userId, originalName: upload.name.slice(0, 180), storageKey, mime, size: upload.bytes.length, createdAt: at },
    });
  }
}

// The closing a claim sits on, with both sides.
async function claimClosing(closingId: string) {
  const closing = await prisma.closing.findUnique({
    where: { id: closingId },
    include: {
      listing: { select: { title: true, sellerId: true, seller: { select: { email: true } }, notes: { select: { id: true, streetAddress: true, city: true, state: true, upb: true } } } },
      funders: { select: { userId: true } },
    },
  });
  if (!closing) return null;
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, select: { buyerId: true, loanPrices: true } }) : null;
  const buyerIds = [...new Set([inquiry?.buyerId, ...closing.funders.map((funder) => funder.userId)].filter((id): id is string => Boolean(id)))];
  const partyIds = [...new Set([...buyerIds, closing.listing.sellerId])];
  return { closing, inquiry, buyerIds, partyIds, deskParty: await deskPartyOn(closing, partyIds) };
}

export async function deskPartyOn(closing: { deskBidId: string | null }, partyIds: string[]) {
  if (closing.deskBidId) return true;
  const parties = await prisma.user.findMany({ where: { id: { in: partyIds } }, select: { role: true } });
  return deskIsParty({ deskBidId: null, partyRoles: parties.map((party) => party.role) });
}

export function loanLabel(note: { streetAddress?: string | null; city: string; state: string } | null | undefined) {
  if (!note) return "the loan";
  return `${note.streetAddress ? `${note.streetAddress}, ` : ""}${note.city}, ${note.state}`;
}

async function emailsOf(ids: string[]) {
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } });
  return new Map(users.map((user) => [user.id, user.email]));
}

// The buyer who filed and the seller hear about every step. The desk hears where it has something to do or know.
async function tellParties(claim: { filedById: string; sellerId: string }, subject: string, body: string) {
  const emails = await emailsOf([claim.filedById, claim.sellerId]);
  for (const id of [claim.filedById, claim.sellerId]) {
    const email = emails.get(id);
    if (email) await notify(email, subject, body);
  }
}

type Result = { error: string } | { error: null; claim: RepurchaseClaim };

export async function fileClaim(
  user: Staff & { id: string },
  input: { closingId: string; rep: unknown; noteId?: unknown; description: unknown; remedy: unknown; amount?: unknown; files?: ClaimUpload[] },
  now = new Date(),
): Promise<Result> {
  const loaded = await claimClosing(input.closingId);
  if (!loaded) return { error: "That closing no longer exists." };
  const { closing, inquiry, buyerIds, deskParty } = loaded;
  const settings = await getSettings();
  const survivalDays = survivalDaysOf(settings.repSurvivalDays);
  const problem = filingProblem({ closing, userId: user.id, buyerIds, survivalDays, now, deskBook: user.role === "ADMIN" && deskCan(user, "deskBook") });
  if (problem) return { error: problem };
  if (!isRep(input.rep)) return { error: "Choose the representation that proved untrue." };
  const loans = closingLoans(closing, closing.listing.notes);
  const loan = loans.length === 1 && !input.noteId ? loans[0] : loans.find((note) => note.id === input.noteId);
  if (!loan) return { error: "Choose the loan the claim is about." };
  const description = clean(input.description, 4000);
  if (description.length < 20) return { error: "Say what is wrong, in a few sentences. The seller and the desk read it." };
  if (!isRemedy(input.remedy)) return { error: "Choose the remedy you are asking for." };
  const base = loanPriceCents({
    salePrice: Number(closing.salePrice),
    buyerPremiumCents: closing.buyerPremiumCents,
    loans: loans.map((note) => ({ id: note.id, upb: Number(note.upb) })),
    loanPrices: inquiry?.loanPrices,
    noteId: loan.id,
  });
  let amountCents: number | null = null;
  if (input.remedy === "REPURCHASE") amountCents = base.priceCents + base.premiumCents;
  if (input.remedy === "PRICE_ADJUSTMENT") {
    const cents = dollarsToCents(input.amount);
    if (cents == null || Number.isNaN(cents) || cents <= 0) return { error: "Enter the price adjustment you are asking for." };
    if (cents > base.priceCents) return { error: `A price adjustment can't be more than the ${money(base.priceCents / 100, 2)} paid for the loan. Ask for repurchase instead.` };
    amountCents = cents;
  }
  const uploads = input.files ?? [];
  const fileProblem = uploadsProblem(uploads);
  if (fileProblem) return { error: fileProblem };
  const open = await prisma.repurchaseClaim.findFirst({ where: { closingId: closing.id, noteId: loan.id, rep: input.rep, status: { in: [...OPEN_STATUSES] } }, select: { id: true } });
  if (open) return { error: "A claim on this loan and representation is already open. Add your files to it instead." };
  const respondBy = new Date(now.getTime() + responseDaysOf(settings.claimResponseDays) * DAY);
  const claim = await prisma.repurchaseClaim.create({
    data: {
      closingId: closing.id,
      noteId: loan.id,
      filedById: user.id,
      sellerId: closing.listing.sellerId,
      rep: input.rep,
      description,
      remedy: input.remedy,
      amountCents,
      respondBy,
      createdAt: now,
    },
  });
  await saveClaimFiles(claim.id, user.id, uploads, now);
  const sought = input.remedy === "CURE" ? "a cure" : `${REMEDY_LABELS[input.remedy].toLowerCase()} of ${money((amountCents ?? 0) / 100, 2)}`;
  await claimEvent(user.id, "CLAIM_FILED", claim.id, `The buyer filed on ${REP_TEXT[input.rep].label.toLowerCase()} for ${loanLabel(loan)}, asking for ${sought}.${uploads.length ? ` ${uploads.length} file${uploads.length === 1 ? "" : "s"} attached.` : ""}`, now);
  const title = closing.listing.title;
  await tellParties(
    claim,
    `Repurchase claim filed · ${title}`,
    `The buyer filed a claim that the seller's representation on ${REP_TEXT[input.rep].label.toLowerCase()} was untrue for ${loanLabel(loan)}, and asks for ${sought}. The seller answers by ${prettyDate(respondBy)}: accept it, dispute it with an explanation, or cure it. ${deskParty ? DESK_PARTY_TEXT : "If there is no answer by then, the desk reviews it."} Read the claim and its files here: ${claimLink(closing.id)}`,
  );
  await notifyDesk(`Repurchase claim filed · ${title}`, `A buyer filed a repurchase claim on ${REP_TEXT[input.rep].label.toLowerCase()} for ${loanLabel(loan)}. The seller answers by ${prettyDate(respondBy)}.${deskParty ? ` ${DESK_PARTY_REFUSAL}` : ""} ${appUrl()}/admin/claims`, { capability: "compliance" });
  return { error: null, claim };
}

async function loadClaim(claimId: string) {
  return prisma.repurchaseClaim.findUnique({ where: { id: claimId }, include: { closing: { select: { id: true, listing: { select: { title: true } } } } } });
}

export async function answerClaim(user: { id: string }, input: { claimId: string; kind: unknown; text: unknown; files?: ClaimUpload[] }, now = new Date()): Promise<Result> {
  const claim = await loadClaim(input.claimId);
  if (!claim) return { error: "That claim no longer exists." };
  const problem = answerProblem(claim, user.id);
  if (problem) return { error: problem };
  if (!isAnswerKind(input.kind)) return { error: "Choose your answer: accept, dispute or cure." };
  const text = clean(input.text, 4000);
  if (input.kind === "DISPUTE" && text.length < 20) return { error: "Say why the claim is wrong, in a few sentences. The buyer and the desk read it." };
  if (input.kind === "CURE" && text.length < 10) return { error: "Say how you cured it, in a sentence or two." };
  const uploads = input.files ?? [];
  const fileProblem = uploadsProblem(uploads);
  if (fileProblem) return { error: fileProblem };
  const next = input.kind === "DISPUTE" ? "UNDER_REVIEW" : "ANSWERED";
  const moved = await prisma.repurchaseClaim.updateMany({
    where: { id: claim.id, status: claim.status, ...unset("sellerRespondedAt") },
    data: { sellerResponse: answerText(input.kind, text), sellerRespondedAt: now, status: next },
  });
  if (moved.count !== 1) return { error: "This claim changed a moment ago. Reload the page." };
  await saveClaimFiles(claim.id, user.id, uploads, now);
  await claimEvent(user.id, "CLAIM_ANSWERED", claim.id, `The seller ${ANSWER_LABELS[input.kind].toLowerCase()}.${text ? ` ${text}` : ""}`, now);
  const title = claim.closing.listing.title;
  const deskParty = (await claimClosing(claim.closingId))?.deskParty ?? true;
  const after = {
    ACCEPT: "The seller accepted the claim, so it goes to the remedy the buyer asked for. The parties settle it between themselves, and each confirms on the closing page once it is settled.",
    DISPUTE: deskParty ? `The seller disputes the claim. ${DESK_PARTY_TEXT}` : "The seller disputes the claim, so the desk reviews it and decides.",
    CURE: `The seller says the breach is cured. The buyer confirms the cure on the closing page${deskParty ? "." : ", or asks the desk to review it."}`,
  }[input.kind];
  await tellParties(claim, `Claim answered · ${title}`, `${after}${text ? ` The seller wrote: ${text.slice(0, 600)}` : ""} ${claimLink(claim.closingId)}`);
  await notifyDesk(`Claim answered · ${title}`, `${after} ${appUrl()}/admin/claims`, { capability: "compliance" });
  return { error: null, claim: { ...claim, status: next, sellerResponse: answerText(input.kind, text), sellerRespondedAt: now } };
}

// A claimant or the seller adds evidence while the claim is still open.
export async function addClaimFiles(user: { id: string }, input: { claimId: string; files: ClaimUpload[] }, now = new Date()) {
  const claim = await loadClaim(input.claimId);
  if (!claim) return { error: "That claim no longer exists." } as const;
  if (user.id !== claim.filedById && user.id !== claim.sellerId) return { error: "Only the buyer who filed and the seller add files to a claim." } as const;
  if (!isOne(OPEN_STATUSES, claim.status)) return { error: "This claim is decided, so its file is closed." } as const;
  if (!input.files.length) return { error: "Choose a file." } as const;
  const problem = uploadsProblem(input.files);
  if (problem) return { error: problem } as const;
  await saveClaimFiles(claim.id, user.id, input.files, now);
  const who = user.id === claim.filedById ? "The buyer" : "The seller";
  await claimEvent(user.id, "CLAIM_FILES", claim.id, `${who} added ${input.files.length} file${input.files.length === 1 ? "" : "s"}.`, now);
  const other = user.id === claim.filedById ? claim.sellerId : claim.filedById;
  const email = (await emailsOf([other])).get(other);
  if (email) await notify(email, `New claim files · ${claim.closing.listing.title}`, `${who} added ${input.files.length === 1 ? "a file" : `${input.files.length} files`} to the repurchase claim. ${claimLink(claim.closingId)}`);
  return { error: null } as const;
}

export async function decideClaim(actor: Staff & { id: string }, input: { claimId: string; outcome: unknown; amount?: unknown; reason: unknown }, now = new Date()): Promise<Result> {
  const claim = await loadClaim(input.claimId);
  if (!claim) return { error: "That claim no longer exists." };
  const loaded = await claimClosing(claim.closingId);
  const partyIds = [...new Set([claim.filedById, claim.sellerId, ...(loaded?.partyIds ?? [])])];
  const owing = typeof input.outcome === "string" && OWING.includes(input.outcome);
  const amountCents = owing ? dollarsToCents(input.amount) : 0;
  const problem = decisionProblem({ actor, claim, partyIds, deskParty: loaded?.deskParty ?? true, outcome: input.outcome, amountCents, now });
  if (problem || !isDecision(input.outcome)) return { error: problem ?? "Choose the outcome." };
  const reason = clean(input.reason, 2000);
  if (reason.length < 10) return { error: "Give the reason for the decision. Both sides read it." };
  const outcome = input.outcome;
  const moved = await prisma.repurchaseClaim.updateMany({
    where: { id: claim.id, status: claim.status },
    data: { status: outcome, decidedById: actor.id, decidedAt: now, decision: reason, outcomeCents: amountCents, ...(FINAL.includes(outcome) ? { resolvedAt: now } : {}) },
  });
  if (moved.count !== 1) return { error: "This claim changed a moment ago. Reload the page." };
  const statement = decisionStatement(outcome, amountCents, claim.remedy);
  await claimEvent(actor.id, "CLAIM_DECIDED", claim.id, `${statement} Reason: ${reason}`, now);
  await tellParties(claim, `Claim decided · ${claim.closing.listing.title}`, `${statement} The desk's reason: ${reason.slice(0, 800)} ${claimLink(claim.closingId)}`);
  return { error: null, claim: { ...claim, status: outcome, decidedById: actor.id, decidedAt: now, decision: reason, outcomeCents: amountCents } };
}

// Settled means both sides say so. Each confirmation counts from the claim's last decision, so one given before the
// desk ruled doesn't settle what it ruled.
export async function confirmSettlement(user: { id: string }, input: { claimId: string }, now = new Date()) {
  const claim = await loadClaim(input.claimId);
  if (!claim) return { error: "That claim no longer exists." } as const;
  if (user.id !== claim.filedById && user.id !== claim.sellerId) return { error: "Only the buyer who filed and the seller confirm a settlement." } as const;
  if (!(["ANSWERED", "UNDER_REVIEW", ...SETTLING_STATUSES] as string[]).includes(claim.status)) return { error: claim.status === "FILED" ? "The seller answers the claim first." : "This claim is already closed." } as const;
  const since = claim.decidedAt ?? claim.createdAt;
  const confirmed = async () =>
    prisma.auditEvent.findMany({ where: { entityType: "claim", entityId: claim.id, action: "CLAIM_SETTLE_CONFIRMED", createdAt: { gte: since } }, select: { actorId: true } });
  if ((await confirmed()).some((row) => row.actorId === user.id)) return { error: "You already confirmed it is settled. The other side confirms next." } as const;
  const who = user.id === claim.filedById ? "The buyer" : "The seller";
  await claimEvent(user.id, "CLAIM_SETTLE_CONFIRMED", claim.id, `${who} confirmed the claim is settled between the parties.`, now);
  const both = new Set((await confirmed()).map((row) => row.actorId));
  const title = claim.closing.listing.title;
  if (!both.has(claim.filedById) || !both.has(claim.sellerId)) {
    const other = user.id === claim.filedById ? claim.sellerId : claim.filedById;
    const email = (await emailsOf([other])).get(other);
    if (email) await notify(email, `Confirm the settlement · ${title}`, `${who} confirmed the repurchase claim is settled between you. Confirm it on your side too, and the claim closes as settled. ${claimLink(claim.closingId)}`);
    return { error: null, settled: false } as const;
  }
  // An accepted claim settles at what the buyer asked for; a decided one at what the desk said was owed.
  const accepted = readAnswer(claim.sellerResponse)?.kind === "ACCEPT";
  const outcomeCents = claim.outcomeCents ?? (accepted ? claim.amountCents : null);
  const moved = await prisma.repurchaseClaim.updateMany({ where: { id: claim.id, status: claim.status }, data: { status: "SETTLED", resolvedAt: now, outcomeCents } });
  if (moved.count === 1) {
    await claimEvent(null, "CLAIM_SETTLED", claim.id, "Both sides confirmed the claim is settled.", now);
    await tellParties(claim, `Claim settled · ${title}`, `Both sides confirmed the repurchase claim is settled. It closes as settled. ${claimLink(claim.closingId)}`);
    await notifyDesk(`Claim settled · ${title}`, `Both sides confirmed the repurchase claim on ${title} is settled. ${appUrl()}/admin/claims`, { capability: "compliance" });
  }
  return { error: null, settled: true } as const;
}

// The buyer accepts the seller's cure, which closes the claim as cured.
export async function acceptCure(user: { id: string }, input: { claimId: string }, now = new Date()) {
  const claim = await loadClaim(input.claimId);
  if (!claim) return { error: "That claim no longer exists." } as const;
  if (user.id !== claim.filedById) return { error: "Only the buyer who filed accepts the cure." } as const;
  if (claim.status !== "ANSWERED" || readAnswer(claim.sellerResponse)?.kind !== "CURE") return { error: "The seller hasn't answered with a cure." } as const;
  const moved = await prisma.repurchaseClaim.updateMany({ where: { id: claim.id, status: "ANSWERED" }, data: { status: "CURED", resolvedAt: now, outcomeCents: 0 } });
  if (moved.count !== 1) return { error: "This claim changed a moment ago. Reload the page." } as const;
  await claimEvent(user.id, "CLAIM_CURED", claim.id, "The buyer accepted the seller's cure.", now);
  await tellParties(claim, `Claim cured · ${claim.closing.listing.title}`, `The buyer accepted the seller's cure, so the repurchase claim closes as cured. ${claimLink(claim.closingId)}`);
  return { error: null } as const;
}

// Either side sends an answered claim to the desk, when an accepted claim isn't being settled or a cure is in doubt.
export async function askDeskReview(user: { id: string }, input: { claimId: string; reason: unknown }, now = new Date()) {
  const claim = await loadClaim(input.claimId);
  if (!claim) return { error: "That claim no longer exists." } as const;
  if (user.id !== claim.filedById && user.id !== claim.sellerId) return { error: "Only the buyer who filed and the seller send a claim to the desk." } as const;
  if (claim.status !== "ANSWERED") return { error: claim.status === "UNDER_REVIEW" ? "The desk is already reviewing this claim." : "This claim isn't waiting on the parties." } as const;
  if ((await claimClosing(claim.closingId))?.deskParty ?? true) return { error: DESK_PARTY_TEXT } as const;
  const reason = clean(input.reason, 1000);
  if (reason.length < 10) return { error: "Say why the desk should review it, in a sentence." } as const;
  const moved = await prisma.repurchaseClaim.updateMany({ where: { id: claim.id, status: "ANSWERED" }, data: { status: "UNDER_REVIEW" } });
  if (moved.count !== 1) return { error: "This claim changed a moment ago. Reload the page." } as const;
  const who = user.id === claim.filedById ? "The buyer" : "The seller";
  await claimEvent(user.id, "CLAIM_REVIEW_ASKED", claim.id, `${who} asked the desk to review it. ${reason}`, now);
  const title = claim.closing.listing.title;
  await tellParties(claim, `Claim sent to the desk · ${title}`, `${who} asked the desk to review the repurchase claim: ${reason} ${claimLink(claim.closingId)}`);
  await notifyDesk(`Claim to review · ${title}`, `${who} asked the desk to review a repurchase claim on ${title}: ${reason} ${appUrl()}/admin/claims`, { capability: "compliance" });
  return { error: null } as const;
}

export async function withdrawClaim(user: { id: string }, input: { claimId: string }, now = new Date()) {
  const claim = await loadClaim(input.claimId);
  if (!claim) return { error: "That claim no longer exists." } as const;
  if (user.id !== claim.filedById) return { error: "Only the buyer who filed a claim withdraws it." } as const;
  if (!isOne(OPEN_STATUSES, claim.status)) return { error: "This claim is decided, so it can't be withdrawn." } as const;
  const moved = await prisma.repurchaseClaim.updateMany({ where: { id: claim.id, status: claim.status }, data: { status: "WITHDRAWN", resolvedAt: now } });
  if (moved.count !== 1) return { error: "This claim changed a moment ago. Reload the page." } as const;
  await claimEvent(user.id, "CLAIM_WITHDRAWN", claim.id, "The buyer withdrew the claim.", now);
  const title = claim.closing.listing.title;
  await tellParties(claim, `Claim withdrawn · ${title}`, `The buyer withdrew the repurchase claim. Nothing is owed under it. ${claimLink(claim.closingId)}`);
  await notifyDesk(`Claim withdrawn · ${title}`, `The buyer withdrew a repurchase claim on ${title}.`, { capability: "compliance" });
  return { error: null } as const;
}

// The job: the seller hears once, two days before their answer is due, and a claim with no answer by then goes to
// the desk. The reminder is an audit row on the claim, taken against the claim's last update so an overlapping run
// finds it gone. `claimIds` narrows a run, so a test touches only its own.
export async function claimClock(now = new Date(), options: { claimIds?: string[] } = {}): Promise<Tally> {
  const due = await prisma.repurchaseClaim.findMany({
    where: {
      status: "FILED",
      respondBy: { lte: new Date(now.getTime() + CLAIM_REMIND_DAYS * DAY) },
      ...unset("sellerRespondedAt"),
      ...(options.claimIds ? { id: { in: options.claimIds } } : {}),
    },
    include: { closing: { select: { listing: { select: { title: true } } } } },
  });
  return eachItem("repurchase claim", due, (claim) => `claim ${claim.id}`, async (claim) => {
    const stage = claimDue(claim, now);
    const title = claim.closing.listing.title;
    if (stage === "overdue") {
      const moved = await prisma.repurchaseClaim.updateMany({ where: { id: claim.id, status: "FILED", ...unset("sellerRespondedAt") }, data: { status: "UNDER_REVIEW" } });
      if (moved.count !== 1) return false;
      const due = prettyDate(claim.respondBy);
      if ((await claimClosing(claim.closingId))?.deskParty ?? true) {
        await claimEvent(null, "CLAIM_OVERDUE", claim.id, `The seller didn't answer by ${due}. UPB is a party, so the desk doesn't decide it.`, now);
        await tellParties(claim, `Claim not answered · ${title}`, `The seller didn't answer the repurchase claim by ${due}. ${DESK_PARTY_TEXT} ${claimLink(claim.closingId)}`);
        await notifyDesk(`Claim not answered · ${title}`, `The seller didn't answer a repurchase claim on ${title} by ${due}. ${DESK_PARTY_REFUSAL} ${appUrl()}/admin/claims`, { capability: "compliance" });
        return true;
      }
      await claimEvent(null, "CLAIM_OVERDUE", claim.id, `The seller didn't answer by ${due}, so the claim went to the desk.`, now);
      await tellParties(claim, `Claim with the desk · ${title}`, `The seller didn't answer the repurchase claim by ${due}, so the desk reviews it now and decides. ${claimLink(claim.closingId)}`);
      await notifyDesk(`Claim to review · ${title}`, `The seller didn't answer a repurchase claim on ${title} by ${due}. It is yours to review and decide. ${appUrl()}/admin/claims`, { capability: "compliance" });
      return true;
    }
    if (stage !== "remind") return false;
    if (await prisma.auditEvent.findFirst({ where: { entityType: "claim", entityId: claim.id, action: "CLAIM_REMINDED" }, select: { id: true } })) return false;
    const taken = await prisma.repurchaseClaim.updateMany({ where: { id: claim.id, status: "FILED", updatedAt: claim.updatedAt }, data: { respondBy: claim.respondBy } });
    if (taken.count !== 1) return false;
    await claimEvent(null, "CLAIM_REMINDED", claim.id, `UPB reminded the seller to answer by ${prettyDate(claim.respondBy)}.`, now);
    const email = (await emailsOf([claim.sellerId])).get(claim.sellerId);
    if (email) {
      await notify(email, `Claim answer due · ${title}`, `Your answer to the buyer's repurchase claim is due by ${prettyDate(claim.respondBy)}. Accept it, dispute it with an explanation, or cure it. With no answer by then, the desk reviews it. ${claimLink(claim.closingId)}`);
    }
    return true;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Reading claims.

// Each event's text names who acted, so the timeline reads without the actor's account.
export type ClaimEvent = { at: Date; text: string };

// The claims on one closing as this viewer may see them: the desk, the seller and the buyer side see the claims;
// only the claimant, the seller and the desk see their files. Nobody else sees that a claim exists.
export async function claimsOnClosing(closingId: string, viewer: { id: string; role: string }, sides: { sellerId: string; buyerIds: string[] }) {
  const desk = viewer.role === "ADMIN";
  if (!desk && viewer.id !== sides.sellerId && !sides.buyerIds.includes(viewer.id)) return [];
  const claims = await prisma.repurchaseClaim.findMany({ where: { closingId }, include: { files: { orderBy: { createdAt: "asc" } } }, orderBy: { createdAt: "desc" } });
  if (!claims.length) return [];
  const events = await prisma.auditEvent.findMany({
    where: { entityType: "claim", entityId: { in: claims.map((claim) => claim.id) }, action: { startsWith: "CLAIM_" } },
    orderBy: { createdAt: "asc" },
  });
  return claims.map((claim) => {
    const mine = events.filter((event) => event.entityId === claim.id);
    const since = (claim.decidedAt ?? claim.createdAt).getTime();
    const confirmedBy = new Set(mine.filter((event) => event.action === "CLAIM_SETTLE_CONFIRMED" && event.createdAt.getTime() >= since).map((event) => event.actorId));
    return {
      ...claim,
      files: canReadClaimFile({ role: viewer.role, userId: viewer.id, filedById: claim.filedById, sellerId: claim.sellerId }) ? claim.files : [],
      fileCount: claim.files.length,
      answer: readAnswer(claim.sellerResponse),
      timeline: mine.map((event): ClaimEvent => ({ at: event.createdAt, text: event.detail })),
      confirmedBy: { buyer: confirmedBy.has(claim.filedById), seller: confirmedBy.has(claim.sellerId) },
    };
  });
}

export type ClosingClaim = Awaited<ReturnType<typeof claimsOnClosing>>[number];

// Every claim for the desk's queue, with the closing and both names.
export async function deskClaimQueue() {
  const claims = await prisma.repurchaseClaim.findMany({
    include: {
      closing: { select: { id: true, deskBidId: true, inquiryId: true, listing: { select: { title: true, sellerId: true } }, funders: { select: { userId: true } } } },
      files: { select: { id: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  // Every party to each closing, so a claim where UPB is one stands apart from the claims the desk decides.
  const inquiryIds = [...new Set(claims.map((claim) => claim.closing.inquiryId).filter((id): id is string => Boolean(id)))];
  const leads = new Map((inquiryIds.length ? await prisma.inquiry.findMany({ where: { id: { in: inquiryIds } }, select: { id: true, buyerId: true } }) : []).map((row) => [row.id, row.buyerId]));
  const partiesOf = (closing: (typeof claims)[number]["closing"]) =>
    [closing.listing.sellerId, leads.get(closing.inquiryId ?? ""), ...closing.funders.map((funder) => funder.userId)].filter((id): id is string => Boolean(id));
  const ids = [...new Set(claims.flatMap((claim) => [claim.filedById, claim.sellerId, claim.decidedById, ...partiesOf(claim.closing)].filter((id): id is string => Boolean(id))))];
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, companyName: true, role: true } });
  const people = new Map(users.map((person) => [person.id, person.companyName || person.name]));
  const roleOf = new Map(users.map((person) => [person.id, person.role]));
  const rows = claims.map((claim) => ({
    deskParty: deskIsParty({ deskBidId: claim.closing.deskBidId, partyRoles: partiesOf(claim.closing).map((id) => roleOf.get(id) ?? "") }),
    id: claim.id,
    closingId: claim.closingId,
    title: claim.closing.listing.title,
    rep: isRep(claim.rep) ? REP_TEXT[claim.rep].label : claim.rep,
    remedy: isRemedy(claim.remedy) ? REMEDY_LABELS[claim.remedy] : claim.remedy,
    remedyKey: claim.remedy,
    amountCents: claim.amountCents,
    outcomeCents: claim.outcomeCents,
    status: claim.status,
    answer: readAnswer(claim.sellerResponse),
    buyer: people.get(claim.filedById) ?? "Buyer",
    seller: people.get(claim.sellerId) ?? "Seller",
    decidedBy: claim.decidedById ? people.get(claim.decidedById) ?? "A desk member" : null,
    createdAt: claim.createdAt,
    respondBy: claim.respondBy,
    decidedAt: claim.decidedAt,
    resolvedAt: claim.resolvedAt,
    files: claim.files.length,
  }));
  const open = (row: (typeof rows)[number]) => isOne(OPEN_STATUSES, row.status);
  return {
    review: rows.filter((row) => row.status === "UNDER_REVIEW" && !row.deskParty),
    waiting: rows.filter((row) => row.status === "FILED" && !row.deskParty),
    answered: rows.filter((row) => row.status === "ANSWERED" && !row.deskParty),
    deskParty: rows.filter((row) => open(row) && row.deskParty),
    settling: rows.filter((row) => isOne(SETTLING_STATUSES, row.status)),
    closed: rows.filter((row) => FINAL.includes(row.status)),
  };
}
