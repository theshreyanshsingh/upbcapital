import { after } from "next/server";
import { audit } from "@/lib/audit";
import { notifyDesk } from "@/lib/email";
import { ofacBlocks, screenParties, screenParty, type Screen } from "@/lib/ofac";
import { prisma } from "@/lib/prisma";

type Target = { context: string; userId?: string | null; listingId?: string | null };

// A person's earlier decision on the same name and the same list entry carries forward. A new entry asks again.
async function recordScreen(name: string, screen: Screen, target: Target) {
  const base = {
    name,
    result: screen.result,
    provider: screen.provider,
    detail: screen.detail,
    context: target.context,
    userId: target.userId || undefined,
    listingId: target.listingId || undefined,
  };
  if (screen.result === "CLEAR") return prisma.ofacCheck.create({ data: base });
  const earlier = await prisma.ofacCheck.findMany({ where: { name, result: "REVIEW" }, orderBy: { createdAt: "desc" } });
  const decided = earlier.find((row) => (row.status === "CLEARED" || row.status === "CONFIRMED") && row.matched === screen.matched);
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

export const OFAC_HOLD_MESSAGE = "An OFAC review is open on this deal. Decide it under Compliance first.";
export const OFAC_DOWN_MESSAGE = "The sanctions list could not be read just now, so this cannot be approved yet. Try again in a few minutes.";
