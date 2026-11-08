import Link from "next/link";
import { ArrowRight, BadgeCheck, CalendarClock, Eye, FileSearch, Lock, ShieldCheck } from "lucide-react";
import { MarketingFooter, MarketingHeader } from "@/components/marketing";
import { getCurrentUser } from "@/lib/auth";
import { recordHit } from "@/lib/hits";
import { money, moneyCompact, num, pct } from "@/lib/format";
import { labelOf } from "@/lib/labels";
import { upbBucket } from "@/lib/strata";
import { noteMetrics } from "@/lib/metrics";
import { prisma } from "@/lib/prisma";
import { publicListing } from "@/lib/private-listings";
import { getSettings } from "@/lib/settings";
import { ensureStories } from "@/lib/stories";
import { bpsToPercent } from "@/lib/money";

export const dynamic = "force-dynamic";

const solid = "inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-primary px-6 text-[15px] font-medium text-primary-foreground shadow-card transition-colors hover:bg-primary/88";
const outline = "inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-border bg-card px-6 text-[15px] font-medium text-foreground shadow-card transition-colors hover:bg-hover";
// Section headlines share the display serif; the desk's own pages use it only for their titles.
const sectionHead = "mt-3 font-display text-[2.375rem] font-medium leading-[1.08] tracking-[-0.02em] text-foreground md:text-[3.25rem]";

export default async function HomePage() {
  await recordHit("/");
  const [user, settings, notes, liveCount, publicListings] = await Promise.all([
    getCurrentUser(),
    getSettings(),
    // Private listings stay off the public page: its cards, counts and totals are the open book's (lib/private-listings.ts).
    prisma.note.findMany({
      where: { listing: { status: { in: ["APPROVED", "PENDING"] }, AND: [publicListing()] } },
      include: { listing: true },
    }),
    prisma.listing.count({ where: { status: { in: ["APPROVED", "PENDING"] }, AND: [publicListing()] } }),
    prisma.listing.findMany({
      where: { status: { in: ["APPROVED", "PENDING"] }, AND: [publicListing()] },
      include: { notes: true },
      orderBy: { approvedAt: "desc" },
      take: 6,
    }),
  ]);
  const upb = notes.reduce((sum, note) => sum + num(note.upb), 0);
  const states = new Set(notes.map((note) => note.state)).size;
  const single = notes.filter((note) => note.listing.kind === "SINGLE" && note.listing.status === "APPROVED");
  // A performing note shows a yield, so it makes the clearer example.
  const featured = single.find((note) => note.paymentStatus === "PERFORMING") ?? single[0] ?? notes[0];
  const ask = featured ? num(featured.askingPrice) : 78000;
  // Sample bids sit around the featured ask, so the illustration never shows a bid that makes no sense for the price.
  const sample = [1.03, 0.99, 1.07].map((factor) => money(Math.round((ask * factor) / 250) * 250));
  const metrics = featured
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
  const pro = (settings.proMonthlyPriceCents / 100).toLocaleString("en-US");
  const browse = user ? "/marketplace" : "/signup";

  return (
    <div className="relative overflow-x-clip">
      <MarketingHeader authed={Boolean(user)} />
      <main id="desk" className="relative z-10">
        <section className="relative">
          <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-5 pb-16 pt-32 md:pt-40 lg:grid-cols-[1.05fr_0.95fr] lg:pb-24">
            <div>
              <p className="rise inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 type-label font-medium text-muted-foreground shadow-card">
                <span className="size-1.5 rounded-full bg-good" /> The private desk for mortgage notes
              </p>
              <h1 className="rise rise-1 mt-7 font-display text-[3.5rem] font-medium leading-[0.96] tracking-[-0.03em] text-foreground sm:text-7xl lg:text-[5.75rem]">
                Paper in.
                <span className="block text-link">Wire out.</span>
              </h1>
              <p className="rise rise-2 mt-7 max-w-xl text-[1.1875rem] leading-relaxed text-pretty text-muted-foreground">
                List one mortgage note or a full tape. A person reviews every file, buyers prove their funds before they bid, and every closing runs on a dated checklist until it&rsquo;s done.
              </p>
              <div className="rise rise-3 mt-9 flex flex-wrap gap-3">
                <Link href="/sell" className={solid}>Sell a note <ArrowRight className="size-4" /></Link>
                <Link href={browse} className={outline}>{user ? "Open the book" : "Browse as a buyer"}</Link>
              </div>
              <p className="rise rise-4 mt-4 type-label text-muted-foreground">Free to list. Sellers pay only when the note sells.</p>
              <ul className="rise rise-4 mt-10 grid gap-3 text-sm text-foreground sm:grid-cols-3">
                <Proof icon={<FileSearch className="size-4" />} text="Every file read by a person" />
                <Proof icon={<BadgeCheck className="size-4" />} text="Buyers show funds first" />
                <Proof icon={<ShieldCheck className="size-4" />} text="Every party OFAC-screened" />
              </ul>
            </div>
            <DeskPreview
              place={featured ? `${featured.city}, ${featured.state}` : "Tampa, FL"}
              detail={featured ? `${labelOf("lien", featured.lienPosition)} lien · ${labelOf("payment", featured.paymentStatus)}` : "First lien · Performing"}
              ofUpb={metrics ? pct(metrics.priceToUpb, 0) : "78%"}
              ltv={metrics ? pct(metrics.ltv) : "52.0%"}
              yieldPct={metrics?.currentYield == null ? "n/a" : pct(metrics.currentYield)}
              ask={money(ask)}
              bids={sample}
              live={Boolean(featured)}
            />
          </div>
        </section>

        {liveCount > 0 && (
          <section aria-label="The book today" className="border-y border-border bg-card">
            <dl className="mx-auto grid max-w-6xl grid-cols-3 divide-x divide-border px-5">
              <Figure k="UPB on the book" v={moneyCompact(upb)} />
              <Figure k="Live listings" v={String(liveCount)} />
              <Figure k="States" v={String(states)} />
            </dl>
          </section>
        )}

        <section id="how" className="mx-auto max-w-6xl scroll-mt-24 px-5 py-24">
          <p className="eyebrow">How it works</p>
          <h2 className={`${sectionHead} max-w-2xl`}>Two sides of the trade. One desk keeping it honest.</h2>
          <div className="mt-12 grid gap-5 lg:grid-cols-2">
            <Track
              label="If you're selling"
              cta={{ href: "/sell", text: "Get a quote on your note" }}
              steps={[
                ["List it in minutes", "One note through a guided form, or a whole tape from CSV or Excel with your columns mapped for you."],
                ["The desk reads it", "A person checks the note, the pay history, and the numbers before any buyer sees a thing. Gaps come back to you, not to the market."],
                ["It finds its buyers", "The desk sends it to buyers whose buy box fits. You watch opens, NDAs, saves, and bids come in."],
                ["You close on a clock", "A dated checklist, your net shown up front, and a settlement statement when the wire goes out."],
              ]}
            />
            <Track
              label="If you're buying"
              cta={{ href: browse, text: user ? "Open the book" : "Request buyer access" }}
              steps={[
                ["Set your buy box", "States, lien, performance, balance, price to UPB, target yield. New paper that fits comes to you."],
                ["Underwrite in daylight", "Pro puts price to UPB, LTV, yield, and a value estimate on every listing. Sign the NDA and the address and file open up."],
                ["Bid your way", "Open offers, sealed rounds, or one best-and-final. Sealed amounts stay hidden, even from the seller, until the deadline."],
                ["Close without chasing", "Purchase agreement, assignment, and allonge drafted from the deal, plus a boarding package ready for your servicer."],
              ]}
            />
          </div>
        </section>

        <section className="border-y border-border bg-card">
          <div className="mx-auto max-w-6xl px-5 py-24">
            <p className="eyebrow">Why a desk</p>
            <h2 className={`${sectionHead} max-w-2xl`}>Bulletin boards list notes. A desk gets them closed.</h2>
            <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              <Feature icon={<FileSearch className="size-5" />} title="A person reads every file" copy="Nothing goes live until the desk has checked it. Thin files get sent back with notes instead of published and hoped for." />
              <Feature icon={<BadgeCheck className="size-5" />} title="Bidders who can actually close" copy="Buyers file an entity and proof of funds before they bid. The bid sheet checks every all-in against verified funds and each buyer's record." />
              <Feature icon={<ShieldCheck className="size-5" />} title="Screened before anyone signs" copy="Sellers, buyers, and every named borrower on a tape are checked against Treasury's SDN list. A possible match holds the deal until the desk decides it." />
              <Feature icon={<Lock className="size-5" />} title="Sealed when it should be" copy="Run the book open, sealed, or best-and-final. Sealed amounts stay with the desk until the clock runs out." />
              <Feature icon={<CalendarClock className="size-5" />} title="Closings with a deadline" copy="Every step has a due date and an owner. Late steps get chased daily, and both sides get a settlement statement with the wires on it." />
              <Feature icon={<Eye className="size-5" />} title="See who's looking" copy="Sellers see opens, NDAs, saves, and bids on their listing as they come in. No guessing whether anyone cares." />
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-24">
          <div className="grid gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
            <div>
              <p className="eyebrow">The paper</p>
              <h2 className={sectionHead}>Performing, sub, or non. Same honest numbers.</h2>
              <p className="mt-5 text-base leading-relaxed text-muted-foreground">Everything is priced against unpaid principal balance, so a buyer can compare a current first in Tampa with a defaulted second in Charlotte on one scale.</p>
            </div>
            <div className="grid gap-3">
              {[
                // The bar takes the status colour each kind of paper wears on the desk.
                ["Performing", "Current loans at a discount to UPB. Yield is the contractual payment against your price, stated before you ask.", "bg-good"],
                ["Sub-performing", "Behind, not abandoned. Months delinquent and last paid date sit right next to the price.", "bg-warn"],
                ["Non-performing", "You're buying the collateral and the process. Foreclosure status is on the card, not buried in a footnote.", "bg-bad"],
              ].map(([title, copy, tone]) => (
                <article key={title} className="glass flex gap-5 p-6">
                  <span aria-hidden className={`mt-1 h-10 w-1 shrink-0 rounded-full ${tone}`} />
                  <div>
                    <h3 className="text-xl font-semibold tracking-tight text-foreground">{title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{copy}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="border-y border-border bg-card">
          <div className="mx-auto grid max-w-6xl gap-10 px-5 py-20 lg:grid-cols-2 lg:items-center">
            <div>
              <p className="eyebrow">Banks, funds, and servicers</p>
              <h2 className={sectionHead}>Bring the whole tape.</h2>
            </div>
            <ul className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-2">
              <li className="glass p-5"><strong className="block text-foreground">Your columns, mapped for you</strong>Upload CSV or Excel. Headers are matched to the desk&rsquo;s fields, and you confirm.</li>
              <li className="glass p-5"><strong className="block text-foreground">Data checks before buyers</strong>Missing balances, LTVs over 100%, odd coupons, and ZIPs in the wrong state get flagged at upload.</li>
              <li className="glass p-5"><strong className="block text-foreground">Loan-level bids</strong>Buyers can bid the pool or single loans inside it.</li>
              <li className="glass p-5"><strong className="block text-foreground">An API if you want one</strong>File tapes by API and hear about every offer through signed webhooks.</li>
            </ul>
          </div>
        </section>

        <section id="pricing" className="mx-auto max-w-6xl scroll-mt-24 px-5 py-24">
          <p className="eyebrow">Pricing</p>
          <h2 className={`${sectionHead} max-w-2xl`}>Sellers pay when it trades. Buyers pay for the edge.</h2>
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Price n="$0" title="To list" copy="Listing and the desk review cost nothing. No upfront fees, no monthly fee for sellers." />
            <Price n={`${commission.toFixed(2)}%`} title="Seller commission" copy="Only when it sells. Taken from the price, and shown before you list." />
            <Price n={`${premium.toFixed(2)}%`} title="Buyer premium" copy="On top of the accepted price. Printed on every listing and every bid." />
            <Price n={`$${pro}`} unit="/mo" title="Buyer Pro" copy="Full metrics on every listing, data rooms after NDA, and first look at new paper." highlight />
          </div>
        </section>

        <section className="border-y border-border bg-card">
          <div className="mx-auto grid max-w-6xl gap-10 px-5 py-20 lg:grid-cols-[1.1fr_0.9fr] lg:items-end">
            <div>
              <p className="eyebrow">Who runs the desk</p>
              <h2 className={sectionHead}>Founded by a South Florida investor, realtor, and general contractor.</h2>
            </div>
            <p className="text-base leading-relaxed text-muted-foreground">
              So the file and the house get the same hard read. Listings stay in review until the desk releases them, and borrower names never sit on the open book.
            </p>
          </div>
        </section>

        {publicListings.length > 0 && (
          <section id="book" className="mx-auto max-w-6xl scroll-mt-24 px-5 py-24">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="eyebrow">On the book now</p>
                <h2 className={sectionHead}>Live paper, file held back.</h2>
              </div>
              <Link href={browse} className="inline-flex min-h-11 items-center gap-1 text-[15px] font-medium text-link underline-offset-4 hover:underline sm:min-h-0">See the full book <ArrowRight className="size-4" /></Link>
            </div>
            <div className="mt-10 grid gap-4 md:grid-cols-3">
              {publicListings.map((listing) => {
                const note = listing.notes[0];
                if (!note) return null;
                const balance = listing.notes.reduce((sum, row) => sum + num(row.upb), 0);
                return (
                  <Link key={listing.id} href={`/open/${listing.id}`} className="glass group block p-6 transition-[translate,box-shadow] duration-(--dur-2) ease-(--ease-standard) hover:-translate-y-0.5 hover:shadow-float">
                    <p className="type-label font-medium text-link">{note.city}, {note.state}</p>
                    <h3 className="mt-3 font-display text-[1.625rem] leading-tight font-medium tracking-[-0.015em] text-foreground">{listing.kind === "POOL" ? `${listing.notes.length} loans` : labelOf("payment", note.paymentStatus)}</h3>
                    <p className="mt-3 text-sm text-muted-foreground">{labelOf("lien", note.lienPosition)} lien · {upbBucket(listing.kind === "POOL" ? balance : num(note.upb))}</p>
                    <p className="mt-5 inline-flex items-center gap-1 type-label font-medium text-muted-foreground transition-colors group-hover:text-foreground">Preview <ArrowRight className="size-3.5" /></p>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        {quotes.length > 0 && (
          <section className="mx-auto max-w-6xl px-5 pb-24">
            <p className="eyebrow">In their words</p>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              {quotes.map((quote) => (
                <blockquote key={quote.id} className="glass p-7">
                  <p className="font-display text-[1.375rem] leading-snug tracking-[-0.01em] text-pretty text-foreground">&ldquo;{quote.quote}&rdquo;</p>
                  <footer className="mt-4 type-label font-medium text-muted-foreground">{quote.role}{quote.place ? ` · ${quote.place}` : ""}</footer>
                </blockquote>
              ))}
            </div>
          </section>
        )}

        <section className="px-5 pb-24">
          <div className="mx-auto max-w-6xl overflow-hidden rounded-3xl bg-primary px-8 py-16 text-primary-foreground shadow-float md:px-14">
            <div className="grid gap-8 lg:grid-cols-[1.3fr_0.7fr] lg:items-center">
              <div>
                <h2 className="font-display text-[2.375rem] font-medium leading-[1.08] tracking-[-0.02em] md:text-[3.25rem]">Holding a note you&rsquo;d rather hold cash?</h2>
                <p className="mt-4 max-w-xl text-base leading-relaxed opacity-75">Tell the desk about it. Get a quote back, and if you list, get in front of buyers who&rsquo;ve already shown they can close.</p>
              </div>
              <div className="flex flex-wrap gap-3 lg:justify-end">
                <Link href="/sell" className="inline-flex h-12 items-center gap-2 rounded-xl bg-primary-foreground px-6 text-[15px] font-medium text-primary transition-opacity hover:opacity-90">Get a quote <ArrowRight className="size-4" /></Link>
                <Link href={browse} className="inline-flex h-12 items-center rounded-xl border border-primary-foreground/30 px-6 text-[15px] font-medium transition-colors hover:bg-primary-foreground/10">I&rsquo;m a buyer</Link>
              </div>
            </div>
          </div>
        </section>
      </main>
      <MarketingFooter />
    </div>
  );
}

// The desk's own view of a trade: the live listing on top, with a sample bid sheet and closing clock behind it.
function DeskPreview({ place, detail, ofUpb, ltv, yieldPct, ask, bids, live }: { place: string; detail: string; ofUpb: string; ltv: string; yieldPct: string; ask: string; bids: string[]; live: boolean }) {
  return (
    <figure className="rise rise-2 relative mx-auto w-full max-w-md lg:max-w-none">
      <div className="relative lg:pl-10">
        <div className="glass relative z-10 p-6 shadow-[var(--shadow)] md:p-7">
          <div className="flex items-center justify-between">
            <p className="type-label font-medium text-muted-foreground">{live ? "Live on the desk" : "Sample listing"}</p>
            <span className="rounded-full bg-good/12 px-2.5 py-0.5 text-xs font-medium text-good">Reviewed</span>
          </div>
          <p className="mt-4 font-display text-[2rem] leading-tight font-medium tracking-[-0.015em] text-foreground">{place}</p>
          <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
          <p className="figure mt-6 text-6xl font-semibold leading-none tracking-[-0.035em] text-foreground">{ofUpb}</p>
          <p className="mt-2 type-label text-muted-foreground">of unpaid principal</p>
          <div className="mt-6 grid grid-cols-3 gap-4 border-t border-border pt-4 text-sm">
            <Mini k="LTV" v={ltv} />
            <Mini k="Yield" v={yieldPct} />
            <Mini k="Ask" v={ask} />
          </div>
        </div>
        <div className="glass relative z-20 -mt-6 ml-6 p-5 shadow-[var(--shadow)] sm:ml-16 lg:-mt-8 lg:ml-24">
          <div className="flex items-center justify-between">
            <p className="type-label font-semibold text-foreground">Bid sheet</p>
            <p className="text-xs text-muted-foreground">Sealed · closes Fri 5pm</p>
          </div>
          <ul className="mt-3 space-y-2 text-sm">
            <BidRow who="Buyer C" amount={bids[2]} tag="Over funds" />
            <BidRow who="Buyer A" amount={bids[0]} tag="Covered" good />
            <BidRow who="Buyer B" amount={bids[1]} tag="Covered" good />
          </ul>
        </div>
        <div className="glass relative z-0 -mt-4 mr-10 hidden p-5 shadow-[var(--shadow)] sm:block lg:-ml-2 lg:mr-28">
          <p className="figure type-label font-semibold text-foreground">Closing · day 9 of 30</p>
          <ol className="mt-3 space-y-1.5 text-sm">
            <Step done text="Purchase agreement" />
            <Step done text="Buyer deposit" />
            <Step text="Collateral file transfer" due="Due in 6 days" />
          </ol>
        </div>
      </div>
      <figcaption className="mt-4 text-center text-xs text-muted-foreground lg:pl-10">What the desk sees. Bid and closing figures are samples.</figcaption>
    </figure>
  );
}

function Proof({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <li className="flex items-center gap-2">
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-card text-link ring-1 ring-border">{icon}</span>
      {text}
    </li>
  );
}

function Figure({ k, v }: { k: string; v: string }) {
  return (
    <div className="px-3 py-7 text-center sm:px-6">
      <dd className="text-3xl font-semibold tracking-[-0.02em] text-foreground md:text-4xl">{v}</dd>
      <dt className="mt-1 text-xs text-muted-foreground sm:text-[13px]">{k}</dt>
    </div>
  );
}

function Track({ label, steps, cta }: { label: string; steps: string[][]; cta: { href: string; text: string } }) {
  return (
    <div className="glass p-7 md:p-8">
      <p className="text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">{label}</p>
      <ol className="mt-6 space-y-6">
        {steps.map(([title, copy], index) => (
          <li key={title} className="flex gap-4">
            <span className="figure grid size-8 shrink-0 place-items-center rounded-full bg-muted type-label font-semibold text-foreground ring-1 ring-border">{index + 1}</span>
            <div>
              <h3 className="text-lg font-semibold tracking-tight text-foreground">{title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{copy}</p>
            </div>
          </li>
        ))}
      </ol>
      <Link href={cta.href} className="mt-7 inline-flex min-h-11 items-center gap-1 text-[15px] font-medium text-link underline-offset-4 hover:underline sm:min-h-0">{cta.text} <ArrowRight className="size-4" /></Link>
    </div>
  );
}

function Feature({ icon, title, copy }: { icon: React.ReactNode; title: string; copy: string }) {
  return (
    <article className="rounded-2xl border border-border bg-background p-6">
      <span className="grid size-10 place-items-center rounded-xl bg-card text-link ring-1 ring-border">{icon}</span>
      <h3 className="mt-5 text-lg font-semibold tracking-tight text-foreground">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{copy}</p>
    </article>
  );
}

function Price({ n, unit, title, copy, highlight }: { n: string; unit?: string; title: string; copy: string; highlight?: boolean }) {
  return (
    <article className={highlight ? "rounded-2xl bg-primary p-7 text-primary-foreground shadow-float" : "glass p-7"}>
      <p className={`type-label font-semibold ${highlight ? "opacity-75" : "text-muted-foreground"}`}>{title}</p>
      <p className="figure mt-3 text-4xl font-semibold tracking-[-0.02em]">{n}<span className="text-base font-medium opacity-60">{unit}</span></p>
      <p className={`mt-3 text-sm leading-relaxed ${highlight ? "opacity-75" : "text-muted-foreground"}`}>{copy}</p>
    </article>
  );
}

function Mini({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{k}</p>
      <p className="figure mt-1 font-medium text-foreground">{v}</p>
    </div>
  );
}

function BidRow({ who, amount, tag, good }: { who: string; amount: string; tag: string; good?: boolean }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="whitespace-nowrap text-foreground">{who}</span>
      <span className="flex items-center gap-3">
        <span className="figure font-medium text-foreground">{amount}</span>
        <span className={`w-[78px] whitespace-nowrap rounded-full px-2 py-0.5 text-center text-xs ${good ? "bg-good/12 text-good" : "bg-bad/10 text-bad"}`}>{tag}</span>
      </span>
    </li>
  );
}

function Step({ text, done, due }: { text: string; done?: boolean; due?: string }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className={`flex items-center gap-2 ${done ? "text-muted-foreground" : "text-foreground"}`}>
        <span className={`grid size-4 place-items-center rounded-full text-[10px] ${done ? "bg-good text-background" : "border border-input"}`}>{done ? "✓" : ""}</span>
        {text}
      </span>
      {due && <span className="text-xs text-warn">{due}</span>}
    </li>
  );
}
