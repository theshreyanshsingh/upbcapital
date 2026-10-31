import Link from "next/link";
import { MarketingFooter, MarketingHeader } from "@/components/marketing";
import { getCurrentUser } from "@/lib/auth";
import { recordHit } from "@/lib/hits";
import { money, moneyCompact, num, pct } from "@/lib/format";
import { labelOf } from "@/lib/labels";
import { upbBucket } from "@/lib/strata";
import { noteMetrics } from "@/lib/metrics";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { ensureStories } from "@/lib/stories";
import { bpsToPercent } from "@/lib/money";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  await recordHit("/");
  const [user, settings, notes, liveCount, publicListings] = await Promise.all([
    getCurrentUser(),
    getSettings(),
    prisma.note.findMany({
      where: { listing: { status: { in: ["APPROVED", "PENDING"] } } },
      include: { listing: true },
    }),
    prisma.listing.count({ where: { status: { in: ["APPROVED", "PENDING"] } } }),
    prisma.listing.findMany({
      where: { status: { in: ["APPROVED", "PENDING"] } },
      include: { notes: true },
      orderBy: { approvedAt: "desc" },
      take: 6,
    }),
  ]);
  const upb = notes.reduce((sum, note) => sum + num(note.upb), 0);
  const states = new Set(notes.map((note) => note.state)).size;
  const featured = notes.find((note) => note.listing.kind === "SINGLE" && note.listing.status === "APPROVED") ?? notes[0];
  const featuredMetrics = featured
    ? noteMetrics({
        upb: num(featured.upb),
        askingPrice: num(featured.askingPrice),
        estimatedValue: num(featured.estimatedValue),
        monthlyPi: num(featured.monthlyPi),
        interestRate: num(featured.interestRate),
        paymentStatus: featured.paymentStatus,
      })
    : null;
  await ensureStories();
  // Rows labeled Placeholder came from an earlier seed. They never show here, and the journal page can delete them.
  const quotes = await prisma.testimonial.findMany({ where: { published: true, NOT: { role: { startsWith: "Placeholder" } } }, orderBy: { createdAt: "desc" }, take: 2 });
  const premium = bpsToPercent(settings.buyerPremiumBps);
  const commission = bpsToPercent(settings.sellerCommissionBps);

  return (
    <div className="relative">
      <MarketingHeader authed={Boolean(user)} />
      <main id="desk" className="relative z-10">
        <section className="mx-auto grid min-h-screen max-w-6xl items-center gap-16 px-5 pb-20 pt-32 lg:grid-cols-[1.15fr_0.85fr]">
          <div>
            <p className="eyebrow rise">Private market · Mortgage notes</p>
            <h1 className="rise mt-6 font-semibold tracking-tight text-6xl leading-[0.88] text-foreground sm:text-7xl lg:text-[6.4rem]" style={{ animationDelay: "80ms" }}>
              The paper,
              <span className="block italic text-foreground">priced in</span>
              daylight.
            </h1>
            <p className="rise mt-8 max-w-xl text-lg font-light leading-relaxed text-muted-foreground" style={{ animationDelay: "160ms" }}>
              UPB Capital is a South Florida desk for performing and non-performing mortgage notes. Sellers bring one loan or a whole tape. Buyers underwrite against unpaid principal balance, with the premium and the yield stated before anyone asks for the file.
            </p>
            <div className="rise mt-10 flex flex-wrap gap-3" style={{ animationDelay: "240ms" }}>
              <Button render={<Link href={user ? "/marketplace" : "/signup"} />} className="h-12 px-6 text-[13px] font-medium">
                {user ? "Enter the book" : "Request access"}
              </Button>
              <Button variant="outline" render={<Link href="/login" />} className="h-12 px-6 text-[13px] font-medium">
                Sign in
              </Button>
            </div>
            <dl className="rise mt-14 grid max-w-lg grid-cols-3 gap-6 border-t border-border pt-6" style={{ animationDelay: "320ms" }}>
              <Stat k="On the book" v={moneyCompact(upb)} />
              <Stat k="Live listings" v={String(liveCount)} />
              <Stat k="States" v={String(states)} />
            </dl>
          </div>
          {featured && featuredMetrics && (
            <div className="floaty relative">
              <div className="glass relative p-7 md:p-9">
                <span className="absolute left-3 top-3 size-3 border-l border-t border-link/70" />
                <span className="absolute right-3 top-3 size-3 border-r border-t border-link/70" />
                <span className="absolute bottom-3 left-3 size-3 border-b border-l border-link/70" />
                <span className="absolute bottom-3 right-3 size-3 border-b border-r border-link/70" />
                <p className="eyebrow">Live on the desk</p>
                <h2 className="mt-4 font-semibold tracking-tight text-4xl text-foreground">{featured.city}, {featured.state}</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  {labelOf("lien", featured.lienPosition)} lien · {labelOf("property", featured.propertyType)} · {labelOf("payment", featured.paymentStatus)}
                </p>
                <p className="mt-8 font-semibold tracking-tight text-7xl leading-none text-foreground">{pct(featuredMetrics.priceToUpb, 0)}</p>
                <p className="mt-2 text-[13px] font-medium text-muted-foreground">of unpaid principal</p>
                <div className="mt-8 grid grid-cols-3 gap-4 border-t border-border pt-5 text-sm">
                  <Mini k="LTV" v={pct(featuredMetrics.ltv)} />
                  <Mini k="Yield" v={featuredMetrics.currentYield == null ? "n/a" : pct(featuredMetrics.currentYield)} />
                  <Mini k="Ask" v={money(num(featured.askingPrice))} />
                </div>
                <p className="mt-6 text-xs leading-relaxed text-muted-foreground">Street address withheld. Buyer premium {premium.toFixed(2)}% sits on top of an accepted bid.</p>
              </div>
            </div>
          )}
        </section>

        <div className="overflow-hidden border-y border-border py-4">
          <div className="ticker-track flex w-[200%] gap-10 whitespace-nowrap text-[13px] font-medium text-muted-foreground">
            {Array.from({ length: 2 }).map((_, index) => (
              <span key={index}>Coral Gables · Fort Lauderdale · Tampa · Miami Beach · Sarasota · Savannah · Charlotte · Dallas · Naples · Boca Raton · </span>
            ))}
          </div>
        </div>

        <section id="book" className="mx-auto max-w-6xl px-5 py-24">
          <p className="eyebrow">The book</p>
          <h2 className="mt-3 max-w-xl font-semibold tracking-tight text-5xl text-foreground md:text-6xl">Three kinds of paper. One set of numbers.</h2>
          <div className="mt-12 grid gap-4 md:grid-cols-3">
            {[
              ["Performing", "Current loans, priced at a discount to UPB. Yield is the contractual payment against your basis."],
              ["Sub-performing", "Behind, but not abandoned. Delinquency, last paid, and the story sit next to the price."],
              ["Non-performing", "The bid is for the collateral and the process. Foreclosure status is on the card, not in a footnote."],
            ].map(([title, copy]) => (
              <article key={title} className="glass p-7">
                <h3 className="font-semibold tracking-tight text-3xl text-foreground">{title}</h3>
                <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{copy}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="sell" className="border-y border-border bg-card">
          <div className="mx-auto grid max-w-6xl gap-10 px-5 py-24 lg:grid-cols-2">
            <div>
              <p className="eyebrow">Sell side</p>
              <h2 className="mt-3 font-semibold tracking-tight text-5xl text-foreground">One note, or the whole tape.</h2>
            </div>
            <div className="grid gap-4">
              <article className="glass p-7">
                <h3 className="font-semibold tracking-tight text-3xl text-foreground">A guided note</h3>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Address, lien, UPB, rate, payment, delinquency, value, and ask. Upload the note, mortgage, pay history, BPO, and title. The desk reviews it before it is live.</p>
              </article>
              <article className="glass p-7">
                <h3 className="font-semibold tracking-tight text-3xl text-foreground">An institutional tape</h3>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Banks, funds, and servicers upload CSV or Excel, map columns to the note fields, and list a pool. A template is on the desk.</p>
              </article>
            </div>
          </div>
        </section>

        <section id="membership" className="mx-auto max-w-6xl px-5 py-24">
          <p className="eyebrow">Membership</p>
          <h2 className="mt-3 font-semibold tracking-tight text-5xl text-foreground">Free to look. Pro to underwrite.</h2>
          <div className="mt-12 grid gap-4 md:grid-cols-2">
            <article className="border border-border p-8 rounded-xl">
              <p className="eyebrow">Free</p>
              <p className="mt-4 font-semibold tracking-tight text-5xl text-foreground">$0</p>
              <ul className="mt-6 space-y-3 text-sm text-muted-foreground">
                <li>Approved buyers can browse a limited slice of the book.</li>
                <li>Balances, prices, and yields stay veiled.</li>
                <li>New listings are held for Pro during early access.</li>
              </ul>
            </article>
            <article className="glass p-8">
              <p className="eyebrow">Pro</p>
              <p className="mt-4 font-semibold tracking-tight text-5xl text-foreground">${(settings.proMonthlyPriceCents / 100).toLocaleString("en-US")}<span className="text-lg text-muted-foreground"> / month</span></p>
              <ul className="mt-6 space-y-3 text-sm text-muted-foreground">
                <li>Full metrics, including price to UPB, LTV, and yield.</li>
                <li>Data room after a signed confidentiality agreement.</li>
                <li>Early access to new listings and saved-search alerts.</li>
              </ul>
            </article>
          </div>
        </section>

        <section className="border-y border-border">
          <div className="mx-auto max-w-6xl px-5 py-24">
            <p className="eyebrow">How a trade clears</p>
            <ol className="mt-10 grid gap-6 md:grid-cols-4">
              {[
                ["01", "Submitted", "A seller files a note or a pool."],
                ["02", "Reviewed", "The desk approves, declines, or asks for changes."],
                ["03", "Live", "Approved buyers see it. Offers and questions come in."],
                ["04", "Closed", "Checklist, wires, then sold. Premium and commission post to the ledger."],
              ].map(([n, title, copy]) => (
                <li key={n}>
                  <p className="font-semibold tracking-tight text-4xl text-link">{n}</p>
                  <h3 className="mt-3 font-semibold tracking-tight text-2xl text-foreground">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{copy}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="fees" className="mx-auto max-w-6xl px-5 py-24">
          <p className="eyebrow">Economics, in the open</p>
          <h2 className="mt-3 max-w-2xl font-semibold tracking-tight text-5xl text-foreground">The desk is paid when paper trades, and when a buyer stays.</h2>
          <div className="mt-12 grid gap-4 md:grid-cols-3">
            <Fee n={`${premium.toFixed(2)}%`} title="Buyer premium" copy="Added on top of the accepted price. Shown on every listing and inside the offer." />
            <Fee n={`${commission.toFixed(2)}%`} title="Seller commission" copy="Deducted from the sale price. Shown while you list, and again on your desk." />
            <Fee n={`$${(settings.proMonthlyPriceCents / 100).toLocaleString("en-US")}`} title="Pro membership" copy="Monthly. Stripe in test mode when keys are set, otherwise a simulated checkout." />
          </div>
        </section>

        <section className="border-t border-border bg-card">
          <div className="mx-auto grid max-w-6xl gap-10 px-5 py-24 lg:grid-cols-[1.1fr_0.9fr] lg:items-end">
            <div>
              <p className="eyebrow">The desk</p>
              <h2 className="mt-3 font-semibold tracking-tight text-5xl leading-none text-foreground md:text-6xl">Founded by a South Florida investor, realtor, and general contractor.</h2>
            </div>
            <p className="text-base leading-relaxed text-muted-foreground">
              The file and the house get the same reading. Listings stay in review until the desk releases them. Borrower names never sit on the open book. This demo uses fictional loans, fictional people, and a ledger you can reset.
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-24">
          <p className="eyebrow">Open book</p>
          <h2 className="mt-3 font-semibold tracking-tight text-5xl text-foreground">Live paper, without the file.</h2>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {publicListings.map((listing) => {
              const note = listing.notes[0];
              if (!note) return null;
              const upb = listing.notes.reduce((sum, row) => sum + num(row.upb), 0);
              return (
                <Link key={listing.id} href={`/open/${listing.id}`} className="glass block p-6">
                  <p className="text-[13px] font-medium text-link">{note.city}, {note.state}</p>
                  <h3 className="mt-3 font-semibold tracking-tight text-3xl text-foreground">{listing.kind === "POOL" ? `${listing.notes.length} loans` : labelOf("payment", note.paymentStatus)}</h3>
                  <p className="mt-3 text-sm text-muted-foreground">{labelOf("lien", note.lienPosition)} · {upbBucket(listing.kind === "POOL" ? upb : num(note.upb))}</p>
                </Link>
              );
            })}
          </div>
        </section>

        {quotes.length > 0 && (
          <section className="mx-auto max-w-6xl px-5 pb-24">
            <p className="eyebrow">In their words</p>
            <h2 className="mt-3 font-semibold tracking-tight text-5xl text-foreground">From the desk&rsquo;s clients.</h2>
            <div className="mt-10 grid gap-4 md:grid-cols-2">
              {quotes.map((quote) => (
                <blockquote key={quote.id} className="border border-border p-6 rounded-xl">
                  <p className="font-semibold tracking-tight text-2xl leading-snug text-foreground">“{quote.quote}”</p>
                  <footer className="mt-4 text-[13px] font-medium text-muted-foreground">{quote.role}{quote.place ? ` · ${quote.place}` : ""}</footer>
                </blockquote>
              ))}
            </div>
          </section>
        )}
      </main>
      <MarketingFooter />
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{k}</dt>
      <dd className="mt-2 font-semibold tracking-tight text-3xl text-foreground">{v}</dd>
    </div>
  );
}

function Mini({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{k}</p>
      <p className="mt-1 text-foreground">{v}</p>
    </div>
  );
}

function Fee({ n, title, copy }: { n: string; title: string; copy: string }) {
  return (
    <article className="glass p-7">
      <p className="font-semibold tracking-tight text-5xl text-foreground">{n}</p>
      <h3 className="mt-4 font-semibold tracking-tight text-2xl text-foreground">{title}</h3>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{copy}</p>
    </article>
  );
}
