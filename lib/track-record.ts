import { audit } from "@/lib/audit";
import { notify } from "@/lib/email";
import { prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";

// Each account's record on UPB, built only from what happened: closes, days from award to close, deposits, failed
// closings and whose fault, kick-outs, how fast the collateral arrived, repurchase claims and how they ended,
// and the short yes-or-no answers each side gives after a confirmed close. Never stars, never a grade. Under
// RECORD_MIN_CLOSES closes a share is shown as its counts, since a percentage of two deals says nothing.

const DAY = 24 * 60 * 60 * 1000;

export const RECORD_MIN_CLOSES = 5;
export const ATTESTATION_EDIT_DAYS = 30;

export type Faults = { buyer: number; seller: number; neither: number; unrecorded: number };
export type ClaimTally = { filed: number; open: number; upheld: number; partlyUpheld: number; denied: number; cured: number; settled: number; withdrawn: number };
export type YesCount = { yes: number; of: number };

export type RecordClosing = {
  id: string;
  status: string;
  openedAt: Date;
  closedAt: Date | null;
  canceledAt?: Date | null;
  cancelFault?: string | null;
  depositCents?: number | null;
  depositDueAt?: Date | null;
  depositReceivedCents?: number | null;
  depositReceivedAt?: Date | null;
};

export type BuyerRecord = {
  closes: number;
  failed: Faults;
  medianDaysToClose: number | null;
  deposits: { due: number; onTime: number };
  claimsFiled: ClaimTally;
  fundedOnTime: YesCount;
};

export type SellerRecord = {
  closes: number;
  failed: Faults;
  medianDaysToClose: number | null;
  kickouts: number;
  // Days from close to each loan's collateral receipt: the original note, or the eRegistry transfer of control for an
  // eNote. Null when none is on record.
  collateral: { medianDays: number | null; count: number };
  claimsAgainst: ClaimTally;
  fileAsDescribed: YesCount;
  collateralComplete: YesCount;
};

export function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const days = (from: Date, to: Date) => (to.getTime() - from.getTime()) / DAY;
const wholeDays = (value: number | null) => (value == null ? null : Math.max(0, Math.round(value)));

function faultsOf(closings: RecordClosing[]): Faults {
  const faults: Faults = { buyer: 0, seller: 0, neither: 0, unrecorded: 0 };
  for (const closing of closings) {
    if (closing.status !== "CANCELED") continue;
    if (closing.cancelFault === "BUYER") faults.buyer += 1;
    else if (closing.cancelFault === "SELLER") faults.seller += 1;
    else if (closing.cancelFault === "NEITHER") faults.neither += 1;
    else faults.unrecorded += 1;
  }
  return faults;
}

export function tallyClaims(claims: { status: string }[]): ClaimTally {
  const tally: ClaimTally = { filed: claims.length, open: 0, upheld: 0, partlyUpheld: 0, denied: 0, cured: 0, settled: 0, withdrawn: 0 };
  for (const claim of claims) {
    if (claim.status === "UPHELD") tally.upheld += 1;
    else if (claim.status === "PARTLY_UPHELD") tally.partlyUpheld += 1;
    else if (claim.status === "DENIED") tally.denied += 1;
    else if (claim.status === "CURED") tally.cured += 1;
    else if (claim.status === "SETTLED") tally.settled += 1;
    else if (claim.status === "WITHDRAWN") tally.withdrawn += 1;
    else tally.open += 1;
  }
  return tally;
}

function yesCount(answers: (boolean | null | undefined)[]): YesCount {
  const given = answers.filter((answer): answer is boolean => answer === true || answer === false);
  return { yes: given.filter(Boolean).length, of: given.length };
}

function closeDays(closings: RecordClosing[]) {
  const closed = closings.filter((closing) => closing.status === "COMPLETE" && closing.closedAt);
  return { closes: closed.length, medianDaysToClose: wholeDays(median(closed.map((closing) => days(closing.openedAt, closing.closedAt!)))) };
}

// A deposit counts once it was received, or once its due date passed while the deal was still open. On time means
// the full amount arrived by the due date.
function depositsOf(closings: RecordClosing[], now: Date) {
  let due = 0;
  let onTime = 0;
  for (const closing of closings) {
    if (!closing.depositDueAt || !closing.depositCents || closing.depositCents <= 0) continue;
    const ended = closing.canceledAt ?? closing.closedAt ?? now;
    const received = closing.depositReceivedAt && closing.depositReceivedCents != null;
    if (!received && closing.depositDueAt.getTime() >= ended.getTime()) continue;
    due += 1;
    if (received && closing.depositReceivedCents! >= closing.depositCents && closing.depositReceivedAt!.getTime() <= closing.depositDueAt.getTime()) onTime += 1;
  }
  return { due, onTime };
}

export function buildBuyerRecord(input: { closings: RecordClosing[]; claims: { status: string }[]; attestations: { fundedOnTime: boolean | null }[]; now?: Date }): BuyerRecord {
  return {
    ...closeDays(input.closings),
    failed: faultsOf(input.closings),
    deposits: depositsOf(input.closings, input.now ?? new Date()),
    claimsFiled: tallyClaims(input.claims),
    fundedOnTime: yesCount(input.attestations.map((row) => row.fundedOnTime)),
  };
}

// The trailing documents that deliver a loan's note, received: the original note by courier, or control of an eNote.
export const COLLATERAL_KINDS = ["ORIGINAL_NOTE", "ENOTE_CONTROL"] as const;

// One receipt per loan, the earliest, from closed deals only. A row with no loan stands for its closing's one loan.
export function collateralReceipts(docs: { closingId: string; noteId: string | null; kind: string; status: string; receivedAt: Date | null }[], closedAt: Map<string, Date>) {
  const first = new Map<string, { closedAt: Date; receivedAt: Date }>();
  for (const doc of docs) {
    const closed = closedAt.get(doc.closingId);
    if (!closed || !doc.receivedAt || doc.status !== "RECEIVED" || !(COLLATERAL_KINDS as readonly string[]).includes(doc.kind)) continue;
    const key = `${doc.closingId}:${doc.noteId ?? ""}`;
    const seen = first.get(key);
    if (!seen || doc.receivedAt.getTime() < seen.receivedAt.getTime()) first.set(key, { closedAt: closed, receivedAt: doc.receivedAt });
  }
  return [...first.values()];
}

export function buildSellerRecord(input: {
  closings: RecordClosing[];
  kickouts: number;
  noteReceipts: { closedAt: Date; receivedAt: Date }[];
  claims: { status: string }[];
  attestations: { fileAsDescribed: boolean | null; collateralComplete: boolean | null }[];
}): SellerRecord {
  return {
    ...closeDays(input.closings),
    failed: faultsOf(input.closings),
    kickouts: input.kickouts,
    collateral: { medianDays: wholeDays(median(input.noteReceipts.map((row) => days(row.closedAt, row.receivedAt)))), count: input.noteReceipts.length },
    claimsAgainst: tallyClaims(input.claims),
    fileAsDescribed: yesCount(input.attestations.map((row) => row.fileAsDescribed)),
    collateralComplete: yesCount(input.attestations.map((row) => row.collateralComplete)),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The record in words.

// Who reads it. "public" is the other side of a deal: a seller weighing bids, a buyer on a listing. They see what was
// decided, never an open or withdrawn claim, and never the claims a buyer filed.
export type RecordAudience = "public" | "self" | "desk";

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// "3 of 4" under the threshold, and "75% (3 of 4)" from it.
export function shareText(count: YesCount, closes: number) {
  if (!count.of) return null;
  return closes >= RECORD_MIN_CLOSES ? `${Math.round((count.yes * 100) / count.of)}% (${count.yes} of ${count.of})` : `${count.yes} of ${count.of}`;
}

function saidLine(count: YesCount, closes: number, who: string, said: string) {
  if (!count.of) return null;
  if (closes >= RECORD_MIN_CLOSES) return `${Math.round((count.yes * 100) / count.of)}% of ${who}s ${said} (${count.yes} of ${count.of})`;
  return `${count.yes} of ${plural(count.of, who)} ${said}`;
}

function daysLine(closes: number, value: number | null) {
  if (!closes || value == null) return null;
  return `${closes === 1 ? "" : "Median "}${plural(value, "day")} from award to close`.replace(/^./, (first) => first.toUpperCase());
}

function failedLine(failed: Faults) {
  const total = failed.buyer + failed.seller + failed.neither + failed.unrecorded;
  if (!total) return "No failed closings";
  const parts = [
    failed.seller ? `${failed.seller} on the seller` : "",
    failed.buyer ? `${failed.buyer} on the buyer` : "",
    failed.neither ? `${failed.neither} on neither side` : "",
    failed.unrecorded ? `${failed.unrecorded} not recorded` : "",
  ].filter(Boolean);
  return `${plural(total, "failed closing")}: ${parts.join(", ")}`;
}

function claimParts(tally: ClaimTally, withOpen: boolean) {
  return [
    withOpen && tally.open ? `${tally.open} open` : "",
    tally.upheld ? `${tally.upheld} upheld` : "",
    tally.partlyUpheld ? `${tally.partlyUpheld} partly upheld` : "",
    tally.settled ? `${tally.settled} settled` : "",
    tally.cured ? `${tally.cured} cured` : "",
    tally.denied ? `${tally.denied} denied` : "",
    withOpen && tally.withdrawn ? `${tally.withdrawn} withdrawn` : "",
  ].filter(Boolean);
}

function decided(tally: ClaimTally) {
  return tally.upheld + tally.partlyUpheld + tally.denied + tally.cured + tally.settled;
}

export function sellerRecordLines(record: SellerRecord, audience: RecordAudience) {
  const failedTotal = record.failed.buyer + record.failed.seller + record.failed.neither + record.failed.unrecorded;
  if (!record.closes && !failedTotal && !record.claimsAgainst.filed) return ["No closings on UPB yet"];
  const lines: (string | null)[] = [
    `${plural(record.closes, "closing")} on UPB`,
    daysLine(record.closes, record.medianDaysToClose),
    failedLine(record.failed),
    record.kickouts ? `${plural(record.kickouts, "loan")} kicked out before close` : "No kick-outs",
    record.collateral.medianDays != null
      ? record.collateral.count === 1
        ? `Collateral delivered ${plural(record.collateral.medianDays, "day")} after close`
        : `Collateral delivered a median ${plural(record.collateral.medianDays, "day")} after close (${record.collateral.count} loans)`
      : audience !== "public" && record.closes ? "No collateral delivery recorded yet" : null,
  ];
  if (audience === "public") {
    const parts = claimParts(record.claimsAgainst, false);
    lines.push(decided(record.claimsAgainst) ? `Repurchase claims decided: ${parts.join(", ")}` : "No repurchase claims decided");
  } else {
    const parts = claimParts(record.claimsAgainst, true);
    lines.push(record.claimsAgainst.filed ? `${plural(record.claimsAgainst.filed, "repurchase claim")} filed against the seller: ${parts.join(", ")}` : "No repurchase claims filed");
  }
  lines.push(saidLine(record.fileAsDescribed, record.closes, "buyer", "said the file matched what was described"));
  lines.push(saidLine(record.collateralComplete, record.closes, "buyer", "said the collateral arrived complete"));
  return lines.filter((line): line is string => Boolean(line));
}

// skipCloses leaves out the count, for the seller's award decision, whose line already gives it.
export function buyerRecordLines(record: BuyerRecord, audience: RecordAudience, options: { skipCloses?: boolean } = {}) {
  const failedTotal = record.failed.buyer + record.failed.seller + record.failed.neither + record.failed.unrecorded;
  if (!record.closes && !failedTotal && !record.deposits.due) return options.skipCloses ? [] : ["No closings on UPB yet"];
  const deposits = shareText({ yes: record.deposits.onTime, of: record.deposits.due }, record.closes);
  const lines: (string | null)[] = [
    options.skipCloses ? null : `${plural(record.closes, "closing")} on UPB`,
    daysLine(record.closes, record.medianDaysToClose),
    deposits ? `Deposits on time: ${deposits}` : null,
    failedLine(record.failed),
    saidLine(record.fundedOnTime, record.closes, "seller", "said the buyer funded on time"),
  ];
  if (audience !== "public") {
    const parts = claimParts(record.claimsFiled, true);
    lines.push(record.claimsFiled.filed ? `${plural(record.claimsFiled.filed, "repurchase claim")} filed: ${parts.join(", ")}` : "No repurchase claims filed");
  }
  return lines.filter((line): line is string => Boolean(line));
}

// ---------------------------------------------------------------------------------------------------------------
// Loading it.

const CLOSING_FIELDS = {
  id: true,
  status: true,
  openedAt: true,
  closedAt: true,
  canceledAt: true,
  cancelFault: true,
  depositCents: true,
  depositDueAt: true,
  depositReceivedCents: true,
  depositReceivedAt: true,
} as const;

// The closings each account bought on: as the bidder, or as a seat on a group.
async function buyerClosings(userIds: string[]) {
  const owned = new Map<string, Set<string>>(userIds.map((id) => [id, new Set<string>()]));
  if (!userIds.length) return { owned, closings: [] };
  const [bids, seats] = await Promise.all([
    prisma.inquiry.findMany({ where: { buyerId: { in: userIds } }, select: { id: true, buyerId: true } }),
    prisma.closingFunder.findMany({ where: { userId: { in: userIds } }, select: { userId: true, closingId: true } }),
  ]);
  const bidder = new Map(bids.map((bid) => [bid.id, bid.buyerId]));
  const led = bids.length ? await prisma.closing.findMany({ where: { inquiryId: { in: [...bidder.keys()] } }, select: { id: true, inquiryId: true } }) : [];
  for (const closing of led) owned.get(bidder.get(closing.inquiryId ?? "") ?? "")?.add(closing.id);
  for (const seat of seats) owned.get(seat.userId)?.add(seat.closingId);
  const ids = [...new Set([...owned.values()].flatMap((set) => [...set]))];
  const closings = ids.length ? await prisma.closing.findMany({ where: { id: { in: ids } }, select: CLOSING_FIELDS }) : [];
  return { owned, closings };
}

export async function buyerTrackRecords(userIds: string[], now = new Date()) {
  const ids = [...new Set(userIds)];
  const { owned, closings } = await buyerClosings(ids);
  const [claims, attestations] = await Promise.all([
    ids.length ? prisma.repurchaseClaim.findMany({ where: { filedById: { in: ids } }, select: { filedById: true, status: true } }) : Promise.resolve([]),
    closings.length ? prisma.closeAttestation.findMany({ where: { closingId: { in: closings.map((closing) => closing.id) }, side: "SELLER" }, select: { closingId: true, fundedOnTime: true } }) : Promise.resolve([]),
  ]);
  const out = new Map<string, BuyerRecord>();
  for (const id of ids) {
    const mine = owned.get(id) ?? new Set<string>();
    out.set(
      id,
      buildBuyerRecord({
        closings: closings.filter((closing) => mine.has(closing.id)),
        claims: claims.filter((claim) => claim.filedById === id),
        attestations: attestations.filter((row) => mine.has(row.closingId)),
        now,
      }),
    );
  }
  return out;
}

export async function sellerTrackRecord(sellerId: string) {
  const listings = await prisma.listing.findMany({ where: { sellerId }, select: { id: true } });
  const closings = listings.length ? await prisma.closing.findMany({ where: { listingId: { in: listings.map((listing) => listing.id) } }, select: CLOSING_FIELDS }) : [];
  const ids = closings.map((closing) => closing.id);
  const closedAt = new Map(closings.filter((closing) => closing.status === "COMPLETE" && closing.closedAt).map((closing) => [closing.id, closing.closedAt!]));
  const [kickouts, notes, claims, attestations] = await Promise.all([
    ids.length ? prisma.closingKickout.count({ where: { closingId: { in: ids } } }) : Promise.resolve(0),
    // Each loan's note, by courier or by eRegistry, from the trailing documents on each closed deal.
    closedAt.size
      ? prisma.trailingDoc.findMany({
          where: { closingId: { in: [...closedAt.keys()] }, kind: { in: [...COLLATERAL_KINDS] }, status: "RECEIVED" },
          select: { closingId: true, noteId: true, kind: true, status: true, receivedAt: true },
        })
      : Promise.resolve([]),
    prisma.repurchaseClaim.findMany({ where: { sellerId }, select: { status: true } }),
    ids.length ? prisma.closeAttestation.findMany({ where: { closingId: { in: ids }, side: "BUYER" }, select: { fileAsDescribed: true, collateralComplete: true } }) : Promise.resolve([]),
  ]);
  return buildSellerRecord({ closings, kickouts, noteReceipts: collateralReceipts(notes, closedAt), claims, attestations });
}

// Both sides of one account, for its own page and the desk's. A side shows when the account has done anything on it.
export async function accountRecord(userId: string, now = new Date()) {
  const [buyer, seller, lists] = await Promise.all([
    buyerTrackRecords([userId], now).then((records) => records.get(userId)!),
    sellerTrackRecord(userId),
    prisma.listing.count({ where: { sellerId: userId } }),
  ]);
  return { buyer, seller, sells: lists > 0 };
}

// What a seller reads beside each bidder, past the close count and strikes lib/seller-decisions.ts already shows.
export async function bidderFacts(buyerIds: string[], now = new Date()) {
  const records = await buyerTrackRecords(buyerIds, now);
  return new Map([...records].map(([id, record]) => [id, buyerRecordLines(record, "public", { skipCloses: true })]));
}

// ---------------------------------------------------------------------------------------------------------------
// The answers each side gives after a confirmed close.

export const ATTESTATION_QUESTIONS = {
  BUYER: [
    { field: "fileAsDescribed", text: "The file matched what was described" },
    { field: "collateralComplete", text: "The collateral arrived complete" },
  ],
  SELLER: [{ field: "fundedOnTime", text: "The buyer funded on time" }],
} as const;

export type AttestationSide = keyof typeof ATTESTATION_QUESTIONS;
export type AttestationField = (typeof ATTESTATION_QUESTIONS)[AttestationSide][number]["field"];

// The seller answers for the seller side and the winning bidder for the buyer side; a group's lead answers for the
// group. The desk buying for its own book answers nothing, and the seller isn't asked about UPB.
export function attestationSide(closing: { deskBidId: string | null; sellerId: string; leadBuyerId: string | null }, userId: string): AttestationSide | null {
  if (closing.deskBidId) return null;
  if (userId === closing.sellerId) return "SELLER";
  if (closing.leadBuyerId && userId === closing.leadBuyerId) return "BUYER";
  return null;
}

export function attestationEditableUntil(createdAt: Date) {
  return new Date(createdAt.getTime() + ATTESTATION_EDIT_DAYS * DAY);
}

export function attestationProblem(input: { status: string; side: AttestationSide | null; existing: { byId: string; createdAt: Date } | null; userId: string; now: Date }) {
  if (!input.side) return "Only the buyer and the seller on this closing answer these.";
  if (input.status !== "COMPLETE") return "These questions open once the closing has closed.";
  if (input.existing && input.existing.byId !== input.userId) return "Someone else answered for your side.";
  if (input.existing && input.now.getTime() > attestationEditableUntil(input.existing.createdAt).getTime()) {
    return `Answers can be changed for ${ATTESTATION_EDIT_DAYS} days. These were given on ${prettyDate(input.existing.createdAt)}.`;
  }
  return null;
}

// Each of the side's questions, answered yes or no. Nothing is left blank, and nothing else is read.
export function readAttestationAnswers(side: AttestationSide, raw: Record<string, unknown>) {
  const values: Partial<Record<AttestationField, boolean>> = {};
  for (const question of ATTESTATION_QUESTIONS[side]) {
    const answer = raw[question.field];
    if (answer !== "yes" && answer !== "no") return { error: `Answer yes or no to "${question.text}".` } as const;
    values[question.field] = answer === "yes";
  }
  return { error: null, values } as const;
}

async function closingSides(closingId: string) {
  const closing = await prisma.closing.findUnique({
    where: { id: closingId },
    select: { id: true, status: true, deskBidId: true, inquiryId: true, listing: { select: { title: true, sellerId: true, seller: { select: { email: true } } } } },
  });
  if (!closing) return null;
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, select: { buyerId: true, buyer: { select: { email: true } } } }) : null;
  return { closing, leadBuyerId: inquiry?.buyerId ?? null, buyerEmail: inquiry?.buyer.email ?? null };
}

export async function saveAttestation(user: { id: string }, input: { closingId: string; answers: Record<string, unknown>; note?: unknown }, now = new Date()) {
  const sides = await closingSides(input.closingId);
  if (!sides) return { error: "That closing no longer exists." } as const;
  const { closing, leadBuyerId } = sides;
  const side = attestationSide({ deskBidId: closing.deskBidId, sellerId: closing.listing.sellerId, leadBuyerId }, user.id);
  const existing = side ? await prisma.closeAttestation.findUnique({ where: { closingId_side: { closingId: closing.id, side } } }) : null;
  const problem = attestationProblem({ status: closing.status, side, existing, userId: user.id, now });
  if (problem || !side) return { error: problem ?? "Only the buyer and the seller on this closing answer these." } as const;
  const read = readAttestationAnswers(side, input.answers);
  if (read.error !== null) return { error: read.error } as const;
  const note = typeof input.note === "string" ? input.note.replace(/\s+/g, " ").trim().slice(0, 500) : "";
  let saved;
  if (existing) {
    saved = await prisma.closeAttestation.update({ where: { id: existing.id }, data: { ...read.values, note } });
  } else {
    try {
      saved = await prisma.closeAttestation.create({ data: { closingId: closing.id, byId: user.id, side, ...read.values, note, createdAt: now } });
    } catch {
      // Two submits at once: the unique (closing, side) keeps the first.
      return { error: "Your side's answers were just saved. Reload the page to change them." } as const;
    }
  }
  const summary = ATTESTATION_QUESTIONS[side].map((question) => `${question.text}: ${read.values[question.field] ? "yes" : "no"}`).join("; ");
  await audit(user.id, existing ? "ATTESTATION_CHANGED" : "ATTESTATION", "closing", closing.id, `${side === "BUYER" ? "Buyer" : "Seller"} side. ${summary}.${note ? ` ${note}` : ""}`);
  return { error: null, attestation: saved, created: !existing } as const;
}

// One notice to each side at close. finalizeClosing calls this only from the write that closes the deal, so it goes once.
export async function promptAttestations(closingId: string) {
  const sides = await closingSides(closingId);
  if (!sides || sides.closing.deskBidId) return;
  const title = sides.closing.listing.title;
  const link = `${process.env.NEXT_PUBLIC_APP_URL || ""}/closings/${closingId}#after-closing`;
  const kept = `Your answers go into the factual record on UPB, which counts what happened and never rates anyone. You can change them for ${ATTESTATION_EDIT_DAYS} days after you answer.`;
  await notify(sides.closing.listing.seller.email, `One question on ${title}`, `The deal closed. Did the buyer fund on time? Answer yes or no, with a note if you like. ${kept} ${link}`);
  if (sides.buyerEmail) {
    await notify(sides.buyerEmail, `Two questions on ${title}`, `The deal closed. Did the file match what was described, and did the collateral arrive complete? Answer each yes or no, with a note if you like. Answer the collateral question once it has arrived. ${kept} ${link}`);
  }
}

// The close stands whatever happens to the notices.
export async function promptAttestationsSafely(closingId: string) {
  try {
    await promptAttestations(closingId);
  } catch (error) {
    console.error(`[upb-record] attestation notices for closing ${closingId} failed:`, error instanceof Error ? error.message : "unknown error");
  }
}
