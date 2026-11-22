import Link from "next/link";
import { OpenTasksCount } from "@/components/firm-workspace";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { money, num } from "@/lib/format";
import { openTaskCounts } from "@/lib/firm-workspace";
import { launchPending, launchTime } from "@/lib/launch-rules";
import { prisma } from "@/lib/prisma";
import { canSee, listingAccess } from "@/lib/private-listings";
import { isPro } from "@/lib/settings";

export const metadata = { title: "Favorites" };

export default async function FavoritesPage() {
  const user = await requireRole(["BUYER"]);
  const pro = isPro(user);
  // A saved listing since made private, or from a seller who excludes this buyer, drops off the list.
  const [saved, access] = await Promise.all([
    prisma.favorite.findMany({
      where: { userId: user.id },
      include: { listing: { include: { notes: true } } },
      orderBy: { createdAt: "desc" },
    }),
    listingAccess(user),
  ]);
  const favorites = saved.filter((favorite) => canSee(access, favorite.listing));
  // The firm's open diligence tasks on each, from its Firm notes tab (lib/firm-workspace.ts).
  const taskCounts = await openTaskCounts(user, favorites.map((favorite) => favorite.listingId));
  return (
    <div>
      <PageIntro eyebrow="Favorites" title="Paper you kept." />
      <div className="divide-y divide-border border border-border rounded-xl">
        {favorites.length === 0 && <p className="px-5 py-8 text-sm text-muted-foreground">Nothing saved. Mark a listing from the book.</p>}
        {favorites.map((favorite) => (
          <Link key={favorite.id} href={`/marketplace/${favorite.listingId}`} className="block px-5 py-5 hover:bg-muted/60">
            <p className="font-semibold tracking-tight text-3xl text-foreground">{favorite.listing.title}</p>
            {/* A coming-soon listing keeps its ask and place for the launch, as on the book. */}
            {launchPending(favorite.listing) && favorite.listing.launchAt ? (
              <p className="mt-1 text-sm text-muted-foreground">Coming soon · goes live {launchTime(favorite.listing.launchAt)}</p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                {favorite.listing.notes[0]?.city}, {favorite.listing.notes[0]?.state}
                {pro ? ` · ask ${money(favorite.listing.notes.reduce((sum, note) => sum + num(note.askingPrice), 0))}` : " · economics on Pro"}
              </p>
            )}
            <OpenTasksCount count={taskCounts.get(favorite.listingId)} className="mt-1 block" />
          </Link>
        ))}
      </div>
    </div>
  );
}
