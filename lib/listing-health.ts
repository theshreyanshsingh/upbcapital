import type { LienPosition, ListingKind, PaymentStatus, Prisma } from "@prisma/client";
import { deadlinePassed } from "@/lib/auction";
import { bidderCountLock } from "@/lib/bidder-count";
import { compsFor, loadClosedTrades, MIN_TRADES, type CompCell } from "@/lib/comps";
import { loadDiligence } from "@/lib/diligence-checklist";
import { prettyDate } from "@/lib/format";
import { compSubjectOf, loadIndicatives, type LoaderNote } from "@/lib/indicative";
import { regulatedOnly } from "@/lib/institutions";
import { labelOf } from "@/lib/labels";
import { loansForSale } from "@/lib/metrics";
import { ofacBlocks } from "@/lib/ofac";
import { prisma } from "@/lib/prisma";
import { isPrivateListing, publicListing } from "@/lib/private-listings";
import { PAUSE_AFTER_DAYS, REMIND_AFTER_DAYS } from "@/lib/provenance";
import { availableSince, remindedSince, stalePaused } from "@/lib/provenance-rules";

// Listing health: for one of a seller's live listings, what buyers did with it (opened it, signed the NDA, took a file
// from the room, asked, saved it, bid), against the median of similar listings, and up to MAX_STEPS next steps from
// fixed rules. Each step is a fact UPB already holds and a suggestion, never a grade or a forecast, and never a price
// to set: a price comparison shows the figures and leaves the ask to the seller. A similar listing is never named,
// and its counts show only as a median of at least MIN_SIMILAR other sellers' listings.
//
// The counts read the same logs as the seller page's buyer interest (lib/activity.ts): the seller's own opens and
// the desk's are left out.

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

// ---------------------------------------------------------------------------------------------------------------
// The funnel

export const FUNNEL_STAGES = ["views", "ndas", "room", "questions", "watchers", "bids"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export const STAGE_LABELS: Record<FunnelStage, string> = {
  views: "Buyers who opened it",
  ndas: "Signed the NDA",
  room: "Took a file from the room",
  questions: "Questions asked",
  watchers: "Watching",
  bids: "Bidders",
};

export type FunnelEvent = { userId: string; at: Date };
export type FunnelEvents = Record<FunnelStage, FunnelEvent[]>;
export type StageCount = { total: number; week: number };
export type Funnel = Record<FunnelStage, StageCount>;

export const emptyEvents = (): FunnelEvents => ({ views: [], ndas: [], room: [], questions: [], watchers: [], bids: [] });

// Questions count each question. Every other stage counts each buyer once, however often they came back.
function tally(stage: FunnelStage, events: FunnelEvent[]) {
  return stage === "questions" ? events.length : new Set(events.map((event) => event.userId)).size;
}

// Each stage over the listing's life and in the 7 days to now.
export function funnelOf(events: FunnelEvents, now = new Date()): Funnel {
  const at = now.getTime();
  const funnel = {} as Funnel;
  for (const stage of FUNNEL_STAGES) {
    const seen = events[stage].filter((event) => event.at.getTime() <= at);
    funnel[stage] = { total: tally(stage, seen), week: tally(stage, seen.filter((event) => at - event.at.getTime() < WEEK)) };
  }
  return funnel;
}

// Each stage up to a day, for a similar listing measured over as many days as the subject has been live.
export function countsUntil(events: FunnelEvents, until: Date): Record<FunnelStage, number> {
  const counts = {} as Record<FunnelStage, number>;
  for (const stage of FUNNEL_STAGES) counts[stage] = tally(stage, events[stage].filter((event) => event.at.getTime() <= until.getTime()));
  return counts;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// The one-line summary on the seller desk: "Seen by 12 · 3 NDAs · no bids yet".
export function funnelLine(funnel: Funnel) {
  const seen = funnel.views.total ? `Seen by ${funnel.views.total}` : "Not opened yet";
  const ndas = plural(funnel.ndas.total, "NDA");
  const bids = funnel.bids.total ? plural(funnel.bids.total, "bidder") : "no bids yet";
  return `${seen} · ${ndas} · ${bids}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Similar listings

// Fewer than this and a median could stand for one listing, so nothing is compared.
export const MIN_SIMILAR = 5;
// A similar listing was live at some point in this many days to now.
export const SIMILAR_DAYS = 180;
// The most recent similar listings the medians read, so a deep book doesn't slow the page.
export const SIMILAR_LIMIT = 60;
// Listings read to find them, newest approval first.
const SIMILAR_SCAN = 300;

export type Profile = { kind: string; lienPosition: string; paymentStatus: string };

// A pool takes the lien and performance that hold most of its UPB, as the comps do.
export function profileOf(listing: { kind: string; notes: { upb: number; lienPosition?: string | null; paymentStatus?: string | null }[] }): Profile {
  const { lienPosition, paymentStatus } = compSubjectOf(listing.notes);
  return { kind: listing.kind, lienPosition, paymentStatus };
}

export function profileLabel(profile: Profile) {
  const kind = profile.kind === "POOL" ? "Pools" : "Single notes";
  return `${kind}, ${labelOf("lien", profile.lienPosition).toLowerCase()} lien, ${labelOf("payment", profile.paymentStatus).toLowerCase()}`;
}

const sameProfile = (a: Profile, b: Profile) => a.kind === b.kind && a.lienPosition === b.lienPosition && a.paymentStatus === b.paymentStatus;

// When buyers could first act on it: the approval, or the launch for a listing that came soon first.
export function liveSince(listing: { approvedAt: Date | null; launchAt?: Date | null }) {
  const approved = listing.approvedAt;
  if (!approved) return null;
  return listing.launchAt && listing.launchAt.getTime() > approved.getTime() ? listing.launchAt : approved;
}

// Whole days live, at least one, so a listing approved this morning compares with other listings' first day.
export function daysLive(listing: { approvedAt: Date | null; launchAt?: Date | null }, now = new Date()) {
  const since = liveSince(listing);
  if (!since || since.getTime() > now.getTime()) return 0;
  return Math.max(1, Math.ceil((now.getTime() - since.getTime()) / DAY));
}

export type PeerListing = { status: string; approvedAt: Date | null; launchAt?: Date | null; soldAt?: Date | null; withdrawnAt?: Date | null; updatedAt: Date };

// The day up to which a similar listing is counted, so it is read over as many days as the subject has been live, or
// null when it can't be compared: it wasn't live in the SIMILAR_DAYS to now, or it is still live and younger than the
// subject, so its counts would read short. One that sold or was withdrawn sooner is read over its whole run.
export function peerWindow(peer: PeerListing, days: number, now = new Date()) {
  const since = liveSince(peer);
  if (!since || since.getTime() > now.getTime() || days < 1) return null;
  const onBook = peer.status === "APPROVED" || peer.status === "PENDING";
  const ended = peer.soldAt ?? peer.withdrawnAt ?? peer.updatedAt;
  if (!onBook && ended.getTime() < now.getTime() - SIMILAR_DAYS * DAY) return null;
  if (peer.status === "APPROVED" && now.getTime() - since.getTime() < days * DAY) return null;
  return new Date(Math.min(since.getTime() + days * DAY, now.getTime()));
}

export type Similar = { count: number; days: number; median: Record<FunnelStage, number> };

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value * 10) / 10;
}

// The median of each stage across the similar listings, or null with fewer than MIN_SIMILAR. Only the medians and the
// count leave here.
export function similarMedians(samples: Record<FunnelStage, number>[], days: number): Similar | null {
  if (samples.length < MIN_SIMILAR) return null;
  const medians = {} as Record<FunnelStage, number>;
  for (const stage of FUNNEL_STAGES) medians[stage] = median(samples.map((sample) => sample[stage]));
  return { count: samples.length, days, median: medians };
}

// ---------------------------------------------------------------------------------------------------------------
// What buyers ask about. A question names a file by its words; each topic is the file that would answer it.

export type QuestionTopic = {
  key: string;
  // "the pay history", for "3 buyer questions ask about the pay history".
  about: string;
  // "the pay history", for "Add the pay history to the data room".
  add: string;
  // Document types that count as on file. The diligence line of the same key counts too.
  docTypes: string[];
  words: RegExp;
};

export const QUESTION_TOPICS: QuestionTopic[] = [
  { key: "PAY_HISTORY", about: "the pay history", add: "the pay history", docTypes: ["PAY_HISTORY"], words: /\bpay(ment)?[\s-]*(history|histories|records?|string|ledger)\b|\bpaystring\b|\bledger\b/i },
  { key: "TITLE", about: "title", add: "a title report or O&E", docTypes: ["TITLE", "OE_REPORT"], words: /\btitle\b|\bo\s?&\s?e\b|\bencumbrances?\b/i },
  { key: "VALUE", about: "the property's value", add: "a BPO or appraisal", docTypes: ["BPO"], words: /\bbpo\b|\bappraisal\b|\bbroker price opinion\b|\bvaluation\b|\bavm\b|\b(property|current|market) value\b/i },
  { key: "NOTE", about: "the note itself", add: "a copy of the note", docTypes: ["NOTE"], words: /\b(copy of|original|signed|lost)\s+(the\s+)?note\b|\bnote\s+(copy|image|scan)\b|\bpromissory\b|\blost[\s-]note\b/i },
  { key: "MORTGAGE", about: "the mortgage", add: "the recorded mortgage or deed of trust", docTypes: ["MORTGAGE"], words: /\bdeed of trust\b|\bsecurity instrument\b|\brecorded mortgage\b|\b(copy of|signed)\s+(the\s+)?mortgage\b/i },
  { key: "ENDORSEMENTS", about: "endorsements", add: "the allonge or endorsements", docTypes: ["ALLONGE"], words: /\bendorse(d|ment|ments)?\b|\ballonges?\b/i },
  { key: "ASSIGNMENTS", about: "assignments", add: "the recorded assignments", docTypes: ["ASSIGNMENT"], words: /\bassignments?\b|\baom\b/i },
  { key: "RISK_SEARCH", about: "liens, taxes or bankruptcy", add: "a lien, tax and bankruptcy search", docTypes: ["RISK_SEARCH"], words: /\bbankrupt(cy)?\b|\bproperty tax(es)?\b|\btax liens?\b|\bback taxes\b|\blis pendens\b|\bcode violations?\b|\bhoa\b/i },
  { key: "PHOTOS", about: "photos", add: "property photos", docTypes: ["PHOTO"], words: /\bphotos?\b|\bpictures?\b|\binterior\b|\bexterior\b/i },
];

export type AskedTopic = { key: string; about: string; add: string; count: number; onFile: boolean };

// Open and answered questions by topic, with whether the file that answers it is already there. A declined question
// doesn't count: the seller already chose not to answer it.
export function askedTopics(questions: { question: string; status: string }[], onFile: (topic: QuestionTopic) => boolean): AskedTopic[] {
  const asked = questions.filter((row) => row.status === "OPEN" || row.status === "ANSWERED");
  return QUESTION_TOPICS.map((topic) => ({
    key: topic.key,
    about: topic.about,
    add: topic.add,
    count: asked.filter((row) => topic.words.test(row.question)).length,
    onFile: onFile(topic),
  })).filter((row) => row.count > 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Next steps

export const MAX_STEPS = 4;
// No bid this many days after going live, with buyers looking, is when a price comparison shows.
export const PRICE_AFTER_DAYS = 14;
// With too few similar listings to compare, buyers who opened it at least this often stand in for the median.
export const PRICE_VIEWS_FLOOR = 10;
// Questions about one file before the step shows.
export const ASKING_MIN = 2;
// Buy boxes that fit before "few opened it" means anything.
export const MANY_FITS = 5;
// Days before the desk's reminder when a reconfirmation shows.
export const RECONFIRM_SOON_DAYS = 7;

// Where the seller acts on a step. The page turns each into a link: a section on the page, the desk, or a desk tool.
export type StepTarget = "availability" | "diligence" | "files" | "photos" | "price" | "audience" | "limits" | "announce" | "bidderCount";

export type HealthStep = {
  key: "PAUSED" | "RECONFIRM" | "DILIGENCE" | "ASKING" | "PRICE" | "NO_FIT" | "FEW_OPENED" | "BIDDER_COUNT";
  fact: string;
  suggestion: string;
  // The rule that put it here, in one line.
  reason: string;
  target: StepTarget;
};

export type HealthFacts = {
  now: Date;
  kind: string;
  liveSince: Date | null;
  // An open or confirmed sanctions review on the listing or its seller of record. Nothing is suggested, and nothing
  // says why.
  hold: boolean;
  pausedAt: Date | null;
  confirmedAt: Date | null;
  remindedAt: Date | null;
  // A bid round is running, so the ask can't move (actions/desk.ts bulkReprice).
  roundOpen: boolean;
  private: boolean;
  regulatedOnly: boolean;
  showBidderCount: boolean;
  bidderCountLocked: boolean;
  askOfUpb: number | null;
  comps: Pick<CompCell, "median" | "low" | "high" | "count"> | null;
  indicative: { low: number; high: number } | null;
  funnel: Funnel;
  similar: Similar | null;
  // Buyers whose buy box fits it, and how many of them opened it.
  fits: number;
  fitsOpened: number;
  // The diligence items not on file, by the checklist's key and in its words.
  diligenceMissing: { key: string; text: string }[];
  topics: AskedTopic[];
  // The desk reading the page acts itself rather than asking the desk.
  desk?: boolean;
};

function fmtPct(value: number) {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

function reconfirmStep(facts: HealthFacts): HealthStep | null {
  if (facts.pausedAt) {
    return {
      key: "PAUSED",
      fact: `Paused ${prettyDate(facts.pausedAt)}. Buyers don't see it and it takes no new bids.`,
      suggestion: "Confirm the loans are still for sale to put it back on the book.",
      reason: `The desk didn't hear within ${PAUSE_AFTER_DAYS} days of asking whether the loans are still available.`,
      target: "availability",
    };
  }
  if (facts.remindedAt) {
    const pauses = new Date(facts.remindedAt.getTime() + PAUSE_AFTER_DAYS * DAY);
    return {
      key: "RECONFIRM",
      fact: `The desk asked on ${prettyDate(facts.remindedAt)} whether the loans are still for sale. Without an answer it pauses on ${prettyDate(pauses)}.`,
      suggestion: "Confirm they are still available, or withdraw the listing if they aren't.",
      reason: `Shown once the desk's ${REMIND_AFTER_DAYS}-day reminder is out.`,
      target: "availability",
    };
  }
  if (!facts.confirmedAt) return null;
  const asks = new Date(facts.confirmedAt.getTime() + REMIND_AFTER_DAYS * DAY);
  if (facts.now.getTime() < asks.getTime() - RECONFIRM_SOON_DAYS * DAY) return null;
  return {
    key: "RECONFIRM",
    fact: `Last confirmed available ${prettyDate(facts.confirmedAt)}. The desk asks again on ${prettyDate(asks)}.`,
    suggestion: "Confirm now, so the date buyers see stays current.",
    reason: `Shown in the ${RECONFIRM_SOON_DAYS} days before the desk's reminder.`,
    target: "availability",
  };
}

function priceStep(facts: HealthFacts): HealthStep | null {
  if (facts.roundOpen || facts.askOfUpb == null || !facts.liveSince) return null;
  const days = Math.floor((facts.now.getTime() - facts.liveSince.getTime()) / DAY);
  if (days < PRICE_AFTER_DAYS || facts.funnel.bids.total > 0) return null;
  const views = facts.funnel.views.total;
  const bar = facts.similar ? facts.similar.median.views : PRICE_VIEWS_FLOOR;
  if (views === 0 || views < bar) return null;
  const ask = facts.askOfUpb;
  const comps = facts.comps && facts.comps.count >= MIN_TRADES && ask > facts.comps.high ? facts.comps : null;
  const indicative = !comps && facts.indicative && ask > facts.indicative.high ? facts.indicative : null;
  if (!comps && !indicative) return null;
  const range = (low: number, high: number) => (low === high ? `about ${low}%` : `${low}–${high}%`);
  const fact = comps
    ? `Comparable closed trades cleared at about ${comps.median}% of UPB${comps.low === comps.high ? "" : `, between ${comps.low}% and ${comps.high}%`}; your ask is ${fmtPct(ask)}.`
    : `UPB's indicative range for it is ${range(indicative?.low ?? 0, indicative?.high ?? 0)} of UPB; your ask is ${fmtPct(ask)}.`;
  const looked = facts.similar ? "at least as often as similar listings" : `${PRICE_VIEWS_FLOOR} times or more`;
  return {
    key: "PRICE",
    fact,
    suggestion: "Buyers are opening it but nobody has bid. Weigh your ask against these figures. The price is yours to set.",
    reason: comps
      ? `Shown when buyers open it ${looked}, nobody has bid after ${PRICE_AFTER_DAYS} days live, and the ask is above the range of UPB's comparable trades.`
      : `Shown when buyers open it ${looked}, nobody has bid after ${PRICE_AFTER_DAYS} days live, and the ask is above UPB's indicative range, an estimate from the desk's model and UPB's own trades. Not an appraisal or advice.`,
    target: "price",
  };
}

function visibilityStep(facts: HealthFacts): HealthStep | null {
  const announce = facts.desk ? "Announce it to the deal list." : "Ask the desk to announce it to the deal list.";
  if (facts.fits === 0) {
    if (facts.private) {
      return {
        key: "NO_FIT",
        fact: "No buy box fits it. A private listing matches only the boxes of buyers you invited.",
        suggestion: "Invite more buyers, or make it public so every buyer's box can match it.",
        reason: "Shown when no buyer's buy box fits the listing.",
        target: "audience",
      };
    }
    if (facts.regulatedOnly) {
      return {
        key: "NO_FIT",
        fact: "No bank's or credit union's buy box fits it, and only they may bid.",
        suggestion: "Consider opening it to every approved buyer.",
        reason: "Shown when no buyer's buy box fits the listing.",
        target: "limits",
      };
    }
    return {
      key: "NO_FIT",
      fact: "No buyer's buy box fits it yet, so no buyer was matched to it.",
      suggestion: announce,
      reason: "Shown when no buyer's buy box fits the listing.",
      target: "announce",
    };
  }
  // An announcement goes to the whole list, which a private listing is kept from.
  if (facts.private || facts.fits < MANY_FITS || facts.fitsOpened * 2 >= facts.fits) return null;
  return {
    key: "FEW_OPENED",
    fact: `${plural(facts.fits, "buyer")} ${facts.fits === 1 ? "has a buy box that fits" : "have a buy box that fits"} it, and ${facts.fitsOpened} of them opened it.`,
    suggestion: announce,
    reason: `Shown when ${MANY_FITS} or more buy boxes fit and fewer than half of those buyers opened it.`,
    target: "announce",
  };
}

// The next steps, first rule first, at most MAX_STEPS. A sanctions review suggests nothing, and a pause suggests only
// the confirmation that lifts it, since nothing else reaches buyers until then.
export function nextSteps(facts: HealthFacts): HealthStep[] {
  if (facts.hold) return [];
  const reconfirm = reconfirmStep(facts);
  if (reconfirm?.key === "PAUSED") return [reconfirm];
  const steps: HealthStep[] = [];
  if (reconfirm) steps.push(reconfirm);
  if (facts.diligenceMissing.length) {
    steps.push({
      key: "DILIGENCE",
      fact: `The diligence set is missing: ${facts.diligenceMissing.map((item) => item.text).join("; ")}.`,
      suggestion: facts.desk ? "Add the missing files to the loan file, or waive them with a reason." : "Add the missing files, or send them to the desk.",
      reason: "The desk's diligence checklist reads these as not on file.",
      target: "diligence",
    });
  }
  // A file the diligence step already names isn't asked for twice.
  const asked = facts.topics
    .filter((topic) => topic.count >= ASKING_MIN && !topic.onFile && !facts.diligenceMissing.some((item) => item.key === topic.key))
    .sort((a, b) => b.count - a.count)
    .slice(0, 2);
  for (const topic of asked) {
    const photos = topic.key === "PHOTOS";
    steps.push({
      key: "ASKING",
      fact: `${topic.count} buyer questions ask about ${topic.about}, and ${photos ? "the listing has no photos" : "nothing in the data room answers them"}.`,
      suggestion: photos ? "Add property photos to the listing." : `Add ${topic.add} to the data room.`,
      reason: `Shown when ${ASKING_MIN} or more open or answered questions ask about the same file.`,
      target: photos ? "photos" : "files",
    });
  }
  const price = priceStep(facts);
  if (price) steps.push(price);
  const reach = visibilityStep(facts);
  if (reach) steps.push(reach);
  if (facts.funnel.bids.total >= 2 && !facts.showBidderCount && !facts.bidderCountLocked) {
    steps.push({
      key: "BIDDER_COUNT",
      fact: `${plural(facts.funnel.bids.total, "buyer")} have bid, and bidders can't see that others are bidding.`,
      suggestion: "Showing bidders how many others are bidding, never the amounts, can encourage competition.",
      reason: "Shown when 2 or more buyers have bid and the bidder count is off.",
      target: "bidderCount",
    });
  }
  return steps.slice(0, MAX_STEPS);
}

// The weekly report's line for a step.
export function stepLine(step: HealthStep | null | undefined) {
  return step ? `${step.fact} ${step.suggestion}` : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Loading. Server only.

export type ListingHealth = {
  listingId: string;
  daysLive: number;
  profile: Profile & { label: string };
  funnel: Funnel;
  similar: Similar | null;
  steps: HealthStep[];
};

const FILE_ACTIONS = ["DOCUMENT_DOWNLOAD", "TAPE_EXPORT", "MEMO_DOWNLOAD"];

// Every buyer event on these listings, without the seller's own, the filing broker's or the desk's. A deleted buyer's
// views have no user and are left out, as on the seller page.
export async function loadEvents(listings: { id: string; sellerId: string; brokerId?: string | null }[]): Promise<Map<string, FunnelEvents>> {
  const result = new Map<string, FunnelEvents>(listings.map((listing) => [listing.id, emptyEvents()]));
  if (!listings.length) return result;
  const ids = listings.map((listing) => listing.id);
  const [views, ndas, favorites, inquiries, questions, files] = await Promise.all([
    prisma.listingView.findMany({ where: { listingId: { in: ids }, userId: { not: null } }, select: { listingId: true, userId: true, createdAt: true } }),
    prisma.ndaAcknowledgment.findMany({ where: { listingId: { in: ids } }, select: { listingId: true, userId: true, acknowledgedAt: true } }),
    prisma.favorite.findMany({ where: { listingId: { in: ids } }, select: { listingId: true, userId: true, createdAt: true } }),
    prisma.inquiry.findMany({ where: { listingId: { in: ids }, type: { in: ["OFFER", "INFO_REQUEST"] } }, select: { listingId: true, buyerId: true, type: true, createdAt: true } }),
    prisma.listingQuestion.findMany({ where: { listingId: { in: ids } }, select: { listingId: true, askerId: true, createdAt: true } }),
    prisma.auditEvent.findMany({ where: { entityId: { in: ids }, action: { in: FILE_ACTIONS } }, select: { entityId: true, actorId: true, createdAt: true } }),
  ]);
  const people = new Set<string>([
    ...views.map((row) => row.userId as string),
    ...ndas.map((row) => row.userId),
    ...favorites.map((row) => row.userId),
    ...inquiries.map((row) => row.buyerId),
    ...questions.map((row) => row.askerId),
    ...files.map((row) => row.actorId).filter((id): id is string => Boolean(id)),
  ]);
  const desk = new Set(
    people.size ? (await prisma.user.findMany({ where: { id: { in: [...people] }, role: "ADMIN" }, select: { id: true } })).map((user) => user.id) : [],
  );
  const owners = new Map(listings.map((listing) => [listing.id, [listing.sellerId, listing.brokerId]]));
  const add = (listingId: string, stage: FunnelStage, userId: string | null | undefined, at: Date) => {
    if (!userId || desk.has(userId) || owners.get(listingId)?.includes(userId)) return;
    result.get(listingId)?.[stage].push({ userId, at });
  };
  for (const row of views) add(row.listingId, "views", row.userId, row.createdAt);
  for (const row of ndas) add(row.listingId, "ndas", row.userId, row.acknowledgedAt);
  for (const row of favorites) add(row.listingId, "watchers", row.userId, row.createdAt);
  for (const row of inquiries) add(row.listingId, row.type === "OFFER" ? "bids" : "questions", row.buyerId, row.createdAt);
  for (const row of questions) add(row.listingId, "questions", row.askerId, row.createdAt);
  for (const row of files) add(row.entityId, "room", row.actorId, row.createdAt);
  return result;
}

// Each live listing's funnel, for the seller desk's one-line summaries.
export async function loadFunnels(listings: { id: string; sellerId: string; brokerId?: string | null }[], now = new Date()) {
  const events = await loadEvents(listings);
  return new Map([...events].map(([id, rows]) => [id, funnelOf(rows, now)]));
}

type SubjectRow = Prisma.ListingGetPayload<{ select: typeof SUBJECT_SELECT }>;

const SUBJECT_SELECT = {
  id: true,
  kind: true,
  status: true,
  sellerId: true,
  brokerId: true,
  approvedAt: true,
  launchAt: true,
  visibility: true,
  buyerLimit: true,
  showBidderCount: true,
  bidMode: true,
  bidDeadline: true,
  availableConfirmedAt: true,
  availabilityRemindedAt: true,
  stalePausedAt: true,
  notes: true,
} satisfies Prisma.ListingSelect;

const PEER_STATUSES = ["APPROVED", "PENDING", "SOLD", "WITHDRAWN"] as const;

// Other sellers' public listings like each subject, with the day each is counted to. The subject's own seller and
// broker are left out, so the seller can't take their own listings out of a median and read what is left.
async function similarListings(subjects: SubjectRow[], now: Date) {
  const byProfile = new Map<string, Profile>();
  for (const subject of subjects) {
    const profile = profileOf(subject);
    byProfile.set(`${profile.kind}|${profile.lienPosition}|${profile.paymentStatus}`, profile);
  }
  const candidates = (
    await Promise.all(
      [...byProfile.values()].map((profile) =>
        prisma.listing.findMany({
          where: {
            kind: profile.kind as ListingKind,
            status: { in: [...PEER_STATUSES] },
            approvedAt: { lte: now },
            notes: { some: { lienPosition: profile.lienPosition as LienPosition, paymentStatus: profile.paymentStatus as PaymentStatus } },
            AND: [publicListing()],
          },
          select: {
            id: true,
            kind: true,
            sellerId: true,
            brokerId: true,
            status: true,
            approvedAt: true,
            launchAt: true,
            soldAt: true,
            withdrawnAt: true,
            updatedAt: true,
            notes: { select: { upb: true, lienPosition: true, paymentStatus: true } },
          },
          orderBy: { approvedAt: "desc" },
          take: SIMILAR_SCAN,
        }),
      ),
    )
  ).flat();
  type Peer = { id: string; sellerId: string; brokerId: string | null; until: Date };
  const result = new Map<string, Peer[]>();
  for (const subject of subjects) {
    const profile = profileOf(subject);
    const days = daysLive(subject, now);
    const peers: Peer[] = [];
    for (const peer of candidates) {
      if (peers.length >= SIMILAR_LIMIT) break;
      if (peer.id === subject.id || peer.sellerId === subject.sellerId || (subject.brokerId && peer.brokerId === subject.brokerId)) continue;
      if (!sameProfile(profileOf(peer), profile)) continue;
      const until = peerWindow(peer, days, now);
      if (until) peers.push({ id: peer.id, sellerId: peer.sellerId, brokerId: peer.brokerId, until });
    }
    result.set(subject.id, peers);
  }
  return result;
}

// Open or confirmed sanctions reviews on the listings or their sellers of record.
async function heldListings(subjects: SubjectRow[]) {
  const parties = [...new Set(subjects.flatMap((subject) => [subject.sellerId, subject.brokerId]).filter((id): id is string => Boolean(id)))];
  const rows = await prisma.ofacCheck.findMany({
    where: { result: "REVIEW", OR: [{ listingId: { in: subjects.map((subject) => subject.id) } }, { userId: { in: parties } }] },
    select: { listingId: true, userId: true, result: true, status: true },
  });
  const open = rows.filter(ofacBlocks);
  return new Set(
    subjects
      .filter((subject) => open.some((row) => row.listingId === subject.id || row.userId === subject.sellerId || (subject.brokerId && row.userId === subject.brokerId)))
      .map((subject) => subject.id),
  );
}

// The health of each live listing among these ids. Listings that aren't live are left out. `desk` words the steps for
// the desk reading the page. Nothing returned names a buyer, another listing or another seller.
export async function listingHealth(listingIds: string[], now = new Date(), options: { desk?: boolean } = {}): Promise<Map<string, ListingHealth>> {
  const result = new Map<string, ListingHealth>();
  if (!listingIds.length) return result;
  const subjects = await prisma.listing.findMany({ where: { id: { in: listingIds }, status: "APPROVED" }, select: SUBJECT_SELECT });
  if (!subjects.length) return result;
  const ids = subjects.map((subject) => subject.id);
  const peers = await similarListings(subjects, now);
  const peerRows = [...new Map([...peers.values()].flat().map((peer) => [peer.id, peer])).values()];
  const [events, trades, indicatives, questions, documents, matches, held, diligence] = await Promise.all([
    loadEvents([...subjects, ...peerRows.filter((peer) => !ids.includes(peer.id))]),
    loadClosedTrades(now).catch(() => []),
    // Standing prices stay out: one buyer's standing price is theirs, not the seller's to read.
    loadIndicatives(subjects.map((subject) => ({ id: subject.id, status: subject.status, notes: subject.notes as LoaderNote[] })), now, { standing: false }).catch(() => new Map()),
    prisma.listingQuestion.findMany({ where: { listingId: { in: ids } }, select: { listingId: true, askerId: true, question: true, status: true } }),
    prisma.document.findMany({ where: { listingId: { in: ids } }, select: { listingId: true, type: true } }),
    prisma.listingMatch.findMany({ where: { listingId: { in: ids } }, select: { listingId: true, userId: true } }),
    heldListings(subjects),
    Promise.all(subjects.map((subject) => loadDiligence(subject.id))),
  ]);
  subjects.forEach((subject, index) => {
    const own = events.get(subject.id) ?? emptyEvents();
    const funnel = funnelOf(own, now);
    const days = daysLive(subject, now);
    const samples = (peers.get(subject.id) ?? []).map((peer) => countsUntil(events.get(peer.id) ?? emptyEvents(), peer.until));
    const similar = similarMedians(samples, days);
    const loans = loansForSale(subject.status, subject.notes);
    const upb = loans.reduce((sum, note) => sum + Math.max(0, note.upb), 0);
    const ask = loans.reduce((sum, note) => sum + Math.max(0, note.askingPrice), 0);
    const comps = loans.length ? compsFor(compSubjectOf(loans), trades, MIN_TRADES, now) : null;
    const range = indicatives.get(subject.id) ?? null;
    const loaded = diligence[index];
    const pool = subject.kind === "POOL";
    const missing = (loaded?.diligence.lines ?? [])
      .filter((line) => line.state === "missing")
      .map((line) => ({ key: line.key as string, text: pool && line.scope === "loan" ? `${line.label} on ${plural(line.missing.length, "loan")}` : line.label }));
    const types = new Set(documents.filter((row) => row.listingId === subject.id).map((row) => row.type as string));
    const complete = new Set((loaded?.diligence.lines ?? []).filter((line) => line.state === "complete").map((line) => line.key as string));
    const topics = askedTopics(
      questions.filter((row) => row.listingId === subject.id && row.askerId !== subject.sellerId && row.askerId !== subject.brokerId),
      (topic) => topic.docTypes.some((type) => types.has(type)) || complete.has(topic.key),
    );
    const fitting = new Set(matches.filter((row) => row.listingId === subject.id).map((row) => row.userId));
    fitting.delete(subject.sellerId);
    const opened = new Set(own.views.map((view) => view.userId));
    const profile = profileOf(subject);
    const facts: HealthFacts = {
      now,
      kind: subject.kind,
      liveSince: liveSince(subject),
      hold: held.has(subject.id),
      pausedAt: stalePaused(subject) ? subject.stalePausedAt : null,
      confirmedAt: availableSince(subject),
      remindedAt: remindedSince(subject),
      roundOpen: subject.bidMode !== "NONE" && !deadlinePassed(subject.bidDeadline, now),
      private: isPrivateListing(subject),
      regulatedOnly: regulatedOnly(subject),
      showBidderCount: subject.showBidderCount === true,
      bidderCountLocked: bidderCountLock(subject, now) !== null,
      askOfUpb: upb > 0 && ask > 0 ? Math.round((ask / upb) * 1000) / 10 : null,
      comps,
      indicative: range ? { low: range.low, high: range.high } : null,
      funnel,
      similar,
      fits: fitting.size,
      fitsOpened: [...fitting].filter((userId) => opened.has(userId)).length,
      diligenceMissing: missing,
      topics,
      desk: options.desk,
    };
    result.set(subject.id, { listingId: subject.id, daysLive: days, profile: { ...profile, label: profileLabel(profile) }, funnel, similar, steps: nextSteps(facts) });
  });
  return result;
}
