import { prisma } from "@/lib/prisma";

const LIMIT = 8;

export function searchTerm(raw: string) {
  return raw.replace(/\s+/g, " ").trim().slice(0, 80);
}

// Desk-wide lookup by name, email, company, title, borrower, or an exact record id.
export async function deskSearch(raw: string) {
  const term = searchTerm(raw);
  if (term.length < 2) return null;
  const text = { contains: term, mode: "insensitive" as const };
  const byId = /^c[a-z0-9]{20,}$/i.test(term) ? term : null;
  const [users, listings, borrowerNotes, closings, leads] = await Promise.all([
    prisma.user.findMany({
      where: { OR: [{ name: text }, { email: text }, { companyName: text }, ...(byId ? [{ id: byId }] : [])] },
      select: { id: true, name: true, email: true, companyName: true, role: true, accountStatus: true },
      take: LIMIT,
    }),
    prisma.listing.findMany({
      where: { OR: [{ title: text }, { clientSellerName: text }, ...(byId ? [{ id: byId }] : [])] },
      select: { id: true, title: true, status: true, kind: true },
      orderBy: { updatedAt: "desc" },
      take: LIMIT,
    }),
    prisma.note.findMany({
      where: { OR: [{ borrowerName: text }, { streetAddress: text }] },
      select: { listingId: true, borrowerName: true, city: true, state: true, listing: { select: { title: true, status: true } } },
      take: LIMIT,
    }),
    prisma.closing.findMany({
      where: { OR: [{ listing: { title: text } }, ...(byId ? [{ id: byId }] : [])] },
      select: { id: true, status: true, openedAt: true, listing: { select: { title: true } } },
      orderBy: { openedAt: "desc" },
      take: LIMIT,
    }),
    prisma.sellerLead.findMany({
      where: { OR: [{ name: text }, { email: text }] },
      select: { id: true, name: true, email: true, status: true },
      take: LIMIT,
    }),
  ]);
  return { term, users, listings, borrowerNotes, closings, leads, total: users.length + listings.length + borrowerNotes.length + closings.length + leads.length };
}
