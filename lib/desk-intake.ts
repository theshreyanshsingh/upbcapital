import { audit } from "@/lib/audit";
import { toCsv } from "@/lib/csv";
import { unset } from "@/lib/db-filters";
import { flagDuplicates } from "@/lib/duplicates";
import { notify, notifyDesk } from "@/lib/email";
import { money } from "@/lib/format";
import { labelOf } from "@/lib/labels";
import type { Outcome } from "@/lib/loan-file";
import { rescoreListing } from "@/lib/matching";
import { typedNumber } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { screenInBackground, screenListing } from "@/lib/screening";
import { deskCan, DESK_DENIED, type Staff } from "@/lib/staff";
import { putBytes, safeBasename } from "@/lib/storage";
import { readTapeDraft } from "@/lib/tape-draft";
import { normalizeTapeRows, parseTapeBuffer, type NormalizedLoan, type TapeError } from "@/lib/tape";
import { suggestMapping, TAPE_FIELDS, type TapeFieldKey } from "@/lib/tape-fields";
import { flagSummary, reviewTape } from "@/lib/tape-quality";

// Desk intake: a bank or a fund sends its tape, and the desk files it for them. The desk reads the tape with the
// same parser and quality checks a seller's upload gets, splits it into pools when the seller wants that, and files
// one listing per pool in the seller's name. The seller then confirms on each listing that the tape is theirs and
// correct, and the desk can't approve a listing it filed until they do. Every other gate still applies.

// The same limits as a tape a seller uploads.
export const MAX_INTAKE_BYTES = 10 * 1024 * 1024;
const MAX_LOANS = 2000;
// A split by state and band can run to hundreds of tiny pools. More than this is a mistake in the rules.
export const MAX_POOLS = 40;

export const SPLIT_RULES = [
  { value: "STATE", label: "State" },
  { value: "LIEN", label: "Lien position" },
  { value: "PERFORMANCE", label: "Performing or not" },
  { value: "BALANCE", label: "Balance band" },
] as const;

export type SplitRule = (typeof SPLIT_RULES)[number]["value"];
export type PriceMode = "COLUMN" | "PERCENT";
export type SplitPlan = { rules: SplitRule[]; bands: number[] };

export function isSplitRule(value: unknown): value is SplitRule {
  return typeof value === "string" && SPLIT_RULES.some((rule) => rule.value === value);
}

// "100k, 250k" or "100000 250000": the UPB edges between bands, lowest first. Null when a value can't be read.
export function parseBands(raw: string): number[] | null {
  const parts = raw.split(/[,;\s]+/).filter(Boolean);
  const edges: number[] = [];
  for (const part of parts) {
    const value = typedNumber(part);
    if (!Number.isFinite(value) || value <= 0) return null;
    edges.push(Math.round(value));
  }
  const sorted = [...new Set(edges)].sort((a, b) => a - b);
  return sorted.length > 6 ? null : sorted;
}

export function bandLabel(index: number, bands: number[]) {
  if (!bands.length) return "Any balance";
  if (index === 0) return `Under ${money(bands[0])}`;
  if (index >= bands.length) return `${money(bands[bands.length - 1])} and over`;
  return `${money(bands[index - 1])} to ${money(bands[index])}`;
}

function bandOf(upb: number, bands: number[]) {
  return bands.filter((edge) => upb >= edge).length;
}

const LIEN_ORDER = ["FIRST", "SECOND", "THIRD", "OTHER"];
const STATUS_ORDER = ["PERFORMING", "SUB_PERFORMING", "NON_PERFORMING"];

type Splittable = { state: string; lienPosition: string; paymentStatus: string; upb: number };
export type IntakePool<T> = { key: string; label: string; loans: T[]; upb: number };

// One pool per combination of the chosen rules, in a stable order: state A to Z, first liens before seconds,
// performing before non-performing, smaller balances first. No rules is one pool.
export function splitIntoPools<T extends Splittable>(loans: T[], plan: SplitPlan): IntakePool<T>[] {
  const rules = SPLIT_RULES.map((rule) => rule.value).filter((rule) => plan.rules.includes(rule));
  const pools = new Map<string, IntakePool<T> & { sort: (string | number)[] }>();
  for (const loan of loans) {
    const parts = rules.map((rule) => {
      if (rule === "STATE") return { key: loan.state, label: loan.state, sort: loan.state };
      if (rule === "LIEN") return { key: loan.lienPosition, label: `${labelOf("lien", loan.lienPosition)} lien`, sort: LIEN_ORDER.indexOf(loan.lienPosition) };
      if (rule === "PERFORMANCE") return { key: loan.paymentStatus, label: labelOf("payment", loan.paymentStatus), sort: STATUS_ORDER.indexOf(loan.paymentStatus) };
      const band = bandOf(loan.upb, plan.bands);
      return { key: `B${band}`, label: bandLabel(band, plan.bands), sort: band };
    });
    const key = parts.map((part) => part.key).join("|") || "all";
    const pool = pools.get(key) ?? { key, label: parts.map((part) => part.label).join(" · "), loans: [], upb: 0, sort: parts.map((part) => part.sort) };
    pool.loans.push(loan);
    pool.upb += loan.upb;
    pools.set(key, pool);
  }
  const compare = (a: (string | number)[], b: (string | number)[]) => {
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] === b[index]) continue;
      return typeof a[index] === "number" ? (a[index] as number) - (b[index] as number) : String(a[index]).localeCompare(String(b[index]));
    }
    return 0;
  };
  return [...pools.values()].sort((a, b) => compare(a.sort, b.sort)).map((pool) => ({ key: pool.key, label: pool.label, loans: pool.loans, upb: Math.round(pool.upb * 100) / 100 }));
}

export function poolTitle(prefix: string, label: string) {
  return (label ? `${prefix} · ${label}` : prefix).slice(0, 140);
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the tape

export type IntakeTape = {
  loans: NormalizedLoan[];
  // The source row behind each loan, in the same order, so each pool's own rows go in its data room.
  rows: Record<string, string>[];
  headers: string[];
  errors: TapeError[];
  quality: ReturnType<typeof flagSummary>;
  columns: { field: string; header: string }[];
  unused: string[];
};

const fail = (error: string): Outcome<never> => ({ ok: false, error });

function priceProblem(priceMode: PriceMode, percent: number | undefined) {
  if (priceMode === "PERCENT" && !(percent != null && Number.isFinite(percent) && percent > 0 && percent <= 150)) return "Enter a price between 1% and 150% of UPB.";
  return null;
}

// The header aliases cover the servicers' own exports too, so an FCI or BSI file reads here as it would in the
// servicer import.
export function readIntakeTape(input: { filename: string; bytes: Buffer; priceMode: PriceMode; percent?: number; now?: Date }): Outcome<IntakeTape> {
  const price = priceProblem(input.priceMode, input.percent);
  if (price) return fail(price);
  let matrix: ReturnType<typeof parseTapeBuffer>;
  try {
    matrix = parseTapeBuffer(input.bytes, input.filename);
  } catch {
    return fail("That file could not be read.");
  }
  if (!matrix.headers.length) return fail("The tape has no header row.");
  const mapping = suggestMapping(matrix.headers);
  const { loans, errors } = normalizeTapeRows({ rows: matrix.rows, mapping, priceMode: input.priceMode, pricePercent: input.percent });
  // The rows the parser kept: any with a city, a street or a balance. With no row errors they line up with the loans.
  const kept = (["city", "streetAddress", "upb"] as TapeFieldKey[]).map((key) => mapping[key]).filter((header): header is string => Boolean(header));
  const rows = matrix.rows.filter((row) => kept.some((header) => (row[header] ?? "").trim()));
  const labels = new Map<string, string>(TAPE_FIELDS.map((field) => [field.key, field.label]));
  const columns = Object.entries(mapping)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([field, header]) => ({ field: labels.get(field) ?? field, header }));
  const used = new Set(columns.map((column) => column.header));
  return {
    ok: true,
    value: {
      loans,
      rows: errors.length || rows.length !== loans.length ? [] : rows,
      headers: matrix.headers,
      errors,
      quality: flagSummary(reviewTape(matrix.rows, mapping, input.now)),
      columns,
      unused: matrix.headers.filter((header) => !used.has(header)),
    },
  };
}

export function errorText(errors: TapeError[]) {
  return errors.slice(0, 4).map((issue) => (issue.row ? `Row ${issue.row}: ${issue.message}.` : issue.message)).join(" ");
}

// ---------------------------------------------------------------------------------------------------------------
// The seller

const SELLER_ROLES = new Set(["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER"]);

export async function intakeSellers() {
  const sellers = await prisma.user.findMany({
    where: { role: { in: ["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER"] }, accountStatus: "APPROVED" },
    select: { id: true, name: true, companyName: true, email: true, deletedAt: true },
    orderBy: [{ companyName: "asc" }, { name: "asc" }],
    take: 500,
  });
  return sellers.filter((seller) => !seller.deletedAt);
}

async function intakeSeller(sellerId: string) {
  const seller = sellerId ? await prisma.user.findUnique({ where: { id: sellerId }, select: { id: true, name: true, companyName: true, email: true, role: true, accountStatus: true, deletedAt: true } }) : null;
  if (!seller || !SELLER_ROLES.has(seller.role) || seller.deletedAt) return fail("Choose the seller's account.");
  if (seller.accountStatus !== "APPROVED") return fail("That seller's account isn't approved yet.");
  return { ok: true as const, value: seller };
}

// ---------------------------------------------------------------------------------------------------------------
// The staged preview: the file waits as a tape draft, and a cookie names it with the desk's choices, so the page
// shows the preview on its next render.

export const INTAKE_COOKIE = "upb-desk-intake";

export type StagedIntake = { token: string; sellerId: string; priceMode: PriceMode; percent: number | null; rules: SplitRule[]; bands: number[] };

export function intakeCookieValue(staged: StagedIntake) {
  return Buffer.from(JSON.stringify(staged)).toString("base64url");
}

export function readIntakeCookie(value: string | null | undefined): StagedIntake | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof raw.token !== "string" || !/^[0-9a-f-]{36}$/i.test(raw.token)) return null;
    if (typeof raw.sellerId !== "string" || !/^[a-z0-9]{10,40}$/i.test(raw.sellerId)) return null;
    if (raw.priceMode !== "COLUMN" && raw.priceMode !== "PERCENT") return null;
    const percent = typeof raw.percent === "number" && Number.isFinite(raw.percent) ? raw.percent : null;
    const rules = Array.isArray(raw.rules) ? raw.rules.filter(isSplitRule) : [];
    const bands = Array.isArray(raw.bands) ? raw.bands.filter((edge): edge is number => typeof edge === "number" && Number.isFinite(edge) && edge > 0).slice(0, 6) : [];
    return { token: raw.token, sellerId: raw.sellerId, priceMode: raw.priceMode, percent, rules, bands };
  } catch {
    return null;
  }
}

export function planProblem(plan: SplitPlan) {
  if (plan.rules.includes("BALANCE") && !plan.bands.length) return "Enter the balance edges for the bands, such as 100k, 250k.";
  return null;
}

export type IntakePreview = {
  token: string;
  filename: string;
  seller: { id: string; name: string; companyName: string; email: string };
  staged: StagedIntake;
  tape: IntakeTape;
  pools: IntakePool<NormalizedLoan>[];
  problem: string | null;
};

export async function stagedIntake(viewerId: string, staged: StagedIntake): Promise<IntakePreview | null> {
  const draft = viewerId ? await readTapeDraft(viewerId, staged.token) : null;
  if (!draft) return null;
  const seller = await intakeSeller(staged.sellerId);
  const tape = readIntakeTape({ filename: draft.filename, bytes: draft.bytes, priceMode: staged.priceMode, percent: staged.percent ?? undefined });
  if (!seller.ok || !tape.ok) return null;
  const pools = splitIntoPools(tape.value.loans, staged);
  const problem = tape.value.errors.length
    ? errorText(tape.value.errors)
    : !tape.value.loans.length ? "The tape had no loans."
    : tape.value.loans.length > MAX_LOANS ? "Tapes are limited to 2,000 loans in this desk."
    : pools.length > MAX_POOLS ? `That split makes ${pools.length} pools. Use fewer rules or wider bands, up to ${MAX_POOLS}.`
    : null;
  return { token: staged.token, filename: draft.filename, seller: seller.value, staged, tape: tape.value, pools, problem };
}

// ---------------------------------------------------------------------------------------------------------------
// Filing

export type FiledPool = { id: string; title: string; loans: number; upb: number };

export async function fileDeskIntake(
  actor: Staff & { id: string },
  input: {
    sellerId: string;
    filename: string;
    bytes: Buffer;
    priceMode: PriceMode;
    percent?: number | null;
    rules: SplitRule[];
    bands: number[];
    title: string;
    summary?: string;
    // Screens run after the response by default, as they do for a seller's upload. Tests wait for them.
    background?: boolean;
  },
): Promise<Outcome<FiledPool[]>> {
  if (actor.role !== "ADMIN" || !deskCan(actor, "sales")) return fail(DESK_DENIED);
  const prefix = input.title.replace(/\s+/g, " ").trim().slice(0, 100);
  if (prefix.length < 3) return fail("Name the pool.");
  const summary = (input.summary ?? "").trim().slice(0, 2000);
  if (input.bytes.length > MAX_INTAKE_BYTES) return fail("Tapes are limited to 10 MB.");
  const plan = { rules: input.rules.filter(isSplitRule), bands: input.bands };
  const problem = planProblem(plan);
  if (problem) return fail(problem);
  const seller = await intakeSeller(input.sellerId);
  if (!seller.ok) return seller;
  const read = readIntakeTape({ filename: input.filename, bytes: input.bytes, priceMode: input.priceMode, percent: input.percent ?? undefined });
  if (!read.ok) return read;
  const tape = read.value;
  if (tape.errors.length) return fail(errorText(tape.errors));
  if (!tape.loans.length) return fail("The tape had no loans.");
  if (tape.loans.length > MAX_LOANS) return fail("Tapes are limited to 2,000 loans in this desk.");
  if (tape.rows.length !== tape.loans.length) return fail("The tape's rows couldn't be matched to its loans. Export it again as a plain CSV.");
  // Each loan keeps its source row, so a pool's data room holds its own rows and never another pool's.
  const items = tape.loans.map((loan, index) => ({ loan, source: tape.rows[index], state: loan.state, lienPosition: loan.lienPosition, paymentStatus: loan.paymentStatus, upb: loan.upb }));
  const pools = splitIntoPools(items, plan);
  if (pools.length > MAX_POOLS) return fail(`That split makes ${pools.length} pools. Use fewer rules or wider bands, up to ${MAX_POOLS}.`);

  const filed: FiledPool[] = [];
  for (const pool of pools) {
    const title = poolTitle(prefix, pool.label);
    const loans = pool.loans.map((item) => item.loan);
    const listing = await prisma.listing.create({
      data: {
        kind: loans.length === 1 ? "SINGLE" : "POOL",
        sellerId: seller.value.id,
        status: "SUBMITTED",
        title,
        summary: summary || `Filed by the desk from ${seller.value.companyName || seller.value.name}'s tape.`,
        filedByDeskId: actor.id,
        notes: { create: loans },
      },
    });
    const csv = Buffer.from(toCsv(pool.loans.map((loan) => loan.source)));
    const originalName = `${title}.csv`.slice(0, 180);
    const storedName = `${crypto.randomUUID()}-${safeBasename(originalName)}`;
    await putBytes(storedName, csv, "text/csv");
    await prisma.document.create({ data: { listingId: listing.id, type: "TAPE", originalName, storedName, mime: "text/csv", size: csv.length } });
    await audit(actor.id, "DESK_INTAKE", "listing", listing.id, `${loans.length} loans filed for seller ${seller.value.id} · pool ${filed.length + 1} of ${pools.length}`);
    await flagDuplicates(listing.id, actor.id);
    if (input.background === false) await screenListing(listing.id, actor.id);
    else screenInBackground(() => screenListing(listing.id, actor.id));
    await rescoreListing(listing.id, false);
    filed.push({ id: listing.id, title, loans: loans.length, upb: pool.upb });
  }

  const app = process.env.NEXT_PUBLIC_APP_URL || "";
  const lines = filed.map((pool) => `${pool.title} · ${pool.loans === 1 ? "1 loan" : `${pool.loans} loans`} · ${app}/seller/listings/${pool.id}`);
  await notify(
    seller.value.email,
    `Tape filed for you · ${prefix}`,
    `The UPB Capital desk filed your tape as ${filed.length === 1 ? "one listing" : `${filed.length} listings`}:\n\n${lines.join("\n")}\n\nOpen each listing and check the loans. Confirm that the tape is yours and correct, or ask for changes. The desk can't approve a listing until you confirm it, and buyers see nothing before then.`,
  );
  return { ok: true, value: filed };
}

// ---------------------------------------------------------------------------------------------------------------
// The seller's confirmation, and the gate on the desk's approval

export const SELLER_CONFIRM_HOLD = "The desk filed this tape for the seller. Approval waits until the seller confirms on their listing page that the tape is theirs and correct.";

export function deskIntakeHold(listing: { filedByDeskId?: string | null; sellerConfirmedAt?: Date | null }) {
  return listing.filedByDeskId && !listing.sellerConfirmedAt ? SELLER_CONFIRM_HOLD : null;
}

const CONFIRMABLE = ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED"] as const;

async function ownDeskFiled(user: { id: string }, listingId: string) {
  const listing = listingId
    ? await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, title: true, sellerId: true, status: true, filedByDeskId: true, sellerConfirmedAt: true, seller: { select: { name: true, companyName: true } } } })
    : null;
  if (!listing || !user.id || listing.sellerId !== user.id) return fail("That listing isn't yours.");
  if (!listing.filedByDeskId) return fail("You filed this listing yourself, so there is nothing to confirm.");
  if (listing.sellerConfirmedAt) return fail("You already confirmed this tape.");
  if (!(CONFIRMABLE as readonly string[]).includes(listing.status)) return fail("This listing is no longer in review.");
  return { ok: true as const, value: listing };
}

export async function confirmDeskTape(user: { id: string }, listingId: string, now = new Date()): Promise<Outcome<{ title: string }>> {
  const own = await ownDeskFiled(user, listingId);
  if (!own.ok) return own;
  const listing = own.value;
  const moved = await prisma.listing.updateMany({
    where: { id: listing.id, sellerId: user.id, status: { in: [...CONFIRMABLE] }, ...unset("sellerConfirmedAt") },
    data: { sellerConfirmedAt: now, sellerConfirmedById: user.id },
  });
  if (moved.count !== 1) return fail("The listing changed a moment ago. Reload and try again.");
  await audit(user.id, "DESK_INTAKE_CONFIRMED", "listing", listing.id, "The seller confirmed the tape the desk filed");
  await notifyDesk(`Seller confirmed the tape · ${listing.title}`, `${listing.seller.companyName || listing.seller.name} confirmed the tape the desk filed is theirs and correct. The listing can be approved once its other checks pass.`, { capability: "sales" });
  return { ok: true, value: { title: listing.title } };
}

export async function askTapeChanges(user: { id: string }, listingId: string, message: string): Promise<Outcome<{ title: string }>> {
  const own = await ownDeskFiled(user, listingId);
  if (!own.ok) return own;
  const text = message.replace(/[ \t]+/g, " ").trim().slice(0, 1000);
  if (text.length < 3) return fail("Say what should change.");
  const listing = own.value;
  const app = process.env.NEXT_PUBLIC_APP_URL || "";
  await notifyDesk(
    `Seller asks for changes · ${listing.title}`,
    `${listing.seller.companyName || listing.seller.name} asked for changes to the tape the desk filed:\n\n${text}\n\nThe listing stays unconfirmed. ${app}/admin/listings/${listing.id}`,
    { capability: "sales" },
  );
  // The message can name loans, so the audit trail keeps the fact and not the words.
  await audit(user.id, "DESK_INTAKE_CHANGES", "listing", listing.id, "The seller asked for changes to the tape the desk filed");
  return { ok: true, value: { title: listing.title } };
}

// The seller confirmed the tape as it stood, not as the desk later changed it. A desk change to a confirmed,
// desk-filed tape before approval clears the confirmation, so the approval gate holds until the seller looks again.
export const RECONFIRM_LINE = "You had confirmed this tape, so your confirmation is cleared. Open the listing, check the new figures and confirm the tape again. The desk can't approve it until you do.";

export async function clearSellerConfirmation(actorId: string, listingId: string, what: string) {
  const cleared = await prisma.listing.updateMany({
    where: { id: listingId, filedByDeskId: { not: null }, sellerConfirmedAt: { not: null }, status: { in: [...CONFIRMABLE] } },
    data: { sellerConfirmedAt: null, sellerConfirmedById: null },
  });
  if (cleared.count !== 1) return false;
  await audit(actorId, "DESK_INTAKE_UNCONFIRMED", "listing", listingId, `Seller confirmation cleared after a desk change: ${what}`);
  return true;
}

// For a desk path with no seller notice of its own: clears the confirmation and tells the seller what changed.
export async function reopenDeskTape(actorId: string, listingId: string, what: string) {
  if (!(await clearSellerConfirmation(actorId, listingId, what))) return false;
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { title: true, seller: { select: { email: true } } } });
  if (listing) await notify(listing.seller.email, `Confirm your tape again · ${listing.title}`, `The desk changed ${what} on the tape it filed for you. ${RECONFIRM_LINE}`);
  return true;
}

// For launch readiness: desk-filed listings in review that wait on the seller.
export async function deskFiledWaiting() {
  return prisma.listing.count({ where: { filedByDeskId: { not: null }, status: { in: [...CONFIRMABLE] }, ...unset("sellerConfirmedAt") } });
}
