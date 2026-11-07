import { prisma } from "@/lib/prisma";

// Sellers and brokers see bidders as "Bidder A", "Bidder B" and so on until a bid is awarded, so a seller can't
// pick a buyer by name or shop the field. Letters follow each buyer's first NDA or inquiry on the listing, which
// never moves, so a bidder keeps one letter for the life of the listing. The desk always sees real names, and an
// awarded buyer shows by name, as the closing does.

// 0 is A, 25 is Z, 26 is AA: spreadsheet columns, so a crowded room never runs out of letters.
export function aliasAt(index: number) {
  let n = Math.max(0, Math.floor(index)) + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return `Bidder ${letters}`;
}

// Each buyer's earliest event decides their place. A tie breaks on the id, so two reads always agree.
export function orderBidders(events: { userId: string; at: Date }[], exclude: Iterable<string> = []) {
  const skip = new Set(exclude);
  const first = new Map<string, number>();
  for (const event of events) {
    if (skip.has(event.userId)) continue;
    const at = event.at.getTime();
    const seen = first.get(event.userId);
    if (seen == null || at < seen) first.set(event.userId, at);
  }
  const order = [...first.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return new Map(order.map(([userId], index) => [userId, aliasAt(index)]));
}

export async function bidderAliases(listingId: string) {
  const [listing, ndas, inquiries] = await Promise.all([
    prisma.listing.findUnique({ where: { id: listingId }, select: { sellerId: true, brokerId: true } }),
    prisma.ndaAcknowledgment.findMany({ where: { listingId }, select: { userId: true, acknowledgedAt: true } }),
    prisma.inquiry.findMany({ where: { listingId }, select: { buyerId: true, createdAt: true } }),
  ]);
  if (!listing) return new Map<string, string>();
  return orderBidders(
    [...ndas.map((nda) => ({ userId: nda.userId, at: nda.acknowledgedAt })), ...inquiries.map((inquiry) => ({ userId: inquiry.buyerId, at: inquiry.createdAt }))],
    [listing.sellerId, ...(listing.brokerId ? [listing.brokerId] : [])],
  );
}

export async function bidderAlias(listingId: string, userId: string) {
  return (await bidderAliases(listingId)).get(userId) ?? "A bidder";
}

type Named = { id: string; name: string; companyName?: string | null };

export function realName(buyer: { name: string; companyName?: string | null }) {
  return buyer.companyName || buyer.name;
}

// What one viewer calls the bidders on one listing. The desk sees names. A seller or broker sees the alias, except
// for a buyer already awarded something on the listing, whom the closing names anyway.
export async function bidderNamer(listingId: string, viewer: { role: string }) {
  if (viewer.role === "ADMIN") return (buyer: Named) => realName(buyer);
  const [aliases, awarded] = await Promise.all([
    bidderAliases(listingId),
    prisma.inquiry.findMany({ where: { listingId, status: "ACCEPTED" }, select: { buyerId: true } }),
  ]);
  const named = new Set(awarded.map((row) => row.buyerId));
  return (buyer: Named) => (named.has(buyer.id) ? realName(buyer) : aliases.get(buyer.id) ?? "A bidder");
}

type Person = { id: string; name: string; companyName?: string | null; role: string };

// The names on listing threads. On a listing the viewer sells or brokered, a bidder shows by letter, as on the
// listing page; everywhere else, and for the desk, people show by name.
export async function threadNamer(viewer: { id: string; role: string }, listingIds: (string | null)[]) {
  const ids = [...new Set(listingIds.filter((id): id is string => Boolean(id)))];
  const plain = (_listingId: string | null, person: Person) => person.name;
  if (viewer.role === "ADMIN" || !ids.length) return plain;
  const owned = await prisma.listing.findMany({ where: { id: { in: ids }, OR: [{ sellerId: viewer.id }, { brokerId: viewer.id }] }, select: { id: true } });
  if (!owned.length) return plain;
  const namers = new Map(await Promise.all(owned.map(async (listing) => [listing.id, await bidderNamer(listing.id, viewer)] as const)));
  return (listingId: string | null, person: Person) => {
    const namer = listingId ? namers.get(listingId) : undefined;
    return namer && person.role === "BUYER" && person.id !== viewer.id ? namer(person) : person.name;
  };
}
