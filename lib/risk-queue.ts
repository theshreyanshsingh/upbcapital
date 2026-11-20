import { deletionQueue } from "@/lib/account-deletion";
import { deskWalled } from "@/lib/auction";
import { deskClaimQueue, statusLabel } from "@/lib/claims";
import { covenantAwardBlocks } from "@/lib/covenants";
import { openCustodyExceptions } from "@/lib/custody";
import { openDepositDecisions } from "@/lib/deposits";
import { deskCan, type DeskCapability, type Staff } from "@/lib/desk-roles";
import { assignmentChainHolds } from "@/lib/diligence-checklist";
import { openDuplicateHolds } from "@/lib/duplicates";
import { prettyDate } from "@/lib/format";
import { owedBrokerFees, payoutAccountsToCheck, payoutLabel } from "@/lib/payout-accounts";
import { prisma } from "@/lib/prisma";
import { pausedListings, statementHolds } from "@/lib/provenance";
import { openReviewWhere, reviewKey } from "@/lib/screening";
import { dealOwners } from "@/lib/staff";
import { allPendingWireChanges } from "@/lib/wire-changes";

// The desk's risk queue: every open hold and red flag across the platform on one page, so nobody visits a dozen
// pages to learn what is stuck and for how long. Each kind has one small reader below, and each reader asks the module
// that owns the rule for its open items, in bulk; nothing here decides whether something is held. The queue reads the
// rules and changes nothing.
//
// Each item says what it is about and links to the page that resolves it, how long it has waited, who owns it (the
// named deal owner, or else the desk role that resolves it) and the next step. A money figure on an item behind the
// sealed-bid wall is withheld from a desk role walled off from bids, as the offers page does (lib/auction.ts).

// Worst first: sanctions, then money, then holds on a deal, then housekeeping. Oldest first within each.
export const RISK_KINDS = {
  SANCTIONS: { label: "Sanctions review", tier: 0 },
  PAYOUT_HOLD: { label: "Payout account held", tier: 0 },
  WIRE_CHANGE: { label: "Wire change", tier: 1 },
  DEPOSIT: { label: "Deposit decision", tier: 1 },
  BROKER_FEE: { label: "Broker fee", tier: 1 },
  PAYOUT_NAME: { label: "Payout name mismatch", tier: 1 },
  PAYOUT_CHECK: { label: "Payout account check", tier: 1 },
  DUPLICATE: { label: "Possible duplicate", tier: 2 },
  ASSIGNMENTS: { label: "Assignment chain", tier: 2 },
  OWNERSHIP: { label: "Ownership statement", tier: 2 },
  COVENANTS: { label: "Covenant acknowledgement", tier: 2 },
  CUSTODY: { label: "Custodian exception", tier: 2 },
  CLAIM: { label: "Repurchase claim", tier: 2 },
  PAUSED: { label: "Paused listing", tier: 3 },
  DELETION: { label: "Deletion request", tier: 3 },
} as const;

export type RiskKind = keyof typeof RISK_KINDS;
export const RISK_KIND_ORDER = Object.keys(RISK_KINDS) as RiskKind[];

export function isRiskKind(value: unknown): value is RiskKind {
  return typeof value === "string" && value in RISK_KINDS;
}

// The desk roles that resolve an item, by capability (lib/desk-roles.ts).
export type Resolver = Extract<DeskCapability, "sales" | "closings" | "compliance" | "approveWires">;

export const RESOLVER_LABELS: Record<Resolver, string> = {
  sales: "Sales",
  closings: "Closings",
  compliance: "Compliance",
  approveWires: "Wire approvers",
};

type WallListing = { bidMode: string; bidDeadline: Date | null; status?: string };

export type RiskItem = {
  id: string;
  kind: RiskKind;
  // What it is about, and a line of context. Neither carries a money figure: that is amountCents, behind the wall.
  title: string;
  detail: string;
  href: string;
  // When it opened. Null only where the record keeps no date.
  openedAt: Date | null;
  owner: { id: string; name: string } | null;
  resolver: Resolver;
  next: string;
  amountCents: number | null;
  amountLabel?: string;
  // A figure was withheld because the viewer's role is behind the sealed-bid wall on this listing.
  sealed: boolean;
};

// What a reader returns: the deal owner by id, and the listing the wall is read from.
export type RawRiskItem = Omit<RiskItem, "owner" | "sealed"> & { ownerId?: string | null; listing?: WallListing | null };

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const cents = (dollars: number | null | undefined) => (dollars == null ? null : Math.round(Number(dollars) * 100));

// ---------------------------------------------------------------------------------------------------------------
// The readers, one per rule module.

// lib/screening.ts: open reviews, one per party, name and list entry, as the compliance page lists them. A review
// dates from its first open screen.
async function sanctionReviews(): Promise<RawRiskItem[]> {
  const rows = await prisma.ofacCheck.findMany({ where: openReviewWhere, orderBy: { createdAt: "asc" } });
  const reviews = new Map<string, typeof rows>();
  for (const row of rows) reviews.set(reviewKey(row), [...(reviews.get(reviewKey(row)) ?? []), row]);
  const listingIds = [...new Set(rows.map((row) => row.listingId).filter((id): id is string => Boolean(id)))];
  const listings = listingIds.length ? await prisma.listing.findMany({ where: { id: { in: listingIds } }, select: { id: true, deskOwnerId: true } }) : [];
  const ownerOf = new Map(listings.map((listing) => [listing.id, listing.deskOwnerId]));
  return [...reviews.values()].map((group): RawRiskItem => {
    const latest = group[group.length - 1];
    return {
      id: `SANCTIONS:${latest.id}`,
      kind: "SANCTIONS",
      title: latest.matched ? `${latest.name}, matched ${latest.matched}` : latest.name,
      detail: latest.context || "Screened before reviews were tracked",
      href: "/admin/compliance",
      openedAt: group[0].createdAt,
      ownerId: latest.listingId ? ownerOf.get(latest.listingId) : null,
      resolver: "compliance",
      next: "Clear it as a false match or confirm it, saying what you checked. Say nothing to the party.",
      amountCents: null,
    };
  });
}

// lib/payout-accounts.ts: accounts a sanctions match holds, then accounts waiting for the call-back or the second
// desk member, with a name that isn't the vetted one marked apart. A seller's account is worked on their closing page.
async function payoutChecks(): Promise<RawRiskItem[]> {
  const accounts = (await payoutAccountsToCheck()).filter((account) => account.status !== "REJECTED");
  const sellers = [...new Set(accounts.filter((account) => account.user.role !== "BROKER").map((account) => account.userId))];
  const closings = sellers.length
    ? await prisma.closing.findMany({
        where: { status: { in: ["OPEN", "COMPLETE"] }, listing: { sellerId: { in: sellers } } },
        select: { id: true, status: true, deskOwnerId: true, listing: { select: { sellerId: true } } },
        orderBy: { openedAt: "desc" },
      })
    : [];
  // The seller's open closing, or else their latest.
  const closingOf = new Map<string, (typeof closings)[number]>();
  for (const closing of closings) {
    const known = closingOf.get(closing.listing.sellerId);
    if (!known || (known.status !== "OPEN" && closing.status === "OPEN")) closingOf.set(closing.listing.sellerId, closing);
  }
  return accounts.map((account): RawRiskItem => {
    const broker = account.user.role === "BROKER";
    const holder = account.user.companyName || account.user.name;
    const closing = broker ? undefined : closingOf.get(account.userId);
    const href = broker ? "/admin/payouts" : closing ? `/closings/${closing.id}#payout` : `/admin/search?q=${encodeURIComponent(holder)}`;
    const base = { title: `${holder} · ${payoutLabel(account)}`, href, ownerId: closing?.deskOwnerId ?? null, amountCents: null };
    if (account.held) {
      return {
        ...base,
        id: `PAYOUT_HOLD:${account.id}`,
        kind: "PAYOUT_HOLD",
        detail: `A sanctions match on ${account.accountName}, the name on the account, holds it.`,
        openedAt: account.screenedAt ?? account.createdAt,
        resolver: "compliance",
        next: "Decide the match under Compliance. Verifying the account screens the name again.",
      };
    }
    const where = broker ? "on the payouts page" : closing ? "on the closing page" : "on the seller's closing page once one opens";
    const next = !account.callbackAt
      ? `Call the holder on a number the desk finds itself, and log the call-back ${where}.`
      : `A desk member other than the one who called verifies it${account.nameMatches ? "" : ", with a reason for the name"}.`;
    return {
      ...base,
      id: `${account.nameMatches ? "PAYOUT_CHECK" : "PAYOUT_NAME"}:${account.id}`,
      kind: account.nameMatches ? "PAYOUT_CHECK" : "PAYOUT_NAME",
      detail: account.nameMatches
        ? `Added by the ${broker ? "broker" : "seller"}. ${account.callbackAt ? "Call-back logged." : "No call-back yet."}`
        : `The name on the account, ${account.accountName}, isn't ${account.vetted[0] ?? "a name the desk vetted"}.`,
      openedAt: account.createdAt,
      resolver: "approveWires",
      next,
    };
  });
}

// lib/wire-changes.ts: proposals waiting for a second desk member.
async function wireChanges(): Promise<RawRiskItem[]> {
  return (await allPendingWireChanges()).map((change): RawRiskItem => ({
    id: `WIRE_CHANGE:${change.id}`,
    kind: "WIRE_CHANGE",
    title: change.closing?.listing.title ?? "The desk's default wire instructions",
    detail: `New instructions proposed by ${change.proposedBy}. The ones on file stand until approved.`,
    href: change.closingId ? `/closings/${change.closingId}#wires` : "/admin/settings#wires",
    openedAt: change.createdAt,
    ownerId: change.closing?.deskOwnerId ?? null,
    resolver: "approveWires",
    next: `A desk member other than ${change.proposedBy} who approves wires approves or rejects it.`,
    amountCents: null,
  }));
}

// lib/deposits.ts: canceled deals' deposits still to decide, from the cancel.
async function depositDecisions(): Promise<RawRiskItem[]> {
  return (await openDepositDecisions()).map((closing): RawRiskItem => {
    const word = closing.depositProposal === "FORFEITED" ? "forfeit" : "refund";
    return {
      id: `DEPOSIT:${closing.id}`,
      kind: "DEPOSIT",
      title: closing.listing.title,
      detail: closing.waiting
        ? `A ${word} was proposed ${prettyDate(closing.depositProposedAt)}.`
        : closing.state === "REFUND_DUE"
          ? "Owed back to the buyer. No refund is proposed yet."
          : "Held. The rules allow a forfeit, which two desk members decide.",
      href: `/closings/${closing.id}#deposit`,
      openedAt: closing.canceledAt ?? closing.openedAt,
      ownerId: closing.deskOwnerId,
      resolver: "approveWires",
      next: closing.waiting
        ? `A desk member other than the one who proposed it approves the ${word}, or rejects it.`
        : `Propose the ${closing.state === "REFUND_DUE" ? "refund" : "forfeit or a refund"} with a note. A second desk member approves it.`,
      amountCents: closing.depositReceivedCents,
      amountLabel: "Deposit",
      listing: closing.listing,
    };
  });
}

// lib/payout-accounts.ts: broker fees owed, waiting for approval or for the second desk member to record them paid.
async function brokerFees(): Promise<RawRiskItem[]> {
  return (await owedBrokerFees()).map((fee): RawRiskItem => ({
    id: `BROKER_FEE:${fee.id}`,
    kind: "BROKER_FEE",
    title: `${fee.broker.name} · ${fee.closing.listing.title}`,
    detail: fee.approvedAt ? `Approved to a verified account ${prettyDate(fee.approvedAt)}.` : "Owed since the file closed. Not approved to an account yet.",
    href: "/admin/payouts",
    openedAt: fee.createdAt,
    ownerId: fee.closing.deskOwnerId,
    resolver: fee.approvedAt ? "closings" : "approveWires",
    next: fee.approvedAt
      ? "Once the money has gone, a desk member other than the approver records it paid."
      : "Approve it to a verified payout account of the broker's.",
    amountCents: fee.amountCents,
    amountLabel: "Fee",
    listing: fee.closing.listing,
  }));
}

// lib/duplicates.ts: approval holds for a loan that looks like one on another open listing, from the latest flag.
async function duplicateHolds(): Promise<RawRiskItem[]> {
  return (await openDuplicateHolds()).map((listing): RawRiskItem => ({
    id: `DUPLICATE:${listing.id}`,
    kind: "DUPLICATE",
    title: listing.title,
    detail: "A loan here looks like one on another open listing. Approval waits.",
    href: `/admin/listings/${listing.id}#duplicates`,
    openedAt: listing.flaggedAt,
    ownerId: listing.deskOwnerId,
    resolver: "sales",
    next: "Compare the loans and clear the match with a note, or decline the listing.",
    amountCents: null,
  }));
}

// lib/diligence-checklist.ts: the ASSIGNMENTS line missing on a listing in review, from its filing.
async function assignmentChains(): Promise<RawRiskItem[]> {
  return (await assignmentChainHolds()).map((listing): RawRiskItem => ({
    id: `ASSIGNMENTS:${listing.id}`,
    kind: "ASSIGNMENTS",
    title: listing.title,
    detail: listing.kind === "POOL"
      ? `${plural(listing.missing.length, "loan")} without an unbroken assignment chain to the seller.`
      : "No unbroken assignment chain from the originating lender to the seller.",
    href: `/admin/listings/${listing.id}#diligence`,
    openedAt: listing.submittedAt,
    ownerId: listing.deskOwnerId,
    resolver: "sales",
    next: "Record the missing assignments in the loan file, or compliance waives the item with a reason buyers read.",
    amountCents: null,
  }));
}

// lib/provenance.ts: a listing in review with no ownership statement, from its filing.
async function ownershipStatements(): Promise<RawRiskItem[]> {
  return (await statementHolds()).map((listing): RawRiskItem => {
    const who = listing.brokerId ? "broker" : "seller";
    return {
      id: `OWNERSHIP:${listing.id}`,
      kind: "OWNERSHIP",
      title: listing.title,
      detail: `Approval waits on the ${who}'s ownership statement.`,
      href: `/admin/listings/${listing.id}#availability`,
      openedAt: listing.submittedAt,
      ownerId: listing.deskOwnerId,
      resolver: "sales",
      next: `Ask the ${who} to give it on the listing's page. The desk can't give it for them.`,
      amountCents: null,
    };
  });
}

// lib/provenance.ts: a live listing paused until its seller confirms it, from the pause.
async function pausedListingItems(): Promise<RawRiskItem[]> {
  return (await pausedListings()).map((listing): RawRiskItem => ({
    id: `PAUSED:${listing.id}`,
    kind: "PAUSED",
    title: listing.title,
    detail: "Off the book and taking no new bids. Bids already in stay open.",
    href: `/admin/listings/${listing.id}#availability`,
    openedAt: listing.stalePausedAt,
    ownerId: listing.deskOwnerId,
    resolver: "sales",
    next: "Ask the seller to confirm the loans are still for sale, or confirm for them with a note saying how they told you.",
    amountCents: null,
  }));
}

// lib/covenants.ts: live bids that can't be awarded until the buyer acknowledges the covenants as they stand.
async function covenantAcks(): Promise<RawRiskItem[]> {
  return (await covenantAwardBlocks()).map((bid): RawRiskItem => ({
    id: `COVENANTS:${bid.id}`,
    kind: "COVENANTS",
    title: bid.listing.title,
    detail: `${bid.buyer.name}'s bid. ${bid.stale ? "The covenants changed after the buyer acknowledged them." : "The buyer hasn't acknowledged the covenants."}`,
    href: `/admin/offers#offer-${bid.id}`,
    openedAt: bid.createdAt,
    ownerId: bid.listing.deskOwnerId,
    resolver: "sales",
    next: "Ask the buyer to acknowledge them on the listing. The bid can't be awarded until then.",
    amountCents: cents(bid.amount),
    amountLabel: "Bid",
    listing: bid.listing,
  }));
}

// lib/custody.ts: custodian exceptions still open, from when they were recorded.
async function custodyExceptions(): Promise<RawRiskItem[]> {
  return (await openCustodyExceptions()).map((closing): RawRiskItem => ({
    id: `CUSTODY:${closing.id}`,
    kind: "CUSTODY",
    title: closing.listing.title,
    detail: closing.line,
    href: `/closings/${closing.id}#custody`,
    openedAt: closing.recordedAt,
    ownerId: closing.deskOwnerId,
    resolver: "closings",
    next: `The seller cures them with the custodian, then ${closing.deskBidId ? "the desk" : "the buyer side"} records them cleared. The post-closing file stays open until then.`,
    amountCents: null,
  }));
}

// lib/claims.ts: repurchase claims not yet closed, from filing.
async function repurchaseClaims(): Promise<RawRiskItem[]> {
  const queue = await deskClaimQueue();
  const open = [...queue.review, ...queue.waiting, ...queue.answered, ...queue.deskParty, ...queue.settling];
  const ids = [...new Set(open.map((claim) => claim.closingId))];
  const closings = ids.length
    ? await prisma.closing.findMany({ where: { id: { in: ids } }, select: { id: true, deskOwnerId: true, listing: { select: { bidMode: true, bidDeadline: true, status: true } } } })
    : [];
  const closingOf = new Map(closings.map((closing) => [closing.id, closing]));
  return open.map((claim): RawRiskItem => {
    const next = claim.deskParty
      ? "UPB is a party, so no desk member decides it. The two sides settle it, with counsel."
      : claim.status === "UNDER_REVIEW"
        ? "Decide it with a reason. Both sides read the decision."
        : claim.status === "FILED"
          ? `Waiting on the seller's answer, due ${prettyDate(claim.respondBy)}. With none by then, it comes to the desk.`
          : claim.status === "ANSWERED"
            ? "The seller answered. The buyer accepts it or asks the desk to review."
            : "Decided. Both sides confirm the settlement.";
    return {
      id: `CLAIM:${claim.id}`,
      kind: "CLAIM",
      title: claim.title,
      detail: `${claim.rep} · ${claim.buyer} against ${claim.seller} · ${statusLabel(claim.status, claim.deskParty)}`,
      href: `/closings/${claim.closingId}#claim-${claim.id}`,
      openedAt: claim.createdAt,
      ownerId: closingOf.get(claim.closingId)?.deskOwnerId ?? null,
      resolver: "compliance",
      next,
      amountCents: claim.amountCents ?? null,
      amountLabel: "Claimed",
      listing: closingOf.get(claim.closingId)?.listing ?? null,
    };
  });
}

// lib/account-deletion.ts: open deletion requests, with what stands in each one's way.
async function deletionRequests(): Promise<RawRiskItem[]> {
  const { open } = await deletionQueue();
  return open.map((request): RawRiskItem => ({
    id: `DELETION:${request.id}`,
    kind: "DELETION",
    title: request.user.name,
    detail: request.blockers.length ? `Blocked by ${request.blockers.join(", ")}.` : "Nothing stands in its way.",
    href: "/admin/compliance#deletion",
    openedAt: request.requestedAt,
    ownerId: null,
    resolver: "compliance",
    next: request.blockers.length
      ? "Each blocker has to finish first. Refuse with a note saying what to settle, or wait for it."
      : "Complete it, or refuse it with a note.",
    amountCents: null,
  }));
}

const READERS: (() => Promise<RawRiskItem[]>)[] = [
  sanctionReviews,
  payoutChecks,
  wireChanges,
  depositDecisions,
  brokerFees,
  duplicateHolds,
  assignmentChains,
  ownershipStatements,
  covenantAcks,
  custodyExceptions,
  repurchaseClaims,
  pausedListingItems,
  deletionRequests,
];

export async function loadRiskItems() {
  return (await Promise.all(READERS.map((read) => read()))).flat();
}

// ---------------------------------------------------------------------------------------------------------------
// The view: owners named, the wall applied, sorted.

export function sortRisk<T extends Pick<RiskItem, "id" | "kind" | "openedAt">>(items: T[]) {
  const time = (item: T) => item.openedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return [...items].sort((a, b) => RISK_KINDS[a.kind].tier - RISK_KINDS[b.kind].tier || time(a) - time(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// owners: the named deal owners who can still own deals (lib/staff.ts dealOwners), by id. An owner who has since left
// the desk names no one, so the item falls back to the role that resolves it.
export function riskView(raw: RawRiskItem[], viewer: Staff, owners: Map<string, string>, now = new Date()): RiskItem[] {
  return sortRisk(
    raw.map(({ ownerId, listing, ...item }) => {
      const sealed = item.amountCents != null && Boolean(listing) && deskWalled(listing!, viewer, now);
      return {
        ...item,
        owner: ownerId && owners.has(ownerId) ? { id: ownerId, name: owners.get(ownerId)! } : null,
        amountCents: sealed ? null : item.amountCents,
        sealed,
      };
    }),
  );
}

export async function riskQueue(viewer: Staff, options: { now?: Date } = {}) {
  const now = options.now ?? new Date();
  const [raw, owners] = await Promise.all([loadRiskItems(), dealOwners()]);
  return riskView(raw, viewer, new Map(owners.map((owner) => [owner.id, owner.name])), now);
}

export function ownerLabel(item: Pick<RiskItem, "owner" | "resolver">) {
  return item.owner?.name ?? RESOLVER_LABELS[item.resolver];
}

// Mine: items this desk member owns by name, and items no one owns that their role resolves.
export function isMine(item: Pick<RiskItem, "owner" | "resolver">, viewer: Staff & { id: string }) {
  return item.owner ? item.owner.id === viewer.id : deskCan(viewer, item.resolver);
}

export function filterRisk<T extends Pick<RiskItem, "kind" | "owner" | "resolver">>(items: T[], viewer: Staff & { id: string }, filter: { kind?: RiskKind | null; mine?: boolean }) {
  return items.filter((item) => (!filter.kind || item.kind === filter.kind) && (!filter.mine || isMine(item, viewer)));
}

export function riskCounts(items: Pick<RiskItem, "kind">[]) {
  const counts = Object.fromEntries(RISK_KIND_ORDER.map((kind) => [kind, 0])) as Record<RiskKind, number>;
  for (const item of items) counts[item.kind] += 1;
  return counts;
}

// How long it has waited, in words: hours under two days, then days.
export function riskAge(openedAt: Date | null, now = new Date()) {
  if (!openedAt) return "Date not on record";
  const hours = Math.max(0, (now.getTime() - openedAt.getTime()) / 3_600_000);
  if (hours < 1) return "Under an hour";
  if (hours < 48) return plural(Math.floor(hours), "hour");
  return plural(Math.floor(hours / 24), "day");
}
