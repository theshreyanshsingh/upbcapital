import type { Prisma } from "@prisma/client";
import { after } from "next/server";
import { audit } from "@/lib/audit";
import { notifyDesk } from "@/lib/email";
import { unset } from "@/lib/db-filters";
import { listVersion, ofacBlocks, ofacOpen, screenParties, screenParty, type Screen } from "@/lib/ofac";
import { prisma } from "@/lib/prisma";

type Target = { context: string; userId?: string | null; listingId?: string | null };

// The same party: the same account, or the same name on the same listing. A name alone is not a person, so
// two people who share one need two decisions. A screen with no party (a manual check) carries nothing.
export function partyScope(row: { userId?: string | null; listingId?: string | null }) {
  if (row.userId) return { userId: row.userId };
  if (row.listingId) return { listingId: row.listingId };
  return null;
}

// One review per party, name and list entry. A screen with no party is its own review.
export function reviewKey(row: { id: string; name: string; matched?: string | null; userId?: string | null; listingId?: string | null }) {
  const scope = partyScope(row);
  const party = scope ? ("userId" in scope ? `user:${scope.userId}` : `listing:${scope.listingId}`) : `check:${row.id}`;
  return `${party}|${row.name}|${row.matched ?? ""}`;
}

// REVIEW rows nobody has decided. Rows from before decisions existed have no status at all.
export const openReviewWhere: Prisma.OfacCheckWhereInput = { result: "REVIEW", OR: [{ status: { notIn: ["CLEARED", "CONFIRMED"] } }, ...unset("status").OR] };

// Every row a decision on this one covers: the same party's screens of this name against this entry.
export async function sameReviewIds(check: { id: string; name: string; matched?: string | null; userId?: string | null; listingId?: string | null }) {
  const scope = partyScope(check);
  const rows = scope ? await prisma.ofacCheck.findMany({ where: { name: check.name, result: "REVIEW", ...scope }, select: { id: true, matched: true } }) : [];
  return [...new Set([check.id, ...rows.filter((row) => (row.matched ?? "") === (check.matched ?? "")).map((row) => row.id)])];
}

// A party's earlier decision on the same name and the same list entry carries forward. A new entry asks again.
// An open review already on file is the answer, so screening again adds no row and no second email.
// Every row written names the copy of the list it ran against (lib/ofac.ts listVersion), so a screen can be
// shown later to have used the list as it stood that day.
async function recordScreen(name: string, screen: Screen, target: Target) {
  const base = {
    name,
    result: screen.result,
    provider: screen.provider,
    listVersion: screen.listVersion ?? listVersion({ provider: screen.provider, fetchedAt: null }),
    detail: screen.detail,
    context: target.context,
    userId: target.userId || undefined,
    listingId: target.listingId || undefined,
  };
  if (screen.result === "CLEAR") return prisma.ofacCheck.create({ data: base });
  const scope = partyScope(target);
  const earlier = scope ? await prisma.ofacCheck.findMany({ where: { name, result: "REVIEW", ...scope }, orderBy: { createdAt: "desc" } }) : [];
  const latest = earlier.find((row) => row.matched === screen.matched);
  if (latest && ofacOpen(latest)) return latest;
  const decided = latest && (latest.status === "CLEARED" || latest.status === "CONFIRMED") ? latest : undefined;
  const check = await prisma.ofacCheck.create({
    data: {
      ...base,
      matched: screen.matched,
      status: decided?.status ?? "OPEN",
      reviewedById: decided?.reviewedById ?? undefined,
      reviewedAt: decided?.reviewedAt ?? undefined,
      reviewNote: decided ? `Carried from the earlier decision: ${decided.reviewNote ?? ""}`.slice(0, 500) : undefined,
    },
  });
  if (check.status === "OPEN") {
    await notifyDesk(`OFAC review · ${name}`, `${target.context}: ${screen.detail} Decide it at /admin/compliance. Nothing was said to the party.`);
  }
  // A confirmed party showing up again is a new dealing with a blocked party, which counsel may have to report.
  if (check.status === "CONFIRMED") {
    await notifyDesk(
      `OFAC confirmed match screened again · ${name}`,
      `${target.context}: ${name} matches ${screen.matched}, which the desk confirmed earlier. The hold stands and nothing was said to the party. Call counsel, because a report can be due within 10 business days. To change the decision, reopen it at /admin/compliance.`,
    );
  }
  return check;
}

export async function screenAndRecord(name: string, target: Target) {
  const screen = await screenParty(name);
  const check = await recordScreen(name, screen, target);
  return { screen, check, unavailable: Boolean(screen.unavailable), blocked: ofacBlocks(check) || Boolean(screen.unavailable) };
}

// For screens that arrive with a request a person is waiting on. Every approval screens the same parties again
// and waits for the answer, so a signup or an upload need not wait on a list download.
export function screenInBackground(work: () => Promise<unknown>) {
  const run = () => work().catch((error) => console.error("[upb-ofac] background screen failed:", error));
  try {
    after(run);
  } catch {
    void run();
  }
}

export async function screenUser(userId: string, context: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { buyerProfile: true } });
  if (!user) return { unavailable: false };
  const names = new Set([user.name, user.companyName, user.buyerProfile?.entityName ?? ""].map((name) => name.trim()).filter(Boolean));
  let unavailable = false;
  for (const name of names) unavailable = (await screenAndRecord(name, { context, userId })).unavailable || unavailable;
  return { unavailable };
}

// Screens the seller, a broker's client, and every borrower on the listing against one copy of the list.
// A tape can hold 2,000 names, so only hits get their own row and the audit log carries the count.
export async function screenListing(listingId: string, actorId: string | null) {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    include: { seller: true, notes: { select: { borrowerName: true } } },
  });
  if (!listing) return { screened: 0, flagged: 0, unnamed: 0, unavailable: false };
  const sellerNames = new Set([listing.seller.name, listing.seller.companyName].map((name) => name.trim()).filter(Boolean));
  const clientSeller = listing.clientSellerName.trim();
  const borrowers = new Set(listing.notes.map((note) => note.borrowerName.trim()).filter(Boolean));
  const names = [...new Set([...sellerNames, clientSeller, ...borrowers].filter(Boolean))];
  const { source, screens } = await screenParties(names);
  let flagged = 0;
  for (const { name, screen } of screens) {
    if (screen.result !== "REVIEW") continue;
    flagged += 1;
    const party = sellerNames.has(name) ? "Seller" : name === clientSeller ? "Broker's client" : "Borrower";
    await recordScreen(name, screen, {
      context: `${party} on ${listing.title}`,
      listingId,
      userId: sellerNames.has(name) ? listing.sellerId : undefined,
    });
  }
  const unnamed = listing.notes.length - listing.notes.filter((note) => note.borrowerName.trim()).length;
  await audit(
    actorId,
    "OFAC_LISTING",
    "listing",
    listingId,
    source.unavailable ? "The sanctions list could not be read, so this listing was not screened." : `Screened ${names.length} names. ${flagged} flagged. ${unnamed} of ${listing.notes.length} loans have no borrower name to screen.`,
  );
  return { screened: names.length, flagged, unnamed, unavailable: source.unavailable };
}

// Any open or confirmed match on these parties. Filtered here because older rows have no status field at all.
export async function ofacHold(target: { userIds?: (string | null | undefined)[]; listingId?: string | null }) {
  const userIds = (target.userIds ?? []).filter((id): id is string => Boolean(id));
  const scopes = [...(userIds.length ? [{ userId: { in: userIds } }] : []), ...(target.listingId ? [{ listingId: target.listingId }] : [])];
  if (!scopes.length) return null;
  const rows = await prisma.ofacCheck.findMany({ where: { result: "REVIEW", OR: scopes }, orderBy: { createdAt: "desc" } });
  return rows.find(ofacBlocks) ?? null;
}

// Any open or confirmed match on these names, screened for this account. A payout account's holder name is screened
// under the account that owns it, so this reads the hold on that name alone.
export async function nameHold(userId: string, names: (string | null | undefined)[]) {
  const list = cleanNames(names);
  if (!list.length) return null;
  const rows = await prisma.ofacCheck.findMany({ where: { userId, result: "REVIEW", name: { in: list } }, orderBy: { createdAt: "desc" } });
  return rows.find(ofacBlocks) ?? null;
}

function cleanNames(names: (string | null | undefined)[]) {
  return [...new Set(names.map((name) => (name ?? "").trim()).filter(Boolean))];
}

// Why money or a sale can't go to this account's names now, or null. Earlier screens may be a year old, so like an
// approval it screens again against today's list and waits for the answer. A desk decision on the same name and
// list entry stands, a new entry asks again, and a list that can't be read stops it.
export async function freshScreenBlock(userId: string, names: (string | null | undefined)[], context: string, holdMessage = OFAC_HOLD_MESSAGE) {
  const list = cleanNames(names);
  if (await nameHold(userId, list)) return holdMessage;
  for (const name of list) {
    const screen = await screenParty(name);
    if (screen.unavailable) return OFAC_DOWN_MESSAGE;
    if (ofacBlocks(await recordScreen(name, screen, { context, userId }))) return holdMessage;
  }
  return null;
}

// The award's fresh screen: the winning buyer's name, and the vetted entity the papers will name, which is the
// buying entity on the bid or else the entity on the buyer's main file. Earlier holds on every party are read
// before this (ofacHold). Seats in a group and beneficial owners are not screened again here; they were screened
// when the desk approved their file.
export async function awardScreenBlock(bid: { buyerId: string; buyerEntityId?: string | null; buyer: { name: string }; listing: { title: string } }) {
  const entity = bid.buyerEntityId ? await prisma.buyerEntity.findUnique({ where: { id: bid.buyerEntityId }, select: { userId: true, name: true } }) : null;
  const file = entity ? null : await prisma.buyerProfile.findUnique({ where: { userId: bid.buyerId }, select: { entityName: true } });
  const vetted = entity?.userId === bid.buyerId ? entity.name : file?.entityName;
  return freshScreenBlock(bid.buyerId, [bid.buyer.name, vetted], `Award on ${bid.listing.title}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Investors in the desk's own capital have no account, and a screen row has no investor field, so their screens carry
// the investor's address in the context. Screens recorded before that read "Investor" alone and match on the name.

type InvestorParty = { name: string; email: string; entity: string };

export const LEGACY_INVESTOR_CONTEXT = "Investor";

export function investorContext(investor: Pick<InvestorParty, "email">) {
  return `Investor ${investor.email.trim().toLowerCase()}`;
}

function investorNames(investor: InvestorParty) {
  return [...new Set([investor.name, investor.entity].map((name) => name.trim()).filter(Boolean))];
}

function investorScreens(investor: InvestorParty, where: Prisma.OfacCheckWhereInput = {}) {
  return prisma.ofacCheck.findMany({
    where: { ...where, name: { in: investorNames(investor) }, context: { in: [investorContext(investor), LEGACY_INVESTOR_CONTEXT] } },
    orderBy: { createdAt: "desc" },
  });
}

export async function screenInvestor(investor: InvestorParty) {
  let unavailable = false;
  for (const name of investorNames(investor)) unavailable = (await screenAndRecord(name, { context: investorContext(investor) })).unavailable || unavailable;
  return { unavailable };
}

// Any open or confirmed match on this investor holds every allocation to them, until the desk clears it.
export async function investorHold(investor: InvestorParty) {
  if (!investorNames(investor).length) return null;
  const rows = await investorScreens(investor, { result: "REVIEW" });
  return rows.find(ofacBlocks) ?? null;
}

// Why money can't be allocated from this investor, or null. Like an approval, it screens again and waits, since the
// screen when the investor was added ran in the background. A desk decision on the same name and list entry stands,
// and a new entry asks again.
export async function investorAllocationBlock(investor: InvestorParty) {
  const reviews = await investorScreens(investor, { result: "REVIEW" });
  if (reviews.some(ofacBlocks)) return INVESTOR_HOLD_MESSAGE;
  for (const name of investorNames(investor)) {
    const screen = await screenParty(name);
    if (screen.unavailable) return OFAC_DOWN_MESSAGE;
    // Every review left on file here was cleared, or the check above would have stopped.
    if (screen.result === "REVIEW" && reviews.some((row) => row.name === name && (row.matched ?? "") === (screen.matched ?? ""))) continue;
    if ((await screenAndRecord(name, { context: investorContext(investor) })).blocked) return INVESTOR_HOLD_MESSAGE;
  }
  return null;
}

export const INVESTOR_HOLD_MESSAGE = "An OFAC match on this investor is open or confirmed. Check it under Compliance before allocating.";
export const OFAC_HOLD_MESSAGE = "An OFAC match on this deal is open or confirmed. Check it under Compliance first.";
export const OFAC_DOWN_MESSAGE = "The sanctions list could not be read just now, so this cannot be approved yet. Try again in a few minutes.";
