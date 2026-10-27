import Link from "next/link";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { money, num } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { isPro } from "@/lib/settings";

export const metadata = { title: "Favorites" };

export default async function FavoritesPage() {
  const user = await requireRole(["BUYER"]);
  const pro = isPro(user);
  const favorites = await prisma.favorite.findMany({
    where: { userId: user.id },
    include: { listing: { include: { notes: true } } },
    orderBy: { createdAt: "desc" },
  });
  return (
    <div>
      <PageIntro eyebrow="Favorites" title="Paper you kept." />
      <div className="divide-y divide-border border border-border rounded-xl">
        {favorites.length === 0 && <p className="px-5 py-8 text-sm text-muted-foreground">Nothing saved. Mark a listing from the book.</p>}
        {favorites.map((favorite) => (
          <Link key={favorite.id} href={`/marketplace/${favorite.listingId}`} className="block px-5 py-5 hover:bg-muted/60">
            <p className="font-semibold tracking-tight text-3xl text-foreground">{favorite.listing.title}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {favorite.listing.notes[0]?.city}, {favorite.listing.notes[0]?.state}
              {pro ? ` · ask ${money(favorite.listing.notes.reduce((sum, note) => sum + num(note.askingPrice), 0))}` : " · economics on Pro"}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
