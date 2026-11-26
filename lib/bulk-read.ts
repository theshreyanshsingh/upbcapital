import {
  Prisma,
  type AuditEvent,
  type Closing,
  type CollateralItem,
  type Document,
  type Favorite,
  type Inquiry,
  type Listing,
  type ListingMatch,
  type ListingQuestion,
  type ListingView,
  type NdaAcknowledgment,
  type Note,
  type OfacCheck,
  type OfferMessage,
  type ReviewComment,
  type User,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Prisma's MongoDB connector sends `field: { in: ids }` as one $eq per id inside $expr, which no index serves, so a
// read by a few thousand ids compares every document with every id. An include builds that same query for its
// children and then joins them in the engine. At a few thousand listings the home page and the book ran past a
// minute (stress test, November 2026). These reads send MongoDB a plain $in, which the field's index serves, and
// rebuild each row as Prisma returns it: every scalar present, a missing optional field null, dates as Dates.

// A User read names its fields with `pick`: the row carries the password hash and second-factor secret.
type Rows = {
  Note: Note;
  Listing: Listing;
  Inquiry: Inquiry;
  Favorite: Favorite;
  User: User;
  Closing: Closing;
  ReviewComment: ReviewComment;
  OfferMessage: OfferMessage;
  ListingView: ListingView;
  NdaAcknowledgment: NdaAcknowledgment;
  ListingQuestion: ListingQuestion;
  AuditEvent: AuditEvent;
  ListingMatch: ListingMatch;
  OfacCheck: OfacCheck;
  Document: Document;
  CollateralItem: CollateralItem;
};
type ModelName = keyof Rows;
type Field = { name: string; dbName: string; type: string; list: boolean; fallback: unknown };

const DELEGATES: Record<ModelName, { findRaw: (args: { filter: Prisma.InputJsonObject; options?: Prisma.InputJsonObject }) => Promise<Prisma.JsonObject | Prisma.JsonArray> }> = {
  Note: prisma.note,
  Listing: prisma.listing,
  Inquiry: prisma.inquiry,
  Favorite: prisma.favorite,
  User: prisma.user,
  Closing: prisma.closing,
  ReviewComment: prisma.reviewComment,
  OfferMessage: prisma.offerMessage,
  ListingView: prisma.listingView,
  NdaAcknowledgment: prisma.ndaAcknowledgment,
  ListingQuestion: prisma.listingQuestion,
  AuditEvent: prisma.auditEvent,
  ListingMatch: prisma.listingMatch,
  OfacCheck: prisma.ofacCheck,
  Document: prisma.document,
  CollateralItem: prisma.collateralItem,
};

// Ids go to MongoDB in slices, so one read never nears its 16MB command limit.
const SLICE = 5000;
const fieldCache = new Map<ModelName, Field[]>();

function scalarFields(model: ModelName): Field[] {
  const cached = fieldCache.get(model);
  if (cached) return cached;
  const found = Prisma.dmmf.datamodel.models.find((entry) => entry.name === model);
  if (!found) throw new Error(`Unknown model ${model}`);
  const fields = found.fields
    .filter((field) => field.kind === "scalar" || field.kind === "enum")
    .map((field) => {
      const literal = field.default !== undefined && (typeof field.default !== "object" || field.default === null || Array.isArray(field.default));
      return { name: field.name, dbName: field.dbName ?? field.name, type: field.type, list: field.isList, fallback: field.isList ? [] : literal ? field.default : null };
    });
  fieldCache.set(model, fields);
  return fields;
}

function wrapped(value: object, key: string) {
  return key in value ? (value as Record<string, unknown>)[key] : undefined;
}

// Prisma hands back raw documents in MongoDB's extended JSON: {$date}, {$oid}, {$numberLong} and the like.
export function revive(value: unknown, type?: string): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => revive(entry, type));
  if (typeof value !== "object") {
    if (type === "DateTime" && typeof value === "string") return new Date(value);
    return value;
  }
  const date = wrapped(value, "$date");
  if (date !== undefined) {
    const inner = typeof date === "object" && date !== null ? wrapped(date, "$numberLong") : date;
    return new Date(typeof inner === "string" && /^\d+$/.test(inner) ? Number(inner) : (inner as string | number));
  }
  const oid = wrapped(value, "$oid");
  if (oid !== undefined) return String(oid);
  for (const key of ["$numberLong", "$numberInt", "$numberDouble", "$numberDecimal"]) {
    const number = wrapped(value, key);
    if (number !== undefined) return Number(number);
  }
  if (type === "Json") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = revive(entry);
  return out;
}

function rebuild(doc: Record<string, unknown>, fields: Field[]) {
  const row: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = doc[field.dbName];
    row[field.name] = raw === undefined ? field.fallback : revive(raw, field.type);
  }
  return row;
}

// Rows whose `field` is one of `values`, every scalar field filled, or only `pick` when given, in id order: for ids
// Prisma made, the order they were written in, as an include without orderBy gives them.
// Extra plain-MongoDB conditions go in `where`, written in the database's own field names, with dates as
// { $date: ISO string } (mongoDate).
export async function readIn<M extends ModelName, K extends keyof Rows[M] & string = keyof Rows[M] & string>(
  model: M,
  field: keyof Rows[M] & string,
  values: readonly string[],
  options: { pick?: readonly K[]; where?: Prisma.InputJsonObject } = {},
): Promise<Pick<Rows[M], K>[]> {
  const unique = [...new Set(values)];
  if (!unique.length) return [];
  const all = scalarFields(model);
  const byName = new Map(all.map((entry) => [entry.name, entry]));
  const target = byName.get(field);
  if (!target) throw new Error(`${model} has no field ${field}`);
  const fields = options.pick ? options.pick.map((name) => byName.get(name)).filter((entry): entry is Field => Boolean(entry)) : all;
  const projection = options.pick ? Object.fromEntries(fields.map((entry) => [entry.dbName, 1])) : undefined;
  const docs: Record<string, unknown>[] = [];
  for (let start = 0; start < unique.length; start += SLICE) {
    const slice = unique.slice(start, start + SLICE);
    // Sorted by _id, so the order doesn't hang on which index the planner picks: an $in read by index comes back
    // grouped by value, a scan in stored order, and a figure that takes the first of a tie would move between reads.
    const found = (await DELEGATES[model].findRaw({
      filter: { ...(options.where ?? {}), [target.dbName]: { $in: slice } },
      options: { sort: { _id: 1 }, ...(projection ? { projection } : {}) },
    })) as unknown as Record<string, unknown>[];
    docs.push(...found);
  }
  // Each slice comes back in id order; more than one is put in order together.
  if (unique.length > SLICE) docs.sort((a, b) => (String(revive(a._id)) < String(revive(b._id)) ? -1 : 1));
  return docs.map((doc) => rebuild(doc, fields) as Pick<Rows[M], K>);
}

// A date as a raw MongoDB filter takes it.
export function mongoDate(date: Date) {
  return { $date: date.toISOString() };
}

// Rows grouped by one of their fields, in their read order.
export function groupBy<T, K extends keyof T>(rows: readonly T[], key: K): Map<T[K], T[]> {
  const groups = new Map<T[K], T[]>();
  for (const row of rows) {
    const list = groups.get(row[key]);
    if (list) list.push(row);
    else groups.set(row[key], [row]);
  }
  return groups;
}

// Each listing's loans, as `include: { notes: true }` gives them, or oldest first with `oldestFirst`, as
// `include: { notes: { orderBy: { createdAt: "asc" } } }` does. `shared` is for the book, the home page and the
// buyer API, which read every live listing's loans on each request: in production they share one read of the book's
// loans for a few seconds (bookLoans). The listing page, bids and awards read fresh.
export async function withNotes<L extends { id: string }>(
  listings: readonly L[],
  options: { oldestFirst?: boolean; shared?: boolean } = {},
): Promise<(L & { notes: Note[] })[]> {
  const ids = listings.map((listing) => listing.id);
  const grouped = options.shared && process.env.NODE_ENV === "production" ? await bookLoans(ids) : groupBy(await readIn("Note", "listingId", ids), "listingId");
  const order = (notes: Note[]) => (options.oldestFirst ? [...notes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()) : [...notes]);
  return listings.map((listing) => ({ ...listing, notes: order(grouped.get(listing.id) ?? []) }));
}

// One read of the loans on every listing the book can show, shared for SHARED_LOANS_MS. Eight buyers opening the book
// at once each read all of them, and at a few thousand listings that queued each page past ten seconds (stress test,
// November 2026). A card can show a loan's figures or trade status up to that long after they change; a listing
// that wasn't on the book at the read, newly approved say, is read fresh. Who sees which listing is never shared:
// each caller reads its own listings first.
export const SHARED_LOANS_MS = 10_000;
const BOOK_STATUSES = ["APPROVED", "PENDING", "SOLD"] as const;
let shared: { at: number; read: Promise<{ covered: Set<string>; byListing: Map<string, Note[]> }> } | null = null;

async function readBookLoans() {
  const listings = await prisma.listing.findMany({ where: { status: { in: [...BOOK_STATUSES] } }, select: { id: true } });
  const ids = listings.map((listing) => listing.id);
  return { covered: new Set(ids), byListing: groupBy(await readIn("Note", "listingId", ids), "listingId") };
}

export async function bookLoans(listingIds: readonly string[], now = Date.now()) {
  if (!shared || now - shared.at > SHARED_LOANS_MS) {
    const read = readBookLoans();
    shared = { at: now, read };
    read.catch(() => {
      if (shared?.read === read) shared = null;
    });
  }
  const snapshot = await shared.read;
  const missing = listingIds.filter((id) => !snapshot.covered.has(id));
  if (!missing.length) return snapshot.byListing;
  const fresh = groupBy(await readIn("Note", "listingId", missing), "listingId");
  return new Map([...snapshot.byListing, ...fresh]);
}

// Starts the shared read of the book's loans when it is due, so a page can read its own listings at the same time and
// then take their loans from it (withNotes with shared). Production only, like the sharing.
export function warmBookLoans(now = Date.now()) {
  if (process.env.NODE_ENV === "production") bookLoans([], now).catch(() => undefined);
}

// For tests: the next shared read goes to the database.
export function resetBookLoans() {
  shared = null;
}
