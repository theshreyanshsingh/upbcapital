import Link from "next/link";
import { CalendarClock, Heart } from "lucide-react";
import { toggleFavorite } from "@/actions/buyer";
import { Button } from "@/components/ui/button";
import type { ComingSoonCard as Card } from "@/lib/launch-rules";

// A listing the desk approved with a launch time. It carries only the teaser's facts, so nothing here can show the
// ask or where the property is. Saving it signs the buyer up for the "now live" notice.
export function ComingSoonCard({ card, favorited, canFavorite }: { card: Card; favorited: boolean; canFavorite: boolean }) {
  return (
    <article className="glass relative flex h-full flex-col justify-between p-5 sm:p-6">
      <div>
        <div className="flex items-start justify-between gap-3">
          <p className="eyebrow">{card.states} · {card.lien}</p>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-link/10 px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap text-link">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
            Coming soon
          </span>
        </div>
        <h3 className="mt-3 pr-10 font-semibold tracking-tight text-lg text-foreground sm:mt-4">
          <Link href={`/marketplace/${card.id}`} className="after:absolute after:inset-0 after:rounded-[16px] after:content-['']">
            {card.title}
          </Link>
        </h3>
        <p className="mt-3 text-sm text-muted-foreground">
          {card.kind === "POOL" ? `Pool of ${card.loanCount} · ` : ""}{card.performance} · UPB {card.upbBand}
        </p>
      </div>
      <p className="mt-5 flex items-center gap-2 border-t border-border pt-4 text-[13px] font-medium text-foreground tabular-nums">
        <CalendarClock aria-hidden className="size-4 shrink-0 text-link" />
        <span>Goes live <time dateTime={card.launchAt}>{card.launchLabel}</time></span>
      </p>
      {canFavorite && (
        <form action={toggleFavorite} className="absolute top-12 right-3 z-10 sm:top-14 sm:right-4">
          <input type="hidden" name="listingId" value={card.id} />
          <Button type="submit" variant="ghost" size="icon" aria-label={favorited ? "Stop watching" : "Save and hear when it goes live"} className="bg-card">
            <Heart className={favorited ? "fill-link text-link" : "text-foreground"} />
          </Button>
        </form>
      )}
    </article>
  );
}

// The book's row of teasers, above the live listings.
export function ComingSoonSection({ cards, saved, canFavorite }: { cards: Card[]; saved: Set<string>; canFavorite: boolean }) {
  if (!cards.length) return null;
  return (
    <section aria-labelledby="coming-soon" className="mt-6">
      <h2 id="coming-soon" className="eyebrow">Coming soon</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Approved and dated. {canFavorite ? "Save one to hear the moment it goes live. " : ""}The data room, the confidentiality agreement and bids open at the launch time.
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => (
          <ComingSoonCard key={card.id} card={card} favorited={saved.has(card.id)} canFavorite={canFavorite} />
        ))}
      </div>
    </section>
  );
}
