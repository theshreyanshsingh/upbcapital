import { notify } from "@/lib/email";
import { money } from "@/lib/format";
import { docLabel } from "@/lib/labels";
import { launchPending } from "@/lib/launch-rules";
import { prisma } from "@/lib/prisma";

// Buyers who saved a listing hear when something they would act on changes: a new price, a buy-it-now price, a
// deadline, a withdrawal, new files in the data room, or a published answer. Each notice says what changed and links
// to the listing, never who bid or at what price.

export type WatchEvent = "REPRICE" | "BUY_NOW" | "DEADLINE" | "WITHDRAWN" | "NEW_FILES" | "ANSWER" | "SALE_EVENT" | "LAUNCH";

export function watchesOn(user: { watchAlerts?: boolean | null; accountStatus: string }) {
  return user.accountStatus === "APPROVED" && user.watchAlerts !== false;
}

export function watchLink(listingId: string, appUrl = process.env.NEXT_PUBLIC_APP_URL || "") {
  return `${appUrl}/marketplace/${listingId}`;
}

// Tells every watcher of a listing, once each, skipping anyone in `except` (the person who made the change, or
// bidders who already heard through their own bid). Returns how many were told.
export async function notifyWatchers(input: { listingId: string; event: WatchEvent; subject: string; body: string; except?: string[] }) {
  const listing = await prisma.listing.findUnique({ where: { id: input.listingId }, select: { id: true, sellerId: true, brokerId: true, launchAt: true } });
  if (!listing) return 0;
  // A coming-soon listing hides its price and file, so watchers hear only about its launch (it went live, or the
  // date moved), or that it was withdrawn.
  if (launchPending(listing) && input.event !== "WITHDRAWN" && input.event !== "LAUNCH") return 0;
  const skip = new Set([listing.sellerId, ...(listing.brokerId ? [listing.brokerId] : []), ...(input.except ?? [])]);
  const watchers = await prisma.favorite.findMany({
    where: { listingId: input.listingId },
    include: { user: { select: { id: true, email: true, role: true, accountStatus: true, watchAlerts: true } } },
  });
  let told = 0;
  for (const { user } of watchers) {
    if (skip.has(user.id) || user.role !== "BUYER" || !watchesOn(user)) continue;
    skip.add(user.id);
    await notify(user.email, input.subject, `${input.body}\n\nOpen the listing: ${watchLink(input.listingId)}`, { category: "watch", userId: user.id });
    told += 1;
  }
  return told;
}

// A live listing's ask moved, whoever moved it. Watchers hear the old and new total for the loans that changed, which
// the book already shows them. A save that leaves the price where it was tells nobody.
export async function watchReprice(input: { listingId: string; before: number; after: number; loans: number; actorId: string }) {
  if (input.loans < 1 || Math.round(input.before * 100) === Math.round(input.after * 100)) return 0;
  const listing = await prisma.listing.findUnique({ where: { id: input.listingId }, select: { title: true, status: true } });
  if (!listing || listing.status !== "APPROVED") return 0;
  const which = input.loans === 1 ? "The ask" : `The ask on ${input.loans} loans`;
  return notifyWatchers({
    listingId: input.listingId,
    event: "REPRICE",
    subject: `New price · ${listing.title}`,
    body: `${listing.title}, a listing you saved, has a new price. ${which} moved ${input.after < input.before ? "down" : "up"} from ${money(input.before)} to ${money(input.after)}.`,
    except: [input.actorId],
  });
}

// New diligence in a live listing's data room. The notice names the kind of file, never its name, since a loan's own
// file can carry the street or the borrower.
export async function watchNewFiles(input: { listingId: string; types: string[]; actorId: string | null }) {
  if (!input.types.length) return 0;
  const listing = await prisma.listing.findUnique({ where: { id: input.listingId }, select: { title: true, status: true } });
  if (!listing || listing.status !== "APPROVED") return 0;
  const kinds = [...new Set(input.types.map((type) => docLabel(type)))];
  const what = input.types.length === 1 ? `A new file is in the data room: ${kinds[0]}.` : `${input.types.length} new files are in the data room: ${kinds.join(", ")}.`;
  return notifyWatchers({
    listingId: input.listingId,
    event: "NEW_FILES",
    subject: `New files · ${listing.title}`,
    body: `${listing.title}, a listing you saved, has new diligence. ${what}`,
    except: input.actorId ? [input.actorId] : [],
  });
}
