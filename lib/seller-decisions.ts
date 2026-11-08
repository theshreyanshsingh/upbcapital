import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { canManageRoom } from "@/lib/acl";
import { deadlinePassed, sealedFromSeller } from "@/lib/auction";
import { audit } from "@/lib/audit";
import { askedPriceStands, awaitingSeller, recordSellerCounter, sameQuestion, sellerPage } from "@/lib/awards";
import { bidderAlias, bidderNamer } from "@/lib/bidder-alias";
import { buyerRecords } from "@/lib/bid-sheet";
import { toCsv } from "@/lib/csv";
import { unset } from "@/lib/db-filters";
import { deskCan } from "@/lib/desk-roles";
import { notify, notifyDesk } from "@/lib/email";
import { FEE_PAYERS, FEE_PAYER_LABELS, feePayerOf, type FeePayer } from "@/lib/fee-schedule";
import { money, prettyDate } from "@/lib/format";
import { onGroupCounter } from "@/lib/group-events";
import { eachItem, type Tally } from "@/lib/jobs";
import { entityLabel } from "@/lib/labels";
import { standingLoanPrices } from "@/lib/loan-prices";
import { pdfSafe, wrap } from "@/lib/memo-pdf";
import { bidExpired, buyerPrice, type OfferMoney } from "@/lib/offers";
import { prisma } from "@/lib/prisma";

// The seller's decision tools: a dated window to answer the desk, counters to any bid they can see, a bid summary
// to download, each bidder's track record, and who pays UPB's fees. The sealed rules in lib/auction.ts hold
// throughout: while a sealed round runs, nothing here shows the seller an amount or anything priced from one.

const HOUR = 60 * 60 * 1000;
const LIVE = ["OPEN", "REVIEWED"] as const;

function dollars(amount: number) {
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

function priced(messages: { kind: string; amount: number | null; createdAt: Date; authorId: string }[]): OfferMoney[] {
  return messages.map((message) => ({ kind: message.kind, amount: message.amount, createdAt: message.createdAt, authorId: message.authorId }));
}

// A marker still at the value read, so an overlapping run or answer finds the item taken.
function still<K extends string>(field: K, seen: Date | null) {
  return seen ? ({ [field]: seen } as Record<K, Date>) : unset(field);
}

// ---------------------------------------------------------------------------------------------------------------
// The window to answer.

export const DEFAULT_RESPONSE_HOURS = 72;
export const MIN_RESPONSE_HOURS = 24;
export const MAX_RESPONSE_HOURS = 240;

// The hours the seller gave themselves to answer the desk. A listing that never set them, or holds a value outside
// the limits, takes the default.
export function responseHours(listing: { sellerResponseHours?: number | null }) {
  const hours = listing.sellerResponseHours;
  return hours != null && Number.isInteger(hours) && hours >= MIN_RESPONSE_HOURS && hours <= MAX_RESPONSE_HOURS ? hours : DEFAULT_RESPONSE_HOURS;
}

export function respondByFor(listing: { sellerResponseHours?: number | null }, askedAt: Date) {
  return new Date(askedAt.getTime() + responseHours(listing) * HOUR);
}

// "Nov 11, 2026, 14:00 UTC".
export function answerByText(at: Date) {
  return `${prettyDate(at)}, ${at.toISOString().slice(11, 16)} UTC`;
}

export function readResponseHours(raw: unknown): { error: string; hours?: undefined } | { error: null; hours: number } {
  const text = String(raw ?? "").trim();
  const hours = Number(text);
  if (!text || !Number.isInteger(hours) || hours < MIN_RESPONSE_HOURS || hours > MAX_RESPONSE_HOURS) {
    return { error: `Give yourself from ${MIN_RESPONSE_HOURS} to ${MAX_RESPONSE_HOURS} hours to answer, in whole hours.` };
  }
  return { error: null, hours };
}

type Ask = { sellerAskedAt: Date | null; sellerAnsweredAt: Date | null; sellerRespondBy?: Date | null; sellerRemindedAt?: Date | null };

// What an open ask is due: the seller's reminder once half the window has run, or the desk's notice once it closed.
// sellerRemindedAt is the last notice sent on the ask. Before the deadline it is the reminder; at or after it, the
// desk's notice. A run that missed half time and lands after the deadline tells the desk only.
export function answerDue(offer: Ask, now = new Date()): "remind" | "report" | null {
  if (!awaitingSeller(offer) || !offer.sellerAskedAt || !offer.sellerRespondBy) return null;
  const asked = offer.sellerAskedAt.getTime();
  const deadline = offer.sellerRespondBy.getTime();
  const last = offer.sellerRemindedAt && offer.sellerRemindedAt.getTime() >= asked ? offer.sellerRemindedAt.getTime() : null;
  if (now.getTime() >= deadline) return last != null && last >= deadline ? null : "report";
  if (now.getTime() >= asked + (deadline - asked) / 2) return last == null ? "remind" : null;
  return null;
}

// The line the seller reads under the desk's ask.
export function answerWindowText(offer: Ask, now = new Date()) {
  if (!offer.sellerRespondBy || !awaitingSeller(offer)) return null;
  if (offer.sellerRespondBy.getTime() <= now.getTime()) {
    return `Your answer was due ${answerByText(offer.sellerRespondBy)}, and the desk was told. You can still answer. Nothing is declined for you.`;
  }
  return `Please answer by ${answerByText(offer.sellerRespondBy)}. If you don't, the desk is told. Nothing is declined for you.`;
}

// The job: each ask is claimed on its last notice before anything is sent, so an overlapping run sends nothing twice,
// and an answer, a new ask or a closed bid landing first wins. The bid is never declined here. `inquiryIds` narrows a
// run, so a test reminds only its own.
export async function remindSellerAnswers(now = new Date(), options: { inquiryIds?: string[] } = {}): Promise<Tally> {
  // No window is longer than MAX_RESPONSE_HOURS, so an ask whose deadline is further off than half that isn't due.
  const asks = await prisma.inquiry.findMany({
    where: {
      type: "OFFER",
      status: { in: [...LIVE] },
      sellerRespondBy: { lte: new Date(now.getTime() + (MAX_RESPONSE_HOURS / 2) * HOUR) },
      ...(options.inquiryIds ? { id: { in: options.inquiryIds } } : {}),
    },
    include: { buyer: { select: { name: true } }, listing: { include: { seller: { select: { email: true, role: true } } } } },
  });
  return eachItem("seller answer", asks, (offer) => `inquiry ${offer.id}`, async (offer) => {
    const due = answerDue(offer, now);
    if (!due || !offer.sellerRespondBy) return false;
    const claim = await prisma.inquiry.updateMany({
      where: { ...sameQuestion(offer), sellerRespondBy: offer.sellerRespondBy, AND: [still("sellerRemindedAt", offer.sellerRemindedAt)] },
      data: { sellerRemindedAt: now },
    });
    if (claim.count !== 1) return false;
    const title = offer.listing.title;
    const asked = dollars(Number(offer.sellerAskedAmount ?? 0));
    const deadline = answerByText(offer.sellerRespondBy);
    if (due === "remind") {
      const link = `${process.env.NEXT_PUBLIC_APP_URL || ""}${sellerPage(offer.listing, offer.listing.seller.role)}`;
      await notify(
        offer.listing.seller.email,
        `Waiting on your answer · ${title}`,
        `The desk asked you on ${prettyDate(offer.sellerAskedAt)} to approve a sale at ${asked}${offer.noteId ? " for one loan" : ""}. Please answer by ${deadline}. If you don't, the desk is told. Nothing is declined for you. Approve, decline or counter here: ${link}`,
      );
      return true;
    }
    await audit(null, "SELLER_ANSWER_LATE", "inquiry", offer.id, `${title} · ${asked} · due ${deadline}`);
    await notifyDesk(
      `Seller didn't answer · ${title}`,
      `The seller hasn't answered the desk's ask of ${prettyDate(offer.sellerAskedAt)} on ${offer.buyer.name}'s bid of ${asked}. Their window closed at ${deadline}. The bid stays open. Call the seller, ask again, or decline the bid from the offer book.`,
      { capability: "sealedBids" },
    );
    return true;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Counters to any bid the seller can see.

// Why the seller can't counter this bid now, or null. The sealed rules hold: no counter while a sealed round runs,
// and none during a best-and-final round, where each bidder has one bid. A bid the seller picked is already agreed at
// its price.
export function sellerCounterBlock(input: {
  type: string;
  status: string;
  listing: { status: string; bidMode: string; bidDeadline: Date | null };
  expiresAt: Date | null;
  current: number | null;
  amount: number;
  picked: boolean;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  if (input.type !== "OFFER" || !(LIVE as readonly string[]).includes(input.status)) return "That bid is no longer open.";
  if (input.listing.status !== "APPROVED") return "This listing isn't live right now, so you can't counter.";
  if (sealedFromSeller(input.listing, now)) return "Bids are sealed until the deadline, so you can counter once it passes.";
  if (input.listing.bidMode !== "NONE" && !deadlinePassed(input.listing.bidDeadline, now)) return "Best and final gives each bidder one bid, so you can counter once the deadline passes.";
  if (bidExpired(input.expiresAt, now)) return "That bid passed its good-until date, so there is nothing to counter.";
  if (input.picked) return "You already agreed to this bid's price when you picked it, so the desk can award it as it stands.";
  if (!Number.isFinite(input.amount) || input.amount <= 0 || input.amount > 1_000_000_000) return "Enter your counter in dollars.";
  if (input.current == null || input.current <= 0) return "That bid has no amount.";
  if (input.amount <= input.current + 0.005) return "A counter is above the buyer's bid. To sell at their price, pick it.";
  return null;
}

// The seller counters any live bid they can see, not only the one the desk asked about. Like an answer to the desk,
// the counter is their approval of exactly that price and goes to the buyer, who accepts it through the offer
// thread. Accepting doesn't award: the desk awards as it does any approved bid. A bid the desk asked about is
// answered through the desk's question.
export async function counterAnyBid(input: { inquiryId: string; sellerId: string; amount: number; now?: Date }) {
  const now = input.now ?? new Date();
  const offer = await prisma.inquiry.findUnique({ where: { id: input.inquiryId }, include: { buyer: true, listing: true, messages: true } });
  if (!offer || offer.listing.sellerId !== input.sellerId) return { error: "That bid isn't on your listing." } as const;
  if (awaitingSeller(offer)) return recordSellerCounter(offer.id, input.sellerId, input.amount, now);
  const current = buyerPrice(offer.amount, priced(offer.messages), offer.buyerId);
  const picked = Boolean(offer.sellerRequestedAt) && askedPriceStands(offer.sellerApprovedAmount, current);
  const block = sellerCounterBlock({ type: offer.type, status: offer.status, listing: offer.listing, expiresAt: offer.expiresAt, current, amount: input.amount, picked, now });
  if (block) return { error: block } as const;
  const amount = input.amount;
  // Claimed on the bid as read: a desk question, another counter, an award or the good-until date landing in the
  // same instant wins. The counter is for the whole bid, so loan prices under the old total clear.
  const wrote = await prisma.inquiry.updateMany({
    where: {
      id: offer.id,
      status: { in: [...LIVE] },
      AND: [
        offer.sellerAskedAt ? { sellerAskedAt: offer.sellerAskedAt } : unset("sellerAskedAt"),
        still("sellerCounteredAt", offer.sellerCounteredAt),
        { OR: [...unset("expiresAt").OR, { expiresAt: { gt: now } }] },
      ],
    },
    data: {
      sellerCounterAmount: amount,
      sellerCounteredAt: now,
      sellerApprovedAmount: amount,
      sellerDeclined: false,
      ...(offer.loanPrices != null ? { loanPrices: null, allowPartial: null } : {}),
    },
  });
  if (wrote.count !== 1) return { error: "This bid changed a moment ago. Reload the page and try again." } as const;
  const title = offer.listing.title;
  const alias = await bidderAlias(offer.listingId, offer.buyerId);
  await prisma.offerMessage.create({ data: { inquiryId: offer.id, authorId: input.sellerId, kind: "COUNTER", amount, createdAt: now, body: `The seller countered at ${dollars(amount)}.` } });
  // A group's seats each reconfirm the new price before it is the group's bid.
  await onGroupCounter(offer.id, amount, "seller");
  await audit(input.sellerId, "SELLER_COUNTERED", "inquiry", offer.id, `${title} · bid ${dollars(current ?? 0)} · countered ${dollars(amount)} · the desk hadn't asked`);
  const link = `${process.env.NEXT_PUBLIC_APP_URL || ""}/buyer/offers`;
  await notify(
    offer.buyer.email,
    `Seller counter · ${title}`,
    `The seller countered your bid at ${dollars(amount)}. The seller has already agreed to that price, so if you accept it the desk can award it without asking again.${offer.loanPrices != null ? " Your loan prices were cleared with the counter, so price each loan again when you answer if the seller may take part of the pool." : ""} You can also leave your bid as it is: ${link}`,
  );
  await notifyDesk(
    `Seller countered · ${title}`,
    `The seller countered ${offer.buyer.name}'s bid (${alias} to the seller) of ${dollars(current ?? 0)} at ${dollars(amount)}, without a question from the desk. It's posted to the buyer. If they accept, it can be awarded without asking the seller again.`,
    { capability: "sealedBids" },
  );
  return { error: null, amount, alias } as const;
}

// Once a bid wins, the seller's counters to the bids that stay live close: a bid kept as backup, or a pool bid that
// can still win loans the sale left free. Their counters were prices for loans that are now sold. The losing bids
// close with their counters in lib/awards.ts declineLosingBids, which calls this. Each buyer hears once.
export async function closeOtherCounters(winner: { id: string | null; listingId: string; noteId: string | null; noteIds?: string[] }, title: string) {
  const sold = winner.noteIds?.length ? winner.noteIds : winner.noteId ? [winner.noteId] : null;
  const [listing, rows] = await Promise.all([
    prisma.listing.findUnique({ where: { id: winner.listingId }, select: { sellerId: true } }),
    prisma.inquiry.findMany({
      where: {
        listingId: winner.listingId,
        ...(winner.id ? { id: { not: winner.id } } : {}),
        type: "OFFER",
        status: { in: [...LIVE] },
        sellerCounteredAt: { not: null },
        ...(sold ? { OR: [{ noteId: { in: sold } }, ...unset("noteId").OR] } : {}),
      },
      include: { buyer: { select: { email: true } } },
    }),
  ]);
  if (!listing) return 0;
  let closed = 0;
  for (const row of rows) {
    const amount = row.sellerCounterAmount;
    const wrote = await prisma.inquiry.updateMany({
      where: { id: row.id, sellerCounteredAt: row.sellerCounteredAt },
      data: { sellerCounterAmount: null, sellerCounteredAt: null, ...(amount != null && askedPriceStands(row.sellerApprovedAmount, amount) ? { sellerApprovedAmount: null } : {}) },
    });
    if (wrote.count !== 1) continue;
    closed += 1;
    const figure = amount != null ? ` at ${dollars(amount)}` : "";
    await prisma.offerMessage.create({ data: { inquiryId: row.id, authorId: listing.sellerId, kind: "NOTE", body: `Another bid was awarded, so the seller's counter${figure} is closed.` } });
    await audit(null, "SELLER_COUNTER_CLOSED", "inquiry", row.id, `${title}${figure} · another bid was awarded`);
    await notify(row.buyer.email, `Seller counter closed · ${title}`, `Another bid was awarded, so the seller's counter${figure} on your bid is closed. Your bid stands at your own latest price.`);
  }
  return closed;
}

// ---------------------------------------------------------------------------------------------------------------
// Each bidder's track record, as the seller reads it beside the bidder's letter.

export type TrackInput = {
  // The buyer's main file. Its exact funds figure goes in and only a band comes out.
  file: { status?: string | null; entityType?: string | null; proofAmount?: number | null; proofExpiresAt?: Date | null; proofVerifiedAt?: Date | null } | null;
  // The entity the bid is for, when it isn't the main file.
  entityType?: string | null;
  record: { closed: number; canceled: number };
  strikes: number;
  memberSince: Date;
};

export type TrackRecord = { funds: string; entity: string; closed: number; closeRate: string; strikes: number; memberSince: number };

const FUNDS_BANDS: [number, string][] = [
  [100_000, "under $100k"],
  [250_000, "$100k–$250k"],
  [1_000_000, "$250k–$1M"],
  [5_000_000, "$1M–$5M"],
];

// The band the desk-verified funds fall in, never the figure: "verified $250k–$1M".
export function fundsBand(file: TrackInput["file"], now = new Date()) {
  const amount = file?.proofAmount;
  if (!file || file.status !== "APPROVED" || !file.proofVerifiedAt || amount == null || !(amount > 0)) return "funds not verified";
  if (file.proofExpiresAt && file.proofExpiresAt.getTime() <= now.getTime()) return "funds proof expired";
  return `verified ${FUNDS_BANDS.find(([top]) => amount < top)?.[1] ?? "over $5M"}`;
}

function closeRate(record: { closed: number; canceled: number }) {
  const decided = record.closed + record.canceled;
  return decided ? `${Math.round((record.closed * 100) / decided)}%` : "no closings yet";
}

// The one place a bidder's record is put together for a seller. It reads only the fields named here, so a name, an
// email, a company or the exact funds figure passed in alongside can't come out.
export function trackRecord(input: TrackInput, now = new Date()): TrackRecord {
  return {
    funds: fundsBand(input.file, now),
    entity: entityLabel(input.entityType || input.file?.entityType || "INDIVIDUAL"),
    closed: Math.max(0, input.record.closed),
    closeRate: closeRate(input.record),
    strikes: Math.max(0, input.strikes),
    memberSince: input.memberSince.getUTCFullYear(),
  };
}

export function trackLine(record: TrackRecord) {
  const funds = record.funds.charAt(0).toUpperCase() + record.funds.slice(1);
  const closed = `${record.closed} closed on UPB`;
  const rate = record.closeRate.endsWith("%") ? `${record.closeRate} close rate` : record.closeRate;
  const strikes = record.strikes ? `${record.strikes} strike${record.strikes === 1 ? "" : "s"}` : "no strikes";
  return `${funds} · ${record.entity} · ${closed} · ${rate} · ${strikes} · member since ${record.memberSince}`;
}

// Track records for a set of bids, keyed by bid, since a bid names the entity it is for.
export async function trackRecordsFor(offers: { id: string; buyerId: string; buyerEntityId?: string | null }[], now = new Date()) {
  const out = new Map<string, TrackRecord>();
  if (!offers.length) return out;
  const buyerIds = [...new Set(offers.map((offer) => offer.buyerId))];
  const entityIds = [...new Set(offers.map((offer) => offer.buyerEntityId).filter((id): id is string => Boolean(id)))];
  const [users, records, strikes, entities] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: buyerIds } },
      select: { id: true, createdAt: true, buyerProfile: { select: { status: true, entityType: true, proofAmount: true, proofExpiresAt: true, proofVerifiedAt: true } } },
    }),
    buyerRecords(buyerIds),
    prisma.buyerStrike.findMany({ where: { userId: { in: buyerIds }, ...unset("clearedAt") }, select: { userId: true } }),
    entityIds.length ? prisma.buyerEntity.findMany({ where: { id: { in: entityIds } }, select: { id: true, userId: true, entityType: true } }) : Promise.resolve([]),
  ]);
  const userOf = new Map(users.map((user) => [user.id, user]));
  const entityOf = new Map(entities.map((entity) => [entity.id, entity]));
  for (const offer of offers) {
    const user = userOf.get(offer.buyerId);
    if (!user) continue;
    const entity = offer.buyerEntityId ? entityOf.get(offer.buyerEntityId) : undefined;
    out.set(
      offer.id,
      trackRecord(
        {
          file: user.buyerProfile,
          entityType: entity && entity.userId === offer.buyerId ? entity.entityType : null,
          record: records.get(offer.buyerId) ?? { closed: 0, canceled: 0 },
          strikes: strikes.filter((strike) => strike.userId === offer.buyerId).length,
          memberSince: user.createdAt,
        },
        now,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The bid summary the seller downloads.

export const BID_SUMMARY_COLUMNS = [
  "bidder",
  "scope",
  "price",
  "pct_of_upb",
  "loan_prices",
  "good_until",
  "status",
  "reserve_met",
  "verified_funds",
  "entity",
  "closed_on_upb",
  "close_rate",
  "strikes",
  "member_since",
] as const;

export type BidSummaryRow = Record<(typeof BID_SUMMARY_COLUMNS)[number], string>;

const SEALED = "Sealed until the deadline";

type Viewer = { id: string; role: string; deskRole?: string | null };

// The listing's seller, a broker of record and the desk's sales staff. Every buyer, and every other desk role, is
// refused.
export function canReadBidSummary(viewer: Viewer, listing: { sellerId: string; brokerId?: string | null }) {
  if (viewer.role === "ADMIN") return deskCan(viewer, "sales");
  return canManageRoom(viewer, listing);
}

function statusText(offer: { status: string; expiresAt: Date | null; sellerAskedAt: Date | null; sellerAnsweredAt: Date | null; sellerCounterAmount: number | null; sellerCounteredAt: Date | null; sellerRequestedAt: Date | null }, sealed: boolean, now: Date) {
  if (offer.status === "ACCEPTED") return "Accepted";
  if (offer.status === "DECLINED") return "Declined";
  if (offer.status === "WITHDRAWN") return "Withdrawn";
  if (offer.status === "EXPIRED" || bidExpired(offer.expiresAt, now)) return "Expired";
  if (awaitingSeller(offer)) return "Open, waiting on the seller's answer";
  if (!sealed && offer.sellerCounterAmount != null && offer.sellerCounteredAt) return `Open, the seller countered at ${dollars(offer.sellerCounterAmount)}`;
  if (offer.sellerRequestedAt) return "Open, picked by the seller";
  return "Open";
}

// Every bid on the listing as the seller reads it on their page: the bidder by letter until an award, and while a
// sealed round runs no amount, no share of UPB, no loan prices and no reserve check. The desk downloads the same
// copy the seller does.
export async function bidSummary(listingId: string, viewer: Viewer, now = new Date()) {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    include: {
      notes: { select: { id: true, city: true, state: true, upb: true }, orderBy: { createdAt: "asc" } },
      inquiries: {
        where: { type: "OFFER" },
        include: { buyer: { select: { id: true, name: true, companyName: true } }, messages: { select: { kind: true, amount: true, createdAt: true, authorId: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!listing) return { status: 404 as const };
  if (!canReadBidSummary(viewer, listing)) return { status: 403 as const };
  const sealed = sealedFromSeller(listing, now);
  const [nameOf, records] = await Promise.all([bidderNamer(listing.id, { role: "SELLER" }), trackRecordsFor(listing.inquiries, now)]);
  const position = new Map(listing.notes.map((note, index) => [note.id, index + 1]));
  const totalUpb = listing.notes.reduce((sum, note) => sum + Number(note.upb), 0);
  const reserve = listing.reservePrice != null && listing.reservePrice > 0 ? Number(listing.reservePrice) : null;
  const bids = listing.inquiries.map((offer) => ({ offer, price: buyerPrice(offer.amount, priced(offer.messages), offer.buyerId) }));
  // Highest first once amounts show, as on the seller's page. While sealed, the order the bids came in.
  if (!sealed) bids.sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
  const rows: BidSummaryRow[] = bids.map(({ offer, price }) => {
    const note = offer.noteId ? listing.notes.find((item) => item.id === offer.noteId) : null;
    const upb = note ? Number(note.upb) : totalUpb;
    const prices = !sealed && !offer.noteId && listing.kind === "POOL" ? standingLoanPrices(offer.loanPrices, price) : null;
    const record = records.get(offer.id);
    const shown = !sealed && price != null && price > 0;
    return {
      bidder: nameOf(offer.buyer),
      scope: note ? `Loan ${position.get(note.id)} in ${note.city}, ${note.state}` : "Whole listing",
      price: sealed ? SEALED : shown ? price.toFixed(2) : "",
      pct_of_upb: shown && upb > 0 ? ((price / upb) * 100).toFixed(2) : "",
      loan_prices: prices
        ? listing.notes.filter((item) => prices[item.id] != null).map((item) => `Loan ${position.get(item.id)} ${prices[item.id].toFixed(2)}`).join("; ")
        : "",
      good_until: offer.expiresAt ? offer.expiresAt.toISOString().slice(0, 10) : "No end date",
      status: statusText(offer, sealed, now),
      reserve_met: shown ? (reserve == null ? "No reserve set" : price >= reserve ? "Yes" : "No") : "",
      verified_funds: record?.funds ?? "",
      entity: record?.entity ?? "",
      closed_on_upb: record ? String(record.closed) : "",
      close_rate: record?.closeRate ?? "",
      strikes: record ? String(record.strikes) : "",
      member_since: record ? String(record.memberSince) : "",
    };
  });
  return { status: 200 as const, listing: { id: listing.id, title: listing.title, bidMode: listing.bidMode, bidDeadline: listing.bidDeadline, reserve }, sealed, rows };
}

export type BidSummary = Extract<Awaited<ReturnType<typeof bidSummary>>, { status: 200 }>;

export function bidSummaryCsv(summary: BidSummary) {
  return summary.rows.length ? toCsv(summary.rows) : BID_SUMMARY_COLUMNS.join(",");
}

// One page or two, a block per bid, for a seller who wants it on paper.
export async function bidSummaryPdf(summary: BidSummary, generatedAt = new Date()) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const soft = rgb(0.4, 0.4, 0.45);
  let page = pdf.addPage([612, 792]);
  let y = 742;
  const line = (text: string, options: { size?: number; face?: typeof font; color?: typeof ink; gap?: number } = {}) => {
    const size = options.size ?? 10;
    const face = options.face ?? font;
    for (const part of wrap(pdfSafe(text, face), face, size, 516)) {
      if (y < 56) {
        page = pdf.addPage([612, 792]);
        y = 742;
      }
      page.drawText(part, { x: 48, y, size, font: face, color: options.color ?? ink });
      y -= size + 4;
    }
    y -= options.gap ?? 0;
  };
  const { listing } = summary;
  line("UPB CAPITAL  ·  BID SUMMARY", { size: 9, face: bold, color: soft, gap: 6 });
  line(listing.title, { size: 18, face: bold, gap: 4 });
  line(`Generated ${answerByText(generatedAt)} · ${summary.rows.length} bid${summary.rows.length === 1 ? "" : "s"}`, { color: soft, gap: 4 });
  const round = listing.bidMode === "SEALED" ? "Sealed bids" : listing.bidMode === "BEST_AND_FINAL" ? "Best and final" : "Open offers";
  line(`${round}${listing.bidDeadline ? `, deadline ${answerByText(listing.bidDeadline)}` : ""}. Reserve: ${listing.reserve == null ? "none set" : money(listing.reserve)}.`, { gap: 4 });
  if (summary.sealed) line("Bids are sealed until the deadline, so their amounts, loan prices and reserve checks are left out.", { color: soft, gap: 4 });
  line("Bidders show by letter until an award. Funds show as the band the desk verified, never the figure.", { size: 9, color: soft, gap: 10 });
  if (!summary.rows.length) line("No bids yet.", { color: soft });
  for (const row of summary.rows) {
    const figure = row.price === SEALED ? "amount sealed" : row.price ? `${money(Number(row.price), 2)}${row.pct_of_upb ? ` (${row.pct_of_upb}% of UPB)` : ""}` : "no amount";
    line(`${row.bidder} · ${figure}`, { size: 11, face: bold, gap: 1 });
    line(`${row.scope} · ${row.status} · good until ${row.good_until === "No end date" ? "no end date" : prettyDate(`${row.good_until}T00:00:00Z`)}${row.reserve_met ? ` · meets reserve: ${row.reserve_met.toLowerCase()}` : ""}`, { gap: 1 });
    if (row.loan_prices) line(`Loan prices: ${row.loan_prices.replaceAll(/(\d+\.\d{2})/g, (value) => money(Number(value), 2))}`, { gap: 1 });
    line(
      `Track record: ${row.verified_funds} · ${row.entity} · ${row.closed_on_upb} closed on UPB · close rate ${row.close_rate} · ${row.strikes} strike${row.strikes === "1" ? "" : "s"} · member since ${row.member_since}`,
      { color: soft, gap: 8 },
    );
  }
  line("The CSV of this summary has the same rows. Times are UTC.", { size: 9, color: soft });
  return pdf.save();
}

// ---------------------------------------------------------------------------------------------------------------
// The seller's settings on the listing: the window and who pays the fees.

// Who pays can change until the listing goes live, and then locks with the rates the desk's approval writes on it.
// A listing the desk sends back for changes opens it again, as the next approval writes the rates again.
export const FEE_PAYER_OPEN = ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "REJECTED"] as const;

export function feePayerBlock(status: string) {
  if ((FEE_PAYER_OPEN as readonly string[]).includes(status)) return null;
  return "Who pays the fees was fixed when the listing went live, along with the rates.";
}

// The seller of record picks who pays. The write is conditional on the status as it was read, so the desk's
// approval landing first locks it and this asks for a reload.
export async function setFeePayer(input: { listingId: string; actorId: string; payer: unknown }) {
  if (!(FEE_PAYERS as readonly unknown[]).includes(input.payer)) return { error: "Choose who pays UPB's fees." } as const;
  const payer = input.payer as FeePayer;
  const listing = await prisma.listing.findUnique({ where: { id: input.listingId }, select: { id: true, title: true, status: true, sellerId: true, feePayer: true } });
  if (!listing || listing.sellerId !== input.actorId) return { error: "That listing isn't yours." } as const;
  const block = feePayerBlock(listing.status);
  if (block) return { error: block } as const;
  const was = feePayerOf(listing.feePayer);
  if (was === payer) return { error: null, payer, unchanged: true } as const;
  const wrote = await prisma.listing.updateMany({ where: { id: listing.id, status: listing.status }, data: { feePayer: payer } });
  if (wrote.count !== 1) return { error: "This listing changed a moment ago. Reload it and try again." } as const;
  await audit(input.actorId, "FEE_PAYER", "listing", listing.id, `${FEE_PAYER_LABELS[was]} to ${FEE_PAYER_LABELS[payer]}`);
  await notifyDesk(`Fee payer changed · ${listing.title}`, `The seller changed who pays UPB's fees on ${listing.title}. Now: ${FEE_PAYER_LABELS[payer].toLowerCase()}. It locks when the listing goes live.`);
  return { error: null, payer, unchanged: false } as const;
}

// The desk's line for the seller's terms on its listing page.
export function sellerTermsLine(listing: { status: string; feePayer?: string | null; sellerResponseHours?: number | null }) {
  const payer = { SPLIT: "split", SELLER: "the seller pays both", BUYER: "the buyer pays both" }[feePayerOf(listing.feePayer)];
  const lock = feePayerBlock(listing.status) ? "fixed at go-live" : "the seller can change it until go-live";
  const hours = responseHours(listing);
  return `UPB's fees: ${payer}, ${lock} · the seller answers an ask within ${hours} hours${listing.sellerResponseHours == null ? ", the default" : ""}`;
}

// What a duplicate or a relist filed for review carries of the seller's terms: who pays and the window, as the new
// listing's defaults. The copy starts before go-live, so the seller can still change both. A split and a missing or
// out-of-range window are left off, so they read as the defaults, as before.
export function carriedSellerTerms(source: { feePayer?: string | null; sellerResponseHours?: number | null }) {
  const payer = feePayerOf(source.feePayer);
  const hours = source.sellerResponseHours;
  return {
    ...(payer === "SPLIT" ? {} : { feePayer: payer }),
    ...(hours != null && responseHours({ sellerResponseHours: hours }) === hours ? { sellerResponseHours: hours } : {}),
  };
}

// The seller of record sets their window. It counts from the desk's next ask; an ask already open keeps its date.
export async function setResponseWindow(input: { listingId: string; actorId: string; hours: unknown }) {
  const read = readResponseHours(input.hours);
  if (read.error !== null) return { error: read.error } as const;
  const listing = await prisma.listing.findUnique({ where: { id: input.listingId }, select: { id: true, status: true, sellerId: true, sellerResponseHours: true } });
  if (!listing || listing.sellerId !== input.actorId) return { error: "That listing isn't yours." } as const;
  if (listing.status === "SOLD" || listing.status === "WITHDRAWN") return { error: "This listing is closed, so there is nothing left to answer." } as const;
  if (responseHours(listing) === read.hours && listing.sellerResponseHours != null) return { error: null, hours: read.hours, unchanged: true } as const;
  await prisma.listing.update({ where: { id: listing.id }, data: { sellerResponseHours: read.hours } });
  await audit(input.actorId, "SELLER_RESPONSE_HOURS", "listing", listing.id, `${read.hours} hours to answer the desk`);
  return { error: null, hours: read.hours, unchanged: false } as const;
}
