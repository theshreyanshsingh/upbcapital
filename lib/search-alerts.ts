import { notify } from "@/lib/email";
import { filtersFromSaved, listingMatches } from "@/lib/filters";
import { prisma } from "@/lib/prisma";
import { isPro } from "@/lib/settings";

export async function alertMatchingSearches(listingId: string) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { notes: true } });
  if (!listing || listing.status !== "APPROVED") return;
  const searches = await prisma.savedSearch.findMany({ where: { alertEnabled: true }, include: { user: true } });
  // Every fact the book's filters read, so a saved view on a file flag or a ratio alerts the way it filters.
  const notes = listing.notes.map((note) => ({
    city: note.city,
    state: note.state,
    paymentStatus: note.paymentStatus,
    lienPosition: note.lienPosition,
    propertyType: note.propertyType,
    upb: Number(note.upb),
    askingPrice: Number(note.askingPrice),
    tradeStatus: note.tradeStatus,
    occupancy: note.occupancy,
    foreclosureStatus: note.foreclosureStatus,
    monthsDelinquent: note.monthsDelinquent,
    interestRate: Number(note.interestRate),
    monthlyPi: Number(note.monthlyPi),
    estimatedValue: Number(note.estimatedValue),
    modified: note.modified,
    bankruptcyChapter: note.bankruptcyChapter,
    bankruptcyFiledAt: note.bankruptcyFiledAt,
    hoaLien: note.hoaLien,
    taxDelinquent: note.taxDelinquent,
  }));
  for (const search of searches) {
    if (!isPro(search.user) || search.user.accountStatus !== "APPROVED") continue;
    if (!listingMatches({ kind: listing.kind, notes, status: listing.status, bidMode: listing.bidMode, bidDeadline: listing.bidDeadline }, filtersFromSaved(search.filters))) continue;
    await notify(
      search.user.email,
      `New paper matches “${search.name}”`,
      `${listing.title} just went live and matches your saved search. Open the book to underwrite it.`,
    );
  }
}
