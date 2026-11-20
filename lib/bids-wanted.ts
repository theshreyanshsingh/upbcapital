import { randomBytes } from "node:crypto";
import type { BuyerRequest, Prisma } from "@prisma/client";
import { audit } from "@/lib/audit";
import { chosenEntity } from "@/lib/buyer-entities";
import { unset } from "@/lib/db-filters";
import { MIN_FIRMS } from "@/lib/demand-board";
import { notify } from "@/lib/email";
import { programLabel, PROGRAM_CHOICES } from "@/lib/filters";
import { moneyCompact, prettyDate } from "@/lib/format";
import { regulatedOnly, regulatedUserIds } from "@/lib/institutions";
import { LIEN_POSITIONS, PAYMENT_STATUSES, US_STATES } from "@/lib/labels";
import { typedNumber } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { canSee, excludes, hiddenReasons, inviteTokenHash, isPrivateListing, listingAccess, peopleOf } from "@/lib/private-listings";
import { stalePaused } from "@/lib/provenance-rules";
import { sellerLabel } from "@/lib/seller-anonymity";
import { isPro } from "@/lib/settings";
import { buyerRecordLines, buyerTrackRecords } from "@/lib/track-record";
import { recertBlock } from "@/lib/verification";

// Bids wanted: a buyer's standing request for paper, posted for sellers and brokers to answer, as Percent's PCTX lists
// and the institutional desks work. The buyer says what it wants. Sellers and brokers see the request with the buyer
// named only by type ("Fund", "Bank"), beside the buyer's factual record from lib/track-record.ts, never a name, an
// email or a firm. A seller answers by sending one of its own listings: a private listing is invited to that buyer
// alone under the rules in lib/private-listings.ts, and a public one stays public and is pointed out to them. The
// price fields are the buyer's own disclosure, shown to sellers as a price guide. Nothing here is a bid.

const DAY = 24 * 60 * 60 * 1000;

export const REQUEST_STATUSES = ["OPEN", "PAUSED", "FILLED", "CLOSED"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const RESPONSE_STATUSES = ["SENT", "VIEWED", "DECLINED", "BID"] as const;
export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];

// Open requests a firm keeps at once. A firm's seats act as the firm (lib/seats.ts), so they share the five.
export const OPEN_LIMIT = 5;
export const TITLE_MIN = 4;
export const TITLE_MAX = 80;
export const NOTES_MAX = 500;
export const REASON_MAX = 300;
export const EXPIRY_DAYS = [30, 60, 90] as const;
export const DEFAULT_EXPIRY_DAYS = 60;
export const PRICE_GUIDE_LINE = "Sellers see this price guide.";
const MAX_UPB = 5e9;
const MAX_LOANS = 100_000;

export const REQUEST_KINDS = [
  { value: "ANY", label: "Pools or single notes" },
  { value: "POOL", label: "Pools only" },
  { value: "SINGLE", label: "Single notes only" },
] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number]["value"];

export const REQUEST_STATUS_LABELS: Record<string, string> = { OPEN: "Open", PAUSED: "Paused", FILLED: "Filled", CLOSED: "Closed" };
// The same answer in each side's words.
export const BUYER_ANSWER_LABELS: Record<string, string> = { SENT: "New", VIEWED: "You opened it", DECLINED: "You passed", BID: "You bid" };
export const SELLER_ANSWER_LABELS: Record<string, string> = { SENT: "Sent", VIEWED: "The buyer opened it", DECLINED: "The buyer passed", BID: "The buyer bid" };

// Listings a seller can answer with: filed and in review, or live.
export const ANSWER_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "APPROVED"] as const;
const SELLER_SIDE = ["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER", "BROKER"];

// The line an answer's private invitation carries where an emailed one has the address. The seller's audience list
// shows it (components/private-sale.tsx), and the buyer's address would name them. The invitation is to the buyer's
// account, so nothing ever mails or matches on this line.
export const REQUEST_INVITE = "Answer to a buyer request";

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string) => ({ ok: false as const, error });
const NOT_YOURS = "That request isn't your firm's.";
const GONE = "That request is no longer open.";

// ---------------------------------------------------------------------------------------------------------------
// What a request asks for. The names follow a buy box (lib/buy-box.ts) where they mean the same thing.

export type RequestCriteria = {
  liens: string[];
  statuses: string[];
  states: string[];
  programs: string[];
  upbMin: number | null;
  upbMax: number | null;
  // Loans in a pool. A single note is one loan, so these are blank on a request for single notes.
  minLoans: number | null;
  maxLoans: number | null;
  // The buyer's price guide: the most it pays as a percent of UPB, and the yield it targets. Either, both or neither.
  priceToUpbMax: number | null;
  targetYield: number | null;
  kind: RequestKind;
};

const LIEN_VALUES: readonly string[] = LIEN_POSITIONS.map((item) => item.value);
const STATUS_VALUES: readonly string[] = PAYMENT_STATUSES.map((item) => item.value);
const PROGRAM_VALUES: readonly string[] = PROGRAM_CHOICES.map((item) => item.value);
const STATE_VALUES: readonly string[] = US_STATES;

function picked(raw: unknown, allowed: readonly string[]) {
  return Array.isArray(raw) ? [...new Set(raw.map((value) => String(value)))].filter((value) => allowed.includes(value)) : [];
}

function figure(raw: unknown) {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

// A stored request as the pages read it. Anything unknown in the JSON is dropped, and a missing field takes any.
export function readCriteria(json: unknown): RequestCriteria {
  const raw = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  return {
    liens: picked(raw.liens, LIEN_VALUES),
    statuses: picked(raw.statuses, STATUS_VALUES),
    states: picked(raw.states, STATE_VALUES),
    programs: picked(raw.programs, PROGRAM_VALUES),
    upbMin: figure(raw.upbMin),
    upbMax: figure(raw.upbMax),
    minLoans: figure(raw.minLoans),
    maxLoans: figure(raw.maxLoans),
    priceToUpbMax: figure(raw.priceToUpbMax),
    targetYield: figure(raw.targetYield),
    kind: raw.kind === "POOL" || raw.kind === "SINGLE" ? raw.kind : "ANY",
  };
}

// "TX, FL or OK": a request takes any one of what it names.
const either = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} or ${items.at(-1)}` : items[0] ?? "");
const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

function range(min: number | null, max: number | null, show: (value: number) => string, unit: string) {
  if (min != null && max != null) return min === max ? `${show(min)} ${unit}` : `${show(min)} to ${show(max)} ${unit}`;
  if (min != null) return `At least ${show(min)} ${unit}`;
  if (max != null) return `Up to ${show(max)} ${unit}`;
  return null;
}

// The request in plain words, a line each, for the board, the buyer's page and the desk.
export function criteriaLines(criteria: RequestCriteria): string[] {
  const lienWords = criteria.liens.map((value) => LIEN_POSITIONS.find((item) => item.value === value)?.label.toLowerCase() ?? value.toLowerCase());
  const statusWords = criteria.statuses.map((value) => PAYMENT_STATUSES.find((item) => item.value === value)?.label.toLowerCase() ?? value.toLowerCase());
  const liens = lienWords.length ? `${either(lienWords)} lien${lienWords.length > 1 ? "s" : ""}` : "any lien";
  const lines = [
    REQUEST_KINDS.find((item) => item.value === criteria.kind)?.label ?? "Pools or single notes",
    `${liens.replace(/^./, (first) => first.toUpperCase())}, ${statusWords.length ? either(statusWords) : "any performance"}`,
    criteria.programs.length ? `${either(criteria.programs.map(programLabel))} loans` : "Any loan program",
    criteria.states.length ? `In ${either(criteria.states)}` : "Any state",
    range(criteria.upbMin, criteria.upbMax, moneyCompact, "of UPB"),
    criteria.kind === "SINGLE" ? null : range(criteria.minLoans, criteria.maxLoans, (value) => value.toLocaleString("en-US"), "loans"),
    criteria.priceToUpbMax != null ? `Price guide: up to ${criteria.priceToUpbMax}% of UPB` : null,
    criteria.targetYield != null ? `Price guide: a ${criteria.targetYield}% target yield` : null,
  ];
  return lines.filter((line): line is string => Boolean(line));
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the form

export type RequestInput = {
  title?: unknown;
  notes?: unknown;
  expiryDays?: unknown;
  kind?: unknown;
  liens?: unknown;
  statuses?: unknown;
  programs?: unknown;
  states?: unknown;
  upbMin?: unknown;
  upbMax?: unknown;
  minLoans?: unknown;
  maxLoans?: unknown;
  priceToUpbMax?: unknown;
  targetYield?: unknown;
  buyerEntityId?: unknown;
};

// The form's fields: a checkbox per lien, performance and program, as the buy box sends them.
export function requestInputFrom(formData: FormData): RequestInput {
  const checked = (prefix: string, values: readonly string[]) => values.filter((value) => formData.get(`${prefix}_${value}`) === "on");
  const field = (key: string) => formData.get(key) ?? "";
  return {
    title: field("title"),
    notes: field("notes"),
    expiryDays: field("expiryDays"),
    kind: field("kind"),
    liens: checked("lien", LIEN_VALUES),
    statuses: checked("status", STATUS_VALUES),
    programs: checked("program", PROGRAM_VALUES),
    states: field("states"),
    upbMin: field("upbMin"),
    upbMax: field("upbMax"),
    minLoans: field("minLoans"),
    maxLoans: field("maxLoans"),
    priceToUpbMax: field("priceToUpbMax"),
    targetYield: field("targetYield"),
    buyerEntityId: field("buyerEntityId"),
  };
}

const oneLine = (raw: unknown) => String(raw ?? "").replace(/\s+/g, " ").trim();
// An email address, a link or a phone number. Sellers answer through UPB, so none belongs on a request.
const CONTACT = /https?:|www\.|[^\s@]+@[^\s@]+\.[a-z]{2,}|\b\d{3}[\s().-]*\d{3}[\s.-]*\d{4}\b/i;

type Read = { error: string } | { error: null; title: string; notes: string; expiryDays: number; criteria: RequestCriteria };

function chosen(raw: unknown, allowed: readonly string[], what: string): { error: string } | { error: null; values: string[] } {
  const values = Array.isArray(raw) ? [...new Set(raw.map((value) => String(value).trim().toUpperCase()).filter(Boolean))] : [];
  return values.some((value) => !allowed.includes(value)) ? { error: `Choose the ${what} from the list.` } : { error: null, values };
}

function amount(raw: unknown, what: string, check: (value: number) => boolean, rule: string): { error: string } | { error: null; value: number | null } {
  const text = oneLine(raw);
  if (!text) return { error: null, value: null };
  const value = typedNumber(text);
  if (!Number.isFinite(value) || !check(value)) return { error: `Enter ${what} ${rule}.` };
  return { error: null, value };
}

// Everything on the form, checked. The firm's own names are checked against the words separately (namesFirm).
export function readRequest(input: RequestInput): Read {
  const title = oneLine(input.title);
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) return { error: `Give the request a title of ${TITLE_MIN} to ${TITLE_MAX} characters, such as "VA performing firsts in Texas".` };
  const notes = String(input.notes ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (notes.length > NOTES_MAX) return { error: `Keep the notes to ${NOTES_MAX} characters.` };
  if (CONTACT.test(title) || CONTACT.test(notes)) return { error: "Leave emails, links and phone numbers out of the title and notes. Sellers answer through UPB and see your firm only as a type." };
  const expiryDays = Number(oneLine(input.expiryDays) || DEFAULT_EXPIRY_DAYS);
  if (!(EXPIRY_DAYS as readonly number[]).includes(expiryDays)) return { error: "Choose how long the request runs: 30, 60 or 90 days." };
  const kindRaw = oneLine(input.kind) || "ANY";
  if (!REQUEST_KINDS.some((item) => item.value === kindRaw)) return { error: "Choose pools, single notes or either." };
  const kind = kindRaw as RequestKind;
  const liens = chosen(input.liens, LIEN_VALUES, "liens");
  if (liens.error !== null) return liens;
  const statuses = chosen(input.statuses, STATUS_VALUES, "payment statuses");
  if (statuses.error !== null) return statuses;
  const programs = chosen(input.programs, PROGRAM_VALUES, "loan programs");
  if (programs.error !== null) return programs;
  const stateWords = [...new Set(String(input.states ?? "").split(/[\s,;]+/).map((state) => state.trim().toUpperCase()).filter(Boolean))];
  const badStates = stateWords.filter((state) => !STATE_VALUES.includes(state));
  if (badStates.length) return { error: `Check ${badStates.slice(0, 5).join(", ")}: enter states as two-letter codes, such as TX, FL.` };
  const upbMin = amount(input.upbMin, "the UPB minimum", (value) => value > 0 && value <= MAX_UPB, "as a dollar amount, such as 5M");
  if (upbMin.error !== null) return upbMin;
  const upbMax = amount(input.upbMax, "the UPB maximum", (value) => value > 0 && value <= MAX_UPB, "as a dollar amount, such as 20M");
  if (upbMax.error !== null) return upbMax;
  if (upbMin.value != null && upbMax.value != null && upbMin.value > upbMax.value) return { error: "The UPB minimum is above the maximum." };
  const whole = (value: number) => Number.isInteger(value) && value >= 1 && value <= MAX_LOANS;
  const minLoans = amount(input.minLoans, "the fewest loans", whole, "as a whole number");
  if (minLoans.error !== null) return minLoans;
  const maxLoans = amount(input.maxLoans, "the most loans", whole, "as a whole number");
  if (maxLoans.error !== null) return maxLoans;
  if (minLoans.value != null && maxLoans.value != null && minLoans.value > maxLoans.value) return { error: "The fewest loans is above the most." };
  if (kind === "SINGLE" && (minLoans.value != null || maxLoans.value != null)) return { error: "A single note is one loan. Leave the loan count blank, or ask for pools." };
  const priceToUpbMax = amount(input.priceToUpbMax, "the highest price", (value) => value > 0 && value <= 150, "as a percent of UPB, above 0 and up to 150");
  if (priceToUpbMax.error !== null) return priceToUpbMax;
  const targetYield = amount(input.targetYield, "the target yield", (value) => value > 0 && value <= 50, "as a percent, above 0 and up to 50");
  if (targetYield.error !== null) return targetYield;
  const criteria: RequestCriteria = {
    liens: liens.values,
    statuses: statuses.values,
    states: stateWords,
    programs: programs.values,
    upbMin: upbMin.value,
    upbMax: upbMax.value,
    minLoans: minLoans.value,
    maxLoans: maxLoans.value,
    priceToUpbMax: priceToUpbMax.value,
    targetYield: targetYield.value,
    kind,
  };
  const limited =
    criteria.kind !== "ANY" ||
    criteria.liens.length > 0 ||
    criteria.statuses.length > 0 ||
    criteria.programs.length > 0 ||
    criteria.states.length > 0 ||
    [criteria.upbMin, criteria.upbMax, criteria.minLoans, criteria.maxLoans].some((value) => value != null);
  if (!limited) return { error: "Set at least one limit, such as a lien, a state or a UPB range, so sellers know what fits." };
  return { error: null, title, notes, expiryDays, criteria };
}

// Legal words drop out, so "Acme Capital, LLC" is caught as "Acme Capital". A name under five letters is too likely to
// be an ordinary word to refuse on.
const LEGAL_WORDS = /\b(llc|l l c|inc|incorporated|corp|corporation|co|company|lp|llp|ltd|limited)\b/g;
const plain = (text: string) => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(LEGAL_WORDS, " ").replace(/\s+/g, " ").trim()} `;

// Whether the words name the firm: its account, the person signed in, the vetted file or a buying entity.
async function namesFirm(firmId: string, words: string, person?: string | null) {
  const [account, profile, entities] = await Promise.all([
    prisma.user.findUnique({ where: { id: firmId }, select: { name: true, companyName: true } }),
    prisma.buyerProfile.findUnique({ where: { userId: firmId }, select: { entityName: true } }),
    prisma.buyerEntity.findMany({ where: { userId: firmId }, select: { name: true } }),
  ]);
  const hay = plain(words);
  const names = [account?.name, account?.companyName, person, profile?.entityName, ...entities.map((entity) => entity.name)]
    .map((name) => plain(name ?? "").trim())
    .filter((name) => name.length >= 5);
  return names.some((name) => hay.includes(` ${name} `));
}
const NAMED = "Leave your name and your firm's name out of the title and notes. Sellers see your firm only as a type.";

// ---------------------------------------------------------------------------------------------------------------
// Who may post, and whose requests show. An approved buyer on a current file, on Pro or a desk-checked bank or credit
// union. A buyer who stops qualifying keeps their requests on file, and the board stops showing them until they do.

type BuyerAccount = {
  role: string;
  accountStatus: string;
  subscriptionTier: string;
  subscriptionStatus: string;
  subscriptionCurrentPeriodEnd?: Date | null;
  trialEndsAt?: Date | null;
  deletedAt?: Date | null;
};
type BuyerFile = { status: string; recertifyBy?: Date | null } | null | undefined;

export function requestProblem(account: BuyerAccount | null | undefined, file: BuyerFile, regulated: boolean, now = new Date()) {
  if (!account || account.role !== "BUYER" || account.deletedAt) return "Requests are for buyer accounts.";
  if (account.accountStatus !== "APPROVED") return "Requests open once the desk approves your account.";
  if (file?.status !== "APPROVED") return "Requests need a buyer file the desk approved. Finish it at /buyer/verification.";
  if (recertBlock(file, now)) return "Your buyer file is due for re-certification. Confirm or update it at /buyer/verification, and your requests show again once the desk approves it.";
  if (!regulated && !isPro(account, now)) return "Requests are a Pro privilege, and open to desk-checked banks and credit unions on any plan. Subscribe at /buyer/subscription.";
  return null;
}

type Standing = { problem: string | null; entityType: string | null };

async function standingOf(userIds: string[], now: Date) {
  const ids = [...new Set(userIds)];
  const out = new Map<string, Standing>();
  if (!ids.length) return out;
  const [accounts, files, regulated] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, role: true, accountStatus: true, subscriptionTier: true, subscriptionStatus: true, subscriptionCurrentPeriodEnd: true, trialEndsAt: true, deletedAt: true },
    }),
    prisma.buyerProfile.findMany({ where: { userId: { in: ids } }, select: { userId: true, status: true, recertifyBy: true, entityType: true } }),
    regulatedUserIds(ids),
  ]);
  for (const id of ids) {
    const file = files.find((row) => row.userId === id);
    out.set(id, { problem: requestProblem(accounts.find((row) => row.id === id), file, regulated.has(id), now), entityType: file?.entityType ?? null });
  }
  return out;
}

// The firm a person acts for. A seat signed in already acts as its firm (lib/auth.ts); a seat's own row names it.
async function firmOf(userId: string) {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, principalId: true } });
  return row?.principalId || userId;
}

export async function requestBlock(user: { id: string }, now = new Date()) {
  const firm = await firmOf(user.id);
  const standing = (await standingOf([firm], now)).get(firm);
  return standing ? standing.problem : "Requests are for buyer accounts.";
}

export function isLive(request: { status: string; expiresAt?: Date | null }, now = new Date()) {
  return request.status === "OPEN" && (!request.expiresAt || request.expiresAt.getTime() > now.getTime());
}

function liveWhere(now: Date): Prisma.BuyerRequestWhereInput {
  return { status: "OPEN", OR: [{ expiresAt: { gt: now } }, ...unset("expiresAt").OR] };
}

async function liveCount(firm: string, now: Date, except?: string) {
  return prisma.buyerRequest.count({ where: { AND: [liveWhere(now), { userId: firm }, ...(except ? [{ id: { not: except } }] : [])] } });
}

const LIMIT_LINE = `Your firm has ${OPEN_LIMIT} open requests, the most at once. Pause, close or mark one filled first.`;

// ---------------------------------------------------------------------------------------------------------------
// The buyer's side

type Poster = { id: string; actor?: { name: string } | null };

export async function createRequest(user: Poster, input: RequestInput, now = new Date()): Promise<Outcome<{ id: string }>> {
  const firm = await firmOf(user.id);
  const block = (await standingOf([firm], now)).get(firm)?.problem;
  if (block) return fail(block);
  const read = readRequest(input);
  if (read.error !== null) return fail(read.error);
  const entity = await chosenEntity(firm, input.buyerEntityId);
  if (entity.error !== null) return fail(entity.error);
  if (await namesFirm(firm, `${read.title} ${read.notes}`, user.actor?.name)) return fail(NAMED);
  if ((await liveCount(firm, now)) >= OPEN_LIMIT) return fail(LIMIT_LINE);
  const row = await prisma.buyerRequest.create({
    data: {
      userId: firm,
      buyerEntityId: entity.entityId,
      title: read.title,
      criteria: read.criteria,
      notes: read.notes,
      status: "OPEN",
      expiresAt: new Date(now.getTime() + read.expiryDays * DAY),
    },
  });
  await audit(firm, "BUYER_REQUEST", "buyerRequest", row.id, `Posted · ${read.title} · ${read.expiryDays} days`);
  return { ok: true, value: { id: row.id } };
}

// An edit sets a new expiry, counted from the save, so an expired request comes back by editing it.
export async function updateRequest(user: Poster, requestId: string, input: RequestInput, now = new Date()): Promise<Outcome<{ id: string }>> {
  const firm = await firmOf(user.id);
  const request = await prisma.buyerRequest.findUnique({ where: { id: requestId } });
  if (!request || request.userId !== firm) return fail(NOT_YOURS);
  if (request.status !== "OPEN" && request.status !== "PAUSED") return fail("This request is filled or closed. Post a new one instead.");
  const block = (await standingOf([firm], now)).get(firm)?.problem;
  if (block) return fail(block);
  const read = readRequest(input);
  if (read.error !== null) return fail(read.error);
  const entity = await chosenEntity(firm, input.buyerEntityId);
  if (entity.error !== null) return fail(entity.error);
  if (await namesFirm(firm, `${read.title} ${read.notes}`, user.actor?.name)) return fail(NAMED);
  if (request.status === "OPEN" && (await liveCount(firm, now, request.id)) >= OPEN_LIMIT) return fail(LIMIT_LINE);
  await prisma.buyerRequest.update({
    where: { id: request.id },
    data: { title: read.title, notes: read.notes, criteria: read.criteria, buyerEntityId: entity.entityId, expiresAt: new Date(now.getTime() + read.expiryDays * DAY) },
  });
  await audit(firm, "BUYER_REQUEST_EDITED", "buyerRequest", request.id, `${read.title} · ${read.expiryDays} days`);
  return { ok: true, value: { id: request.id } };
}

export const STATUS_ACTIONS = ["PAUSE", "RESUME", "FILLED", "CLOSE"] as const;
export type StatusAction = (typeof STATUS_ACTIONS)[number];

// Pause and resume, or finish it: filled when the buyer bought what it asked for, closed otherwise. Filled and closed
// are for good, and a new request starts over.
export async function setRequestStatus(user: Poster, requestId: string, action: unknown, now = new Date()): Promise<Outcome<{ status: RequestStatus }>> {
  if (!(STATUS_ACTIONS as readonly unknown[]).includes(action)) return fail("Choose pause, resume, filled or close.");
  const firm = await firmOf(user.id);
  const request = await prisma.buyerRequest.findUnique({ where: { id: requestId } });
  if (!request || request.userId !== firm) return fail(NOT_YOURS);
  const from = request.status;
  if (from !== "OPEN" && from !== "PAUSED") return fail("This request is filled or closed already.");
  let status: RequestStatus;
  if (action === "PAUSE") {
    if (from !== "OPEN") return fail("This request is paused already.");
    status = "PAUSED";
  } else if (action === "RESUME") {
    if (from !== "PAUSED") return fail("This request is open already.");
    const block = (await standingOf([firm], now)).get(firm)?.problem;
    if (block) return fail(block);
    if (request.expiresAt && request.expiresAt.getTime() <= now.getTime()) return fail(`This request ran out on ${prettyDate(request.expiresAt)}. Edit it to set a new expiry.`);
    if ((await liveCount(firm, now, request.id)) >= OPEN_LIMIT) return fail(LIMIT_LINE);
    status = "OPEN";
  } else {
    status = action === "FILLED" ? "FILLED" : "CLOSED";
  }
  const moved = await prisma.buyerRequest.updateMany({ where: { id: request.id, status: from }, data: { status } });
  if (moved.count !== 1) return fail("This request changed a moment ago. Look again.");
  await audit(firm, "BUYER_REQUEST_STATUS", "buyerRequest", request.id, `${from} to ${status}`);
  return { ok: true, value: { status } };
}

// The buyer passes on a listing a seller sent. The seller hears, so it stops waiting. A bid already in stands, and is
// withdrawn from the buyer's inquiries if at all.
export async function declineResponse(user: Poster, responseId: string): Promise<Outcome<null>> {
  const firm = await firmOf(user.id);
  const response = await prisma.requestResponse.findUnique({ where: { id: responseId } });
  const request = response ? await prisma.buyerRequest.findUnique({ where: { id: response.requestId }, select: { id: true, userId: true, title: true } }) : null;
  if (!response || !request || request.userId !== firm) return fail("That answer isn't to one of your firm's requests.");
  if (response.status === "DECLINED") return { ok: true, value: null };
  if (response.status === "BID") return fail("You bid on this listing. Withdraw the bid from your inquiries instead.");
  await prisma.requestResponse.update({ where: { id: response.id }, data: { status: "DECLINED" } });
  await audit(firm, "REQUEST_ANSWER_DECLINED", "buyerRequest", request.id, response.listingId);
  const [seller, listing] = await Promise.all([
    prisma.user.findUnique({ where: { id: response.sellerId }, select: { email: true } }),
    prisma.listing.findUnique({ where: { id: response.listingId }, select: { title: true } }),
  ]);
  if (seller && listing) {
    await notify(seller.email, `A buyer passed · ${listing.title}`, `The buyer behind the request "${request.title}" passed on ${listing.title}. The listing is as it was, and any invitation stays open until you revoke it.`);
  }
  return { ok: true, value: null };
}

export type BuyerAnswer = {
  id: string;
  listingId: string;
  title: string;
  status: string;
  at: Date;
  sellerType: string;
  what: string;
  private: boolean;
  // Live or in contract, so the listing page opens. In review until the desk approves it.
  opens: boolean;
  inReview: boolean;
};

function describeListing(listing: { kind: string; notes: { upb: number }[] }) {
  const upb = listing.notes.reduce((sum, note) => sum + (note.upb || 0), 0);
  const size = upb > 0 ? `, ${moneyCompact(upb)} UPB` : "";
  return listing.kind === "POOL" ? `Pool of ${plural(listing.notes.length, "loan")}${size}` : `Single note${size}`;
}

const LISTING_FOR_BUYER = {
  id: true,
  title: true,
  kind: true,
  status: true,
  visibility: true,
  sellerId: true,
  brokerId: true,
  clientSellerName: true,
  stalePausedAt: true,
  seller: { select: { role: true, name: true, companyName: true, companyType: true } },
  notes: { select: { upb: true } },
} as const;

// The firm's requests, newest first, with the answers to each. An answer whose listing the buyer can no longer see
// (the seller revoked the invitation, or excludes them) isn't shown, as the book doesn't show it.
export async function buyerRequests(userId: string, now = new Date()) {
  const firm = await firmOf(userId);
  const rows = await prisma.buyerRequest.findMany({ where: { userId: firm }, orderBy: { createdAt: "desc" }, take: 100 });
  const ids = rows.map((row) => row.id);
  const responses = ids.length ? await prisma.requestResponse.findMany({ where: { requestId: { in: ids } }, orderBy: { createdAt: "desc" } }) : [];
  const listingIds = [...new Set(responses.map((row) => row.listingId))];
  const closedIds = rows.filter((row) => row.status === "CLOSED").map((row) => row.id);
  const [listings, closures, entities] = await Promise.all([
    listingIds.length ? prisma.listing.findMany({ where: { id: { in: listingIds } }, select: LISTING_FOR_BUYER }) : Promise.resolve([]),
    closedIds.length ? prisma.auditEvent.findMany({ where: { entityType: "buyerRequest", entityId: { in: closedIds }, action: DESK_CLOSED }, select: { entityId: true, detail: true } }) : Promise.resolve([]),
    prisma.buyerEntity.findMany({ where: { userId: firm, status: "APPROVED" }, select: { id: true, entityType: true } }),
  ]);
  const [access, profile] = await Promise.all([
    listingAccess({ id: firm, role: "BUYER" }),
    prisma.buyerProfile.findUnique({ where: { userId: firm }, select: { entityType: true } }),
  ]);
  const byId = new Map(listings.map((listing) => [listing.id, listing]));
  return rows.map((row) => {
    const live = isLive(row, now);
    const entityType = entities.find((entity) => entity.id === row.buyerEntityId)?.entityType ?? profile?.entityType ?? null;
    const answers: BuyerAnswer[] = responses.flatMap((response) => {
      const listing = response.requestId === row.id ? byId.get(response.listingId) : undefined;
      if (!listing || !canSee(access, listing)) return [];
      return [{
        id: response.id,
        listingId: listing.id,
        title: listing.title,
        status: response.status,
        at: response.createdAt,
        sellerType: sellerLabel(listing),
        what: describeListing(listing),
        private: isPrivateListing(listing),
        opens: listing.status === "APPROVED" || listing.status === "PENDING" || listing.status === "SOLD",
        inReview: listing.status === "SUBMITTED" || listing.status === "UNDER_REVIEW",
      }];
    });
    return {
      id: row.id,
      title: row.title,
      notes: row.notes,
      status: row.status,
      buyerEntityId: row.buyerEntityId,
      criteria: readCriteria(row.criteria),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      live,
      expired: row.status === "OPEN" && !live,
      buyerType: buyerTypeLabel(entityType),
      deskReason: closures.find((event) => event.entityId === row.id)?.detail ?? null,
      answers,
    };
  });
}

export async function buyerRequest(userId: string, requestId: string, now = new Date()) {
  return (await buyerRequests(userId, now)).find((row) => row.id === requestId) ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// The board sellers and brokers read. The buyer shows as the type of the entity the request is for, else the main
// file's. Never a name, an email, a firm or a vesting line.

const BUYER_TYPES: Record<string, string> = {
  FUND: "Fund",
  BANK: "Bank",
  CREDIT_UNION: "Credit union",
  TRUST: "Trust",
  IRA: "Private buyer (IRA)",
  LLC: "Private buyer",
  INDIVIDUAL: "Private buyer",
  OTHER: "Institution",
};

export function buyerTypeLabel(entityType: string | null | undefined) {
  return BUYER_TYPES[entityType ?? ""] ?? "Private buyer";
}

type Viewer = { id: string; role: string; accountStatus?: string };

// Approved sellers, institutional sellers and brokers, and the desk.
export function boardOpen(viewer: Viewer | null | undefined) {
  if (!viewer) return false;
  if (viewer.role === "ADMIN") return true;
  return SELLER_SIDE.includes(viewer.role) && viewer.accountStatus === "APPROVED";
}

export type BoardAnswer = { id: string; listingId: string; title: string; status: string; at: Date };
export type BoardRequest = {
  id: string;
  title: string;
  buyerType: string;
  track: string[];
  criteria: string[];
  notes: string;
  postedAt: Date;
  expiresAt: Date | null;
  // This viewer's own answers to it.
  answers: BoardAnswer[];
};

// Requests from qualifying buyers that the viewer's own exclusions don't hide. A seller who excludes a buyer never
// sees that buyer's requests, as that buyer never sees the seller's listings.
async function shownTo(viewer: Viewer, rows: BuyerRequest[], now: Date) {
  const standing = await standingOf(rows.map((row) => row.userId), now);
  let shown = rows.filter((row) => standing.get(row.userId)?.problem === null);
  if (viewer.role !== "ADMIN" && shown.length) {
    const exclusions = await prisma.sellerExclusion.findMany({ where: { sellerId: viewer.id }, select: { sellerId: true, buyerId: true, email: true, company: true } });
    if (exclusions.length) {
      const users = await prisma.user.findMany({ where: { id: { in: [...new Set(shown.map((row) => row.userId))] } }, select: { id: true, email: true, companyName: true } });
      const people = new Map((await peopleOf(users)).map((person) => [person.id, person]));
      shown = shown.filter((row) => {
        const person = people.get(row.userId);
        return Boolean(person) && !exclusions.some((exclusion) => excludes(exclusion, person!));
      });
    }
  }
  return { shown, standing };
}

// Each request's buyer type: its own approved buying entity's, else the main file's.
async function buyerTypes(rows: BuyerRequest[], standing: Map<string, Standing>) {
  const entityIds = [...new Set(rows.flatMap((row) => (row.buyerEntityId ? [row.buyerEntityId] : [])))];
  const entities = entityIds.length ? await prisma.buyerEntity.findMany({ where: { id: { in: entityIds }, status: "APPROVED" }, select: { id: true, userId: true, entityType: true } }) : [];
  return new Map(
    rows.map((row) => {
      const entity = entities.find((one) => one.id === row.buyerEntityId && one.userId === row.userId);
      return [row.id, buyerTypeLabel(entity?.entityType ?? standing.get(row.userId)?.entityType)];
    }),
  );
}

async function boardRows(viewer: Viewer, rows: BuyerRequest[], now: Date): Promise<BoardRequest[]> {
  const { shown, standing } = await shownTo(viewer, rows, now);
  if (!shown.length) return [];
  const [types, records, answers] = await Promise.all([
    buyerTypes(shown, standing),
    buyerTrackRecords(shown.map((row) => row.userId), now),
    prisma.requestResponse.findMany({ where: { requestId: { in: shown.map((row) => row.id) }, sellerId: viewer.id }, orderBy: { createdAt: "desc" } }),
  ]);
  const titles = answers.length ? await prisma.listing.findMany({ where: { id: { in: [...new Set(answers.map((row) => row.listingId))] } }, select: { id: true, title: true } }) : [];
  return shown.map((row) => {
    const record = records.get(row.userId);
    return {
      id: row.id,
      title: row.title,
      buyerType: types.get(row.id) ?? "Private buyer",
      track: record ? buyerRecordLines(record, "public") : [],
      criteria: criteriaLines(readCriteria(row.criteria)),
      notes: row.notes,
      postedAt: row.createdAt,
      expiresAt: row.expiresAt,
      answers: answers
        .filter((answer) => answer.requestId === row.id)
        .map((answer) => ({ id: answer.id, listingId: answer.listingId, title: titles.find((one) => one.id === answer.listingId)?.title ?? "A listing", status: answer.status, at: answer.createdAt })),
    };
  });
}

// Open, unexpired requests, newest first.
export async function requestBoard(viewer: Viewer, now = new Date()): Promise<BoardRequest[]> {
  if (!boardOpen(viewer)) return [];
  const rows = await prisma.buyerRequest.findMany({ where: liveWhere(now), orderBy: { createdAt: "desc" }, take: 200 });
  return boardRows(viewer, rows, now);
}

// One request as the board shows it, or null when it isn't open to this viewer.
export async function boardRequest(viewer: Viewer, requestId: string, now = new Date()) {
  if (!boardOpen(viewer)) return null;
  const row = await prisma.buyerRequest.findUnique({ where: { id: requestId } });
  if (!row || !isLive(row, now)) return null;
  return (await boardRows(viewer, [row], now))[0] ?? null;
}

export type AnswerChoice = { id: string; title: string; status: string; private: boolean; what: string; sent: boolean; paused: boolean };

// The viewer's own listings that can answer: filed and in review, or live. One already sent to this request is marked.
export async function answerChoices(viewer: { id: string }, requestId: string): Promise<AnswerChoice[]> {
  const [listings, sent] = await Promise.all([
    prisma.listing.findMany({
      where: { OR: [{ sellerId: viewer.id }, { brokerId: viewer.id }], status: { in: [...ANSWER_STATUSES] } },
      select: { id: true, title: true, kind: true, status: true, visibility: true, stalePausedAt: true, notes: { select: { upb: true } } },
      orderBy: { submittedAt: "desc" },
      take: 100,
    }),
    prisma.requestResponse.findMany({ where: { requestId }, select: { listingId: true } }),
  ]);
  const used = new Set(sent.map((row) => row.listingId));
  return listings.map((listing) => ({
    id: listing.id,
    title: listing.title,
    status: listing.status,
    private: isPrivateListing(listing),
    what: describeListing(listing),
    sent: used.has(listing.id),
    paused: stalePaused(listing),
  }));
}

function requestsLink(appUrl = process.env.NEXT_PUBLIC_APP_URL || "") {
  return `${appUrl}/buyer/requests`;
}

// The seller answers with one of its own listings, once per listing. A private listing is invited to the buyer's
// account, so it is on their book at once and on no one else's; a public one stays as it is. Either way the buyer
// hears, and the answer is on their requests page.
export async function answerRequest(actor: { id: string }, input: { requestId: string; listingId: string }, now = new Date()): Promise<Outcome<{ responseId: string; invited: boolean }>> {
  const account = await prisma.user.findUnique({ where: { id: actor.id }, select: { id: true, role: true, accountStatus: true } });
  if (!account || !boardOpen(account)) return fail("Answering requests is for approved sellers and brokers.");
  const request = await prisma.buyerRequest.findUnique({ where: { id: input.requestId } });
  // A request this seller's board doesn't show reads as closed, so an exclusion never shows through.
  const sight = request && isLive(request, now) ? await shownTo(account, [request], now) : null;
  if (!request || !sight?.shown.length) return fail(GONE);
  const listing = await prisma.listing.findUnique({
    where: { id: input.listingId },
    select: { id: true, title: true, kind: true, status: true, sellerId: true, brokerId: true, visibility: true, stalePausedAt: true, buyerLimit: true },
  });
  if (!listing || (listing.sellerId !== account.id && listing.brokerId !== account.id)) return fail("Choose one of your own listings.");
  if (!(ANSWER_STATUSES as readonly string[]).includes(listing.status)) return fail("Choose a listing that is live or in review.");
  if (stalePaused(listing)) return fail("That listing is paused until you reconfirm it is still for sale. Reconfirm it, then send it.");
  const already = await prisma.requestResponse.findFirst({ where: { requestId: request.id, listingId: listing.id }, select: { id: true } });
  if (already) return fail("That listing already went to this buyer for this request.");
  const buyer = await prisma.user.findUnique({ where: { id: request.userId }, select: { id: true, email: true, role: true, companyName: true } });
  if (!buyer) return fail(GONE);
  const reason = (await hiddenReasons(listing, [buyer])).get(buyer.id);
  if (reason === "excluded") return fail("That listing's seller excludes this buyer, so it can't go to them.");
  if (reason === "first_look") return fail("That listing is in its programme's first look, so it can't go to this buyer until the release.");
  if (regulatedOnly(listing) && !(await regulatedUserIds([buyer.id])).has(buyer.id)) return fail("That sale is open to banks and credit unions only, and this buyer isn't one.");
  const invited = reason === "private";
  if (invited) {
    const type = (await buyerTypes([request], sight.standing)).get(request.id) ?? "Private buyer";
    const token = randomBytes(24).toString("base64url");
    await prisma.listingInvite.create({
      data: { listingId: listing.id, email: `${REQUEST_INVITE} (${type})`, userId: buyer.id, token: inviteTokenHash(token), invitedById: account.id },
    });
    await audit(account.id, "LISTING_INVITE", "listing", listing.id, `Buyer request ${request.id}`);
    // Matches follow the new audience, quietly, as an invitation's do.
    const { rescoreListing } = await import("@/lib/matching");
    await rescoreListing(listing.id, false, now).catch(() => undefined);
  }
  const response = await prisma.requestResponse.create({ data: { requestId: request.id, listingId: listing.id, sellerId: account.id, status: "SENT" } });
  await audit(account.id, "REQUEST_ANSWERED", "buyerRequest", request.id, `${listing.title} (${listing.id})${invited ? " · invited privately" : ""}`);
  const review = listing.status === "APPROVED" ? "" : " It is in review at the desk, and opens to you once the desk approves it.";
  await notify(
    buyer.email,
    `Answer to your request · ${request.title}`,
    [
      `A seller answered your request "${request.title}" with ${invited ? "a private listing" : "a listing"}: ${listing.title}.${review}`,
      invited ? "It is private: only the buyers its seller invites see it, and you are invited." : "It is on the open book.",
      `See it with your request: ${requestsLink()}`,
    ].join("\n\n"),
  );
  return { ok: true, value: { responseId: response.id, invited } };
}

// ---------------------------------------------------------------------------------------------------------------
// The buyer's view and bid move the answer along. lib/listing-intel.ts calls the first on each view of a listing and
// lib/inquiry.ts the second on each bid. Neither does anything for a listing no one sent in answer to a request.

async function answersTo(listingId: string, userId: string, statuses: string[]) {
  const rows = await prisma.requestResponse.findMany({ where: { listingId, status: { in: statuses } }, select: { id: true, requestId: true } });
  if (!rows.length) return [];
  const firm = await firmOf(userId);
  const mine = await prisma.buyerRequest.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.requestId))] }, userId: firm }, select: { id: true } });
  const ids = new Set(mine.map((row) => row.id));
  return rows.filter((row) => ids.has(row.requestId)).map((row) => row.id);
}

export async function answerViewed(listingId: string, userId: string, now = new Date()) {
  const ids = await answersTo(listingId, userId, ["SENT"]);
  if (!ids.length) return 0;
  const moved = await prisma.requestResponse.updateMany({ where: { id: { in: ids }, status: "SENT" }, data: { status: "VIEWED" } });
  // The seller's audience list reads the invitation as opened, as a followed link would mark it.
  await prisma.listingInvite.updateMany({ where: { listingId, userId: await firmOf(userId), email: { startsWith: REQUEST_INVITE }, ...unset("openedAt") }, data: { openedAt: now } });
  return moved.count;
}

export async function answerBid(listingId: string, userId: string) {
  const ids = await answersTo(listingId, userId, ["SENT", "VIEWED", "DECLINED"]);
  if (!ids.length) return 0;
  return (await prisma.requestResponse.updateMany({ where: { id: { in: ids }, status: { not: "BID" } }, data: { status: "BID" } })).count;
}

// ---------------------------------------------------------------------------------------------------------------
// The desk: every request with its buyer named, every answer, and the counts. The desk closes a request with a reason
// the buyer reads, and the audit log keeps it.

const DESK_CLOSED = "BUYER_REQUEST_DESK_CLOSED";

export async function deskRequests(now = new Date()) {
  const live = liveWhere(now);
  const expired: Prisma.BuyerRequestWhereInput = { status: "OPEN", expiresAt: { lte: now } };
  const [open, paused, filled, closed, lapsed, sent, viewed, declined, bid, rows] = await Promise.all([
    prisma.buyerRequest.count({ where: live }),
    prisma.buyerRequest.count({ where: { status: "PAUSED" } }),
    prisma.buyerRequest.count({ where: { status: "FILLED" } }),
    prisma.buyerRequest.count({ where: { status: "CLOSED" } }),
    prisma.buyerRequest.count({ where: expired }),
    prisma.requestResponse.count({ where: { status: "SENT" } }),
    prisma.requestResponse.count({ where: { status: "VIEWED" } }),
    prisma.requestResponse.count({ where: { status: "DECLINED" } }),
    prisma.requestResponse.count({ where: { status: "BID" } }),
    prisma.buyerRequest.findMany({ orderBy: { createdAt: "desc" }, take: 300 }),
  ]);
  const ids = rows.map((row) => row.id);
  const responses = ids.length ? await prisma.requestResponse.findMany({ where: { requestId: { in: ids } }, orderBy: { createdAt: "desc" } }) : [];
  const userIds = [...new Set([...rows.map((row) => row.userId), ...responses.map((row) => row.sellerId)])];
  const [users, listings, closures, entities, profiles] = await Promise.all([
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true, companyName: true } }) : Promise.resolve([]),
    responses.length ? prisma.listing.findMany({ where: { id: { in: [...new Set(responses.map((row) => row.listingId))] } }, select: { id: true, title: true, visibility: true } }) : Promise.resolve([]),
    ids.length ? prisma.auditEvent.findMany({ where: { entityType: "buyerRequest", entityId: { in: ids }, action: DESK_CLOSED }, select: { entityId: true, detail: true, createdAt: true } }) : Promise.resolve([]),
    prisma.buyerEntity.findMany({ where: { id: { in: rows.flatMap((row) => (row.buyerEntityId ? [row.buyerEntityId] : [])) } }, select: { id: true, name: true, entityType: true } }),
    prisma.buyerProfile.findMany({ where: { userId: { in: rows.map((row) => row.userId) } }, select: { userId: true, entityType: true } }),
  ]);
  const user = (id: string) => users.find((one) => one.id === id);
  const counts = { open, paused, filled, closed, expired: lapsed, answers: { SENT: sent, VIEWED: viewed, DECLINED: declined, BID: bid } };
  const requests = rows.map((row) => {
    const buyer = user(row.userId);
    const entity = entities.find((one) => one.id === row.buyerEntityId);
    return {
      id: row.id,
      title: row.title,
      notes: row.notes,
      status: row.status,
      live: isLive(row, now),
      expired: row.status === "OPEN" && !isLive(row, now),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      criteria: criteriaLines(readCriteria(row.criteria)),
      buyer: { name: buyer?.name ?? "Account removed", email: buyer?.email ?? "", company: buyer?.companyName ?? "", entity: entity?.name ?? null },
      buyerType: buyerTypeLabel(entity?.entityType ?? profiles.find((one) => one.userId === row.userId)?.entityType),
      deskClosed: closures.find((event) => event.entityId === row.id) ?? null,
      answers: responses
        .filter((response) => response.requestId === row.id)
        .map((response) => {
          const listing = listings.find((one) => one.id === response.listingId);
          return {
            id: response.id,
            listingId: response.listingId,
            title: listing?.title ?? "Listing removed",
            private: listing ? isPrivateListing(listing) : false,
            seller: user(response.sellerId)?.companyName || user(response.sellerId)?.name || "Account removed",
            status: response.status,
            at: response.createdAt,
          };
        }),
    };
  });
  return { counts, requests };
}

export async function deskCloseRequest(actor: { id: string }, input: { requestId: string; reason: unknown }): Promise<Outcome<null>> {
  const reason = oneLine(input.reason).slice(0, REASON_MAX);
  if (reason.length < 3) return fail("Say why the desk is closing it. The buyer reads the reason.");
  const request = await prisma.buyerRequest.findUnique({ where: { id: input.requestId } });
  if (!request) return fail("That request isn't there.");
  if (request.status !== "OPEN" && request.status !== "PAUSED") return fail("That request is filled or closed already.");
  const moved = await prisma.buyerRequest.updateMany({ where: { id: request.id, status: request.status }, data: { status: "CLOSED" } });
  if (moved.count !== 1) return fail("That request changed a moment ago. Look again.");
  await audit(actor.id, DESK_CLOSED, "buyerRequest", request.id, reason);
  const buyer = await prisma.user.findUnique({ where: { id: request.userId }, select: { email: true } });
  if (buyer) {
    await notify(
      buyer.email,
      `Request closed · ${request.title}`,
      `The desk closed your request "${request.title}". The reason: ${reason}\n\nListings already sent to you stay on your requests page. Write to the desk with any question.`,
    );
  }
  return { ok: true, value: null };
}

// ---------------------------------------------------------------------------------------------------------------
// The public teaser on /buying: how many open requests take each lien and each performance, as lib/demand-board.ts
// counts buy boxes. No title, criteria, price or buyer. A cell from fewer than MIN_FIRMS distinct firms is withheld, so
// no count points at one buyer, or at two who could each subtract themselves.

export type CountedRequest = { firm: string; liens: string[]; statuses: string[] };
export type RequestCell = { value: string; label: string; requests: number | null };
export type RequestCounts = { total: number | null; liens: RequestCell[]; statuses: RequestCell[] };

export function requestCounts(rows: CountedRequest[]): RequestCounts {
  const cell = (subset: CountedRequest[]) => (new Set(subset.map((row) => row.firm)).size >= MIN_FIRMS ? subset.length : null);
  // A request with no lien or performance named takes any, so it counts in each.
  const takes = (list: string[], value: string) => !list.length || list.includes(value);
  return {
    total: cell(rows),
    liens: LIEN_POSITIONS.map((lien) => ({ value: lien.value, label: lien.label, requests: cell(rows.filter((row) => takes(row.liens, lien.value))) })),
    statuses: PAYMENT_STATUSES.map((status) => ({ value: status.value, label: status.label, requests: cell(rows.filter((row) => takes(row.statuses, status.value))) })),
  };
}

export async function publicRequestCounts(now = new Date()) {
  const rows = await prisma.buyerRequest.findMany({ where: liveWhere(now), select: { userId: true, criteria: true } });
  const standing = await standingOf(rows.map((row) => row.userId), now);
  return requestCounts(
    rows
      .filter((row) => standing.get(row.userId)?.problem === null)
      .map((row) => {
        const criteria = readCriteria(row.criteria);
        return { firm: row.userId, liens: criteria.liens, statuses: criteria.statuses };
      }),
  );
}
