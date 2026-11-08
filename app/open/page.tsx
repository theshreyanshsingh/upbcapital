import type { Metadata } from "next";
import Link from "next/link";
import { MarketingFooter, MarketingHeader } from "@/components/marketing";
import { getCurrentUser } from "@/lib/auth";
import { LIEN_POSITIONS, PAYMENT_STATUSES, US_STATES } from "@/lib/labels";
import { BALANCE_BANDS, indexHref, loadIndex, readIndexFilters, type IndexCard } from "@/lib/public-index";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Notes for sale",
  description: "Live mortgage notes on UPB Capital, by state, lien, performance and balance. Each listing is anonymised; the file opens on the desk.",
};

export default async function OpenIndexPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [user, params] = await Promise.all([getCurrentUser(), searchParams]);
  const filters = readIndexFilters(params);
  const index = await loadIndex(filters);
  const filtered = Boolean(filters.state || filters.lien || filters.performance || filters.band);
  return (
    <div>
      <MarketingHeader authed={Boolean(user)} />
      <main id="desk" className="mx-auto max-w-6xl px-5 pb-24 pt-32">
        <p className="eyebrow">The book</p>
        <h1 className="mt-4 font-semibold tracking-tight text-5xl text-foreground md:text-6xl">Notes for sale.</h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
          Every live listing anyone may see. The street, borrower and price stay on the desk. Sign in to underwrite a file.
        </p>

        <form method="get" action="/open" className="glass mt-10 grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto] lg:items-end">
          <label className="block">
            <span className="text-[13px] text-muted-foreground">State</span>
            <select name="state" defaultValue={filters.state} className="desk-input mt-2">
              <option value="">Any state</option>
              {US_STATES.map((state) => <option key={state} value={state}>{state}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Lien</span>
            <select name="lien" defaultValue={filters.lien} className="desk-input mt-2">
              <option value="">Any lien</option>
              {LIEN_POSITIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Performance</span>
            <select name="performance" defaultValue={filters.performance} className="desk-input mt-2">
              <option value="">Any performance</option>
              {PAYMENT_STATUSES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Unpaid principal</span>
            <select name="band" defaultValue={filters.band} className="desk-input mt-2">
              <option value="">Any balance</option>
              {BALANCE_BANDS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <div className="flex gap-3 sm:col-span-2 lg:col-span-1">
            <button type="submit" className="inline-flex h-11 flex-1 items-center justify-center rounded-lg bg-primary px-5 text-[13px] font-medium text-primary-foreground lg:flex-none">
              Show
            </button>
            {filtered && (
              <Link href="/open" className="inline-flex h-11 items-center px-2 text-[13px] font-medium text-link">
                Clear
              </Link>
            )}
          </div>
        </form>

        <p className="mt-6 text-sm text-muted-foreground" aria-live="polite">
          {index.total === 0 ? "" : `${index.total} listing${index.total === 1 ? "" : "s"}${filtered ? " match" : " live now"}.`}
        </p>
        {index.cards.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-border px-5 py-10 text-sm text-muted-foreground">
            {filtered ? "Nothing live matches. Try fewer filters." : "Nothing is live right now."}{" "}
            <Link href="/announcements" className="text-link">Get new listings by email</Link>
          </div>
        ) : (
          <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {index.cards.map((card) => <Card key={card.id} card={card} />)}
          </ul>
        )}

        {index.pages > 1 && (
          <nav aria-label="Pages" className="mt-8 flex items-center justify-between gap-3 text-[13px] font-medium">
            {index.page > 1 ? <Link href={indexHref(filters, { page: index.page - 1 })} className="text-link">Previous</Link> : <span />}
            <span className="text-muted-foreground">Page {index.page} of {index.pages}</span>
            {index.page < index.pages ? <Link href={indexHref(filters, { page: index.page + 1 })} className="text-link">Next</Link> : <span />}
          </nav>
        )}

        <section className="glass mt-12 flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="eyebrow">Deal announcements</p>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">New listings by email when the desk announces them.</p>
          </div>
          <Link href="/announcements" className="inline-flex h-11 items-center justify-center rounded-lg border border-link/40 px-5 text-[13px] font-medium text-link">
            Join the list
          </Link>
        </section>
      </main>
      <MarketingFooter />
    </div>
  );
}

function Card({ card }: { card: IndexCard }) {
  return (
    <li>
      <Link href={`/open/${card.id}`} className="block h-full rounded-xl border border-border bg-card p-5 transition hover:border-link/50">
        <p className="text-xs font-medium text-link">{card.kind}{card.kind === "Pool" ? ` · ${card.loans} loans` : ""}</p>
        <p className="mt-2 font-semibold tracking-tight text-2xl leading-tight text-foreground">
          {card.kind === "Pool" ? card.states : `${card.city}, ${card.state}`}
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Fact k="Lien" v={card.lien} />
          <Fact k="Performance" v={card.performance} />
          <Fact k="Collateral" v={card.collateral} />
          <Fact k="UPB band" v={card.band} />
        </dl>
      </Link>
    </li>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{k}</dt>
      <dd className="text-foreground">{v}</dd>
    </div>
  );
}
