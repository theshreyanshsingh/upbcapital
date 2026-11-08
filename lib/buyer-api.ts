import type { Listing, Note, Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { buyNowOffer } from "@/lib/buy-now";
import { unset } from "@/lib/db-filters";
import { showableAvm } from "@/lib/enrichment";
import { listingMatches, type BookFilters } from "@/lib/filters";
import { LIEN_POSITIONS, PAYMENT_STATUSES } from "@/lib/labels";
import { launchPending } from "@/lib/launch-rules";
import { LOAN_FIELDS } from "@/lib/loan-file";
import { listingFigures, loansForSale } from "@/lib/metrics";
import { buyerPrice, counterFrom, openCounter } from "@/lib/offers";
import { prisma } from "@/lib/prisma";
import { isPrivateListing } from "@/lib/private-listings";
import { watchLink } from "@/lib/watchers";

// The read-only buyer API: paging, the book's filters, and what a listing says to a Pro buyer's key. The routes under
// app/api/v1 check the key, its scope and its Pro (lib/api-limit.ts), then answer from here.

export const PAGE_LIMIT = { default: 50, max: 100 } as const;

export type Page = { limit: number; since: Date | null; after: { at: Date; id: string } | null };

export function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

export function cursorFor(at: Date, id: string) {
  return Buffer.from(JSON.stringify([at.toISOString(), id])).toString("base64url");
}

function readCursor(raw: string) {
  try {
    const [at, id] = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as [unknown, unknown];
    const date = new Date(String(at));
    return typeof id === "string" && id && !Number.isNaN(date.getTime()) ? { at: date, id } : null;
  } catch {
    return null;
  }
}

// limit, cursor and updated_since from the query string, or the reason one can't be read.
export function readPage(url: URL): Page | { error: string } {
  const params = url.searchParams;
  let limit: number = PAGE_LIMIT.default;
  const rawLimit = params.get("limit");
  if (rawLimit) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT.max) return { error: `limit is a whole number from 1 to ${PAGE_LIMIT.max}.` };
  }
  let since: Date | null = null;
  const rawSince = params.get("updated_since");
  if (rawSince) {
    since = new Date(rawSince);
    if (Number.isNaN(since.getTime())) return { error: "updated_since is an ISO 8601 time, such as 2026-11-01T00:00:00Z." };
  }
  const rawCursor = params.get("cursor");
  const after = rawCursor ? readCursor(rawCursor) : null;
  if (rawCursor && !after) return { error: "That cursor isn't one this API gave out. Start again without it." };
  return { limit, since, after };
}

// One page in the order a sync reads: oldest change first, then id. The cursor names the last row sent, so a row that
// changes during a sync moves behind it and comes back on the next updated_since pass.
export function paginate<T extends { id: string }>(rows: T[], changedAt: (row: T) => Date, page: Page) {
  const since = page.since?.getTime();
  const after = page.after;
  const keyed = rows
    .map((row) => ({ row, at: changedAt(row).getTime() }))
    .filter(({ at }) => since == null || at >= since)
    .filter(({ row, at }) => !after || at > after.at.getTime() || (at === after.at.getTime() && row.id > after.id))
    .sort((a, b) => a.at - b.at || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));
  const sent = keyed.slice(0, page.limit);
  const last = sent.at(-1);
  return { rows: sent.map((item) => item.row), nextCursor: keyed.length > page.limit && last ? cursorFor(new Date(last.at), last.row.id) : null };
}

const LIENS = new Set<string>(LIEN_POSITIONS.map((item) => item.value));
const STATUSES = new Set<string>(PAYMENT_STATUSES.map((item) => item.value));

function listParam(raw: string | null, allowed: Set<string>) {
  if (!raw) return { values: undefined };
  const values = [...new Set(raw.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean))];
  const bad = values.find((value) => !allowed.has(value));
  return bad ? { bad } : { values };
}

function amountParam(raw: string | null) {
  if (raw == null || raw === "") return { value: undefined };
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? { value } : { bad: raw };
}

// The book's own filters, by the names the developers page gives them. A pool is judged on its loans still for sale,
// as the book judges it: balance and LTV on their totals, state, lien and performance on any one loan.
export function readListingFilters(url: URL): BookFilters | { error: string } {
  const params = url.searchParams;
  const filters: BookFilters = {};
  const state = params.get("state")?.trim().toUpperCase();
  if (state) {
    if (!/^[A-Z]{2}$/.test(state)) return { error: "state is a two-letter code, such as FL." };
    filters.state = state;
  }
  const liens = listParam(params.get("lien_position"), LIENS);
  if ("bad" in liens) return { error: `lien_position takes ${[...LIENS].join(", ")}, comma-separated.` };
  if (liens.values) filters.lienPosition = liens.values;
  const statuses = listParam(params.get("payment_status"), STATUSES);
  if ("bad" in statuses) return { error: `payment_status takes ${[...STATUSES].join(", ")}, comma-separated.` };
  if (statuses.values) filters.paymentStatus = statuses.values;
  for (const [name, key] of [["max_ltv", "ltvMax"], ["min_upb", "upbMin"], ["max_upb", "upbMax"]] as const) {
    const amount = amountParam(params.get(name));
    if ("bad" in amount) return { error: `${name} is a number.` };
    if (amount.value != null) filters[key] = amount.value;
  }
  return filters;
}

export function matchesFilters(listing: ListingWithNotes, filters: BookFilters) {
  return listingMatches({ kind: listing.kind, status: listing.status, bidMode: listing.bidMode, bidDeadline: listing.bidDeadline, notes: listing.notes }, filters);
}

// Live on the book: taking bids or in contract, and past any launch date. Merge it with AND.
export function liveWhere(now = new Date()): Prisma.ListingWhereInput {
  return { status: { in: ["APPROVED", "PENDING"] }, OR: [...unset("launchAt").OR, { launchAt: { lte: now } }] };
}

export function isLive(listing: { status: string; launchAt?: Date | null }, now = new Date()) {
  return (listing.status === "APPROVED" || listing.status === "PENDING") && !launchPending(listing, now);
}

export type ListingWithNotes = Listing & { notes: Note[] };

const round = (value: number | null, digits = 2) => (value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits)));
const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);
const distinct = (values: string[]) => [...new Set(values)].sort();

// A listing as its row on the book reads to a Pro buyer: a live pool's figures are the loans still for sale.
export function listingSummary(listing: ListingWithNotes) {
  const forSale = loansForSale(listing.status, listing.notes);
  const figures = listingFigures(listing.kind, forSale);
  const buyNow = buyNowOffer(listing, forSale.length === listing.notes.length);
  return {
    id: listing.id,
    title: listing.title,
    kind: listing.kind,
    status: listing.status,
    private: isPrivateListing(listing),
    loanCount: listing.notes.length,
    loansForSale: forSale.length,
    states: distinct(forSale.map((note) => note.state)),
    lienPositions: distinct(forSale.map((note) => note.lienPosition)),
    paymentStatuses: distinct(forSale.map((note) => note.paymentStatus)),
    upb: round(figures.upb),
    askingPrice: round(figures.asking),
    estimatedValue: round(figures.value),
    ltv: round(figures.ltv),
    priceToUpb: round(figures.priceToUpb),
    currentYield: round(figures.yield),
    noteRate: round(figures.noteRate, 3),
    buyNowPrice: buyNow.price,
    saleFormat: listing.bidMode,
    bidDeadline: listing.bidMode !== "NONE" ? iso(listing.bidDeadline) : null,
    approvedAt: iso(listing.approvedAt),
    updatedAt: listing.updatedAt.toISOString(),
    webUrl: watchLink(listing.id),
  };
}

// A loan's tape as a signed-in buyer reads it before the confidentiality agreement. LOAN_FIELDS marks the fields that
// identify the borrower or the property (street, borrower, loan number, MERS and eNote ids, the litigation note); they,
// the zip and the seller's memo stay out. A stand-in value estimate is left out in a release, as on the listing page.
const OPEN_FIELDS = LOAN_FIELDS.filter((spec) => !spec.identity).map((spec) => spec.field);

export function loanFacts(note: Note) {
  const row = note as unknown as Record<string, unknown>;
  const facts: Record<string, unknown> = { id: note.id, city: note.city, state: note.state, tradeStatus: note.tradeStatus, askingPrice: note.askingPrice };
  for (const field of OPEN_FIELDS) {
    const value = row[field];
    facts[field] = value instanceof Date ? value.toISOString() : (value ?? null);
  }
  const estimate = showableAvm({ avmValue: note.avmValue, avmProvider: note.avmProvider });
  facts.valueEstimate = estimate;
  facts.valueEstimateProvider = estimate == null ? null : note.avmProvider || null;
  facts.valueEstimateAsOf = estimate == null ? null : iso(note.avmAsOf);
  return facts;
}

export function listingDetail(listing: ListingWithNotes) {
  return { ...listingSummary(listing), summary: listing.summary, loans: listing.notes.map(loanFacts) };
}

// ---------------------------------------------------------------------------------------------------------------
// A buyer's own inquiries. The amount is the buyer's own latest price and the counter is the one put to them, as on
// their Inquiries page; nobody else's bid is ever read here.

async function buyerInquiries(userId: string, id?: string) {
  const inquiries = await prisma.inquiry.findMany({
    where: { buyerId: userId, ...(id ? { id } : {}) },
    include: {
      listing: { select: { title: true, sellerId: true } },
      messages: { select: { kind: true, amount: true, authorId: true, createdAt: true } },
    },
  });
  const closings = await prisma.closing.findMany({ where: { inquiryId: { in: inquiries.map((inquiry) => inquiry.id) } }, select: { id: true, inquiryId: true, openedAt: true } });
  const closingFor = new Map(closings.map((closing) => [closing.inquiryId, closing]));
  return inquiries.map((inquiry) => {
    const priced = inquiry.messages.map((message) => ({ kind: message.kind, amount: message.amount ?? null, createdAt: message.createdAt, authorId: message.authorId }));
    const closing = closingFor.get(inquiry.id);
    // An inquiry keeps no edit time. Its latest message, counter, withdrawal or closing stands in for one.
    const changes = [inquiry.createdAt, inquiry.withdrawnAt, inquiry.sellerCounteredAt, closing?.openedAt, ...inquiry.messages.map((message) => message.createdAt)];
    const updatedAt = new Date(Math.max(...changes.filter((at): at is Date => at instanceof Date).map((at) => at.getTime())));
    return {
      id: inquiry.id,
      updatedAt,
      item: {
        id: inquiry.id,
        type: inquiry.type,
        status: inquiry.status,
        listingId: inquiry.listingId,
        listing: inquiry.listing.title,
        noteId: inquiry.noteId ?? null,
        amount: buyerPrice(inquiry.amount ?? null, priced, userId),
        counter: openCounter(priced, userId),
        counterFrom: counterFrom(priced, userId, inquiry.listing.sellerId),
        expiresAt: iso(inquiry.expiresAt),
        withdrawnAt: iso(inquiry.withdrawnAt),
        closingId: closing?.id ?? null,
        createdAt: inquiry.createdAt.toISOString(),
        updatedAt: updatedAt.toISOString(),
        webUrl: watchLink(inquiry.listingId),
      },
    };
  });
}

export async function buyerOffersResponse(request: Request, userId: string) {
  const page = readPage(new URL(request.url));
  if ("error" in page) return badRequest(page.error);
  const shown = paginate(await buyerInquiries(userId), (row) => row.updatedAt, page);
  return NextResponse.json({ offers: shown.rows.map((row) => row.item), nextCursor: shown.nextCursor });
}

export async function buyerOfferResponse(userId: string, id: string) {
  const [row] = await buyerInquiries(userId, id);
  if (!row) return NextResponse.json({ error: "Offer not found." }, { status: 404 });
  return NextResponse.json(row.item);
}
