import Link from "next/link";
import { redirect } from "next/navigation";
import { saveSearch } from "@/actions/buyer";
import { ListingCard } from "@/components/listing-card";
import { UsMap } from "@/components/us-map";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth";
import { openableListingIds } from "@/lib/access";
import { filtersActive, noteMatches, parseFilters } from "@/lib/filters";
import { money, num, pct, q } from "@/lib/format";
import { labelOf } from "@/lib/labels";
import { noteMetrics, poolMetrics } from "@/lib/metrics";
import { prisma } from "@/lib/prisma";
import { enrichOpenBook } from "@/lib/listing-intel";
import { getSettings, isEarlyAccess, isPro } from "@/lib/settings";

export const metadata = { title: "The book" };

export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  if (user.role === "BUYER" && user.accountStatus !== "APPROVED") redirect("/buyer/pending");
  const params = await searchParams;
  const filters = parseFilters({
    state: q(params, "state"),
    paymentStatus: q(params, "paymentStatus"),
    lienPosition: q(params, "lienPosition"),
    propertyType: q(params, "propertyType"),
    upbMin: q(params, "upbMin"),
    upbMax: q(params, "upbMax"),
    priceMin: q(params, "priceMin"),
    priceMax: q(params, "priceMax"),
    kind: q(params, "kind"),
    q: q(params, "q"),
  });
  const sort = q(params, "sort") || "new";
  const view = q(params, "view");
  if (view === "map") await enrichOpenBook();
  const settings = await getSettings();
  const listings = await prisma.listing.findMany({
    where: { status: { in: ["APPROVED", "PENDING", "SOLD"] } },
    include: { notes: true, favorites: { where: { userId: user.id } } },
    orderBy: { approvedAt: "desc" },
  });
  const openable = openableListingIds(listings, settings.earlyAccessHours, settings.freeBrowseLimit);
  const pro = user.role === "ADMIN" || isPro(user);
  const states = [...new Set(listings.flatMap((listing) => listing.notes.map((note) => note.state)))].sort();

  const prepared = listings
    .filter((listing) => !filters.kind || listing.kind === filters.kind)
    .filter((listing) => listing.notes.some((note) => noteMatches({
      city: note.city,
      state: note.state,
      paymentStatus: note.paymentStatus,
      lienPosition: note.lienPosition,
      propertyType: note.propertyType,
      upb: num(note.upb),
      askingPrice: num(note.askingPrice),
    }, filters)))
    .map((listing) => {
      const view = listing.notes.map((note) => ({
        upb: num(note.upb),
        askingPrice: num(note.askingPrice),
        estimatedValue: num(note.estimatedValue),
        monthlyPi: num(note.monthlyPi),
        interestRate: num(note.interestRate),
        paymentStatus: note.paymentStatus,
        city: note.city,
        state: note.state,
        lienPosition: note.lienPosition,
        propertyType: note.propertyType,
      }));
      const pool = poolMetrics(view);
      const single = view[0] ? noteMetrics(view[0]) : null;
      const metrics = listing.kind === "POOL"
        ? { upb: pool.totalUpb, asking: pool.totalAsk, priceToUpb: pool.priceToUpb, yield: pool.currentYield }
        : { upb: view[0]?.upb ?? 0, asking: view[0]?.askingPrice ?? 0, priceToUpb: single?.priceToUpb ?? null, yield: single?.currentYield ?? null };
      const early = listing.status !== "SOLD" && isEarlyAccess(listing.approvedAt, settings.earlyAccessHours) && !pro;
      const limited = listing.status !== "SOLD" && !pro && !early && !openable.has(listing.id);
      return { listing, view, metrics, early, limited };
    });

  prepared.sort((a, b) => {
    if (sort === "discount") return (a.metrics.priceToUpb ?? 999) - (b.metrics.priceToUpb ?? 999);
    if (sort === "yield") return (b.metrics.yield ?? -1) - (a.metrics.yield ?? -1);
    if (sort === "upb") return b.metrics.upb - a.metrics.upb;
    return (b.listing.approvedAt?.getTime() ?? 0) - (a.listing.approvedAt?.getTime() ?? 0);
  });

  const live = prepared.filter((item) => item.listing.status !== "SOLD");
  const traded = prepared.filter((item) => item.listing.status === "SOLD").slice(0, 3);
  const pageNum = Math.max(1, Number(q(params, "page") || "1") || 1);
  const pageSize = 12;
  const pageCount = Math.max(1, Math.ceil(live.length / pageSize));
  const shown = live.slice((pageNum - 1) * pageSize, pageNum * pageSize);

  return (
    <div>
      <PageIntro
        eyebrow="The book"
        title="Paper, currently offered."
        lede={pro ? "Full marks are open. Early listings are included." : `Free membership opens ${settings.freeBrowseLimit} listings. Balances and yields stay veiled, and new paper is held ${settings.earlyAccessHours} hours for Pro.`}
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <form className="mt-8 grid gap-3 border border-border p-4 md:grid-cols-4 lg:grid-cols-8 rounded-xl">
        <input name="q" defaultValue={filters.q ?? ""} placeholder="City" className="desk-input lg:col-span-2" />
        <select name="state" defaultValue={filters.state ?? ""} className="desk-input">
          <option value="">Any state</option>
          {states.map((state) => <option key={state}>{state}</option>)}
        </select>
        <select name="paymentStatus" defaultValue={filters.paymentStatus ?? ""} className="desk-input">
          <option value="">Any performance</option>
          <option value="PERFORMING">Performing</option>
          <option value="SUB_PERFORMING">Sub-performing</option>
          <option value="NON_PERFORMING">Non-performing</option>
        </select>
        <select name="lienPosition" defaultValue={filters.lienPosition ?? ""} className="desk-input">
          <option value="">Any lien</option>
          <option value="FIRST">First</option>
          <option value="SECOND">Second</option>
          <option value="THIRD">Third</option>
        </select>
        <select name="propertyType" defaultValue={filters.propertyType ?? ""} className="desk-input">
          <option value="">Any property</option>
          <option value="SFR">Single family</option>
          <option value="CONDO">Condo</option>
          <option value="TOWNHOUSE">Townhouse</option>
          <option value="MULTIFAMILY">Multifamily</option>
          <option value="LAND">Land</option>
          <option value="COMMERCIAL">Commercial</option>
        </select>
        <input name="upbMin" defaultValue={q(params, "upbMin")} placeholder="UPB min" className="desk-input" />
        <input name="upbMax" defaultValue={q(params, "upbMax")} placeholder="UPB max" className="desk-input" />
        <input name="priceMin" defaultValue={q(params, "priceMin")} placeholder="Price min" className="desk-input" />
        <input name="priceMax" defaultValue={q(params, "priceMax")} placeholder="Price max" className="desk-input" />
        <select name="kind" defaultValue={filters.kind ?? ""} className="desk-input">
          <option value="">Notes and pools</option>
          <option value="SINGLE">Notes</option>
          <option value="POOL">Pools</option>
        </select>
        <select name="sort" defaultValue={sort} className="desk-input">
          <option value="new">Newest</option>
          <option value="discount">Deepest discount</option>
          <option value="yield">Highest yield</option>
          <option value="upb">Largest UPB</option>
        </select>
        <Button type="submit" className="h-11 text-[13px] font-medium">Apply</Button>
        <Link href="/marketplace" className="inline-flex h-11 items-center text-[13px] font-medium text-muted-foreground">Reset</Link>
      </form>
      {pro && filtersActive(filters) && (
        <form action={saveSearch} className="mt-4 flex flex-wrap items-center gap-3">
          <input type="hidden" name="filters" value={JSON.stringify(filters)} />
          <input name="name" placeholder="Name this search" className="desk-input max-w-xs" />
          <Button type="submit" variant="outline" className="h-11 text-[13px] font-medium">Save alert</Button>
        </form>
      )}
      {!pro && <p className="mt-4 text-sm text-muted-foreground">Saved-search alerts are part of Pro.</p>}
      <div className="mt-6 flex gap-4 text-[13px] font-medium">
        <Link href={bookHref(params, "")} className={view === "map" ? "text-muted-foreground" : "text-link"}>List</Link>
        <Link href={bookHref(params, "map")} className={view === "map" ? "text-link" : "text-muted-foreground"}>Map</Link>
      </div>
      {view === "map" ? (
        <div className="mt-6">
          <UsMap
            label="Marketplace map"
            pins={live.flatMap(({ listing, view: notes }) => {
              const note = listing.notes.find((item) => item.latitude != null && item.longitude != null);
              if (!note || note.latitude == null || note.longitude == null) return [];
              return [{
                id: listing.id,
                title: `${notes[0]?.city ?? note.city}, ${notes[0]?.state ?? note.state}`,
                href: `/marketplace/${listing.id}`,
                latitude: note.latitude,
                longitude: note.longitude,
              }];
            })}
          />
        </div>
      ) : (
      <div className="mt-8 grid gap-4 md:grid-cols-2">
        {shown.map(({ listing, view, metrics, early, limited }) => (
          <ListingCard
            key={listing.id}
            listingId={listing.id}
            href={`/marketplace/${listing.id}`}
            title={listing.title}
            city={view[0]?.city ?? ""}
            state={view[0]?.state ?? ""}
            kind={listing.kind}
            paymentLabel={same(view.map((note) => note.paymentStatus), (value) => labelOf("payment", value))}
            lienLabel={same(view.map((note) => note.lienPosition), (value) => labelOf("lien", value))}
            propertyLabel={same(view.map((note) => note.propertyType), (value) => labelOf("property", value))}
            status={listing.status}
            loanCount={view.length}
            locked={early || limited}
            lockReason={early ? "early" : limited ? "limit" : null}
            metrics={pro && !early ? metrics : null}
            favorited={listing.favorites.length > 0}
            canFavorite={user.role === "BUYER"}
          />
        ))}
      </div>
      )}
      {pageCount > 1 && view !== "map" && (
        <div className="mt-6 flex items-center gap-4 text-[13px] font-medium">
          {pageNum > 1 && <Link className="text-link" href={bookHref(params, view === "map" ? "map" : "", pageNum - 1)}>Previous</Link>}
          <span className="text-muted-foreground">Page {pageNum} of {pageCount}</span>
          {pageNum < pageCount && <Link className="text-link" href={bookHref(params, view === "map" ? "map" : "", pageNum + 1)}>Next</Link>}
        </div>
      )}
      {live.length === 0 && (
        <div className="mt-10 border border-dashed border-link/30 p-10 rounded-xl">
          <p className="font-semibold tracking-tight text-3xl text-foreground">Nothing matches.</p>
          <p className="mt-2 text-sm text-muted-foreground">Widen the filters, or wait for the next tape.</p>
        </div>
      )}
      {traded.length > 0 && (
        <section className="mt-16">
          <p className="eyebrow">Recently traded</p>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {traded.map(({ listing, metrics }) => (
              <Link key={listing.id} href={`/marketplace/${listing.id}`} className="border border-border p-5 rounded-xl">
                <p className="text-[13px] font-medium text-muted-foreground">Sold</p>
                <h3 className="mt-2 font-semibold tracking-tight text-lg text-foreground">{listing.title}</h3>
                <p className="mt-3 text-sm text-muted-foreground">{pro ? `${pct(metrics.priceToUpb, 0)} of UPB · ${money(num(listing.salePrice))}` : "Price veiled"}</p>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function bookHref(params: Record<string, string | string[] | undefined>, view: string, page = 0) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "view" || key === "page" || typeof value !== "string" || !value) continue;
    search.set(key, value);
  }
  if (view) search.set("view", view);
  if (page > 1) search.set("page", String(page));
  const query = search.toString();
  return query ? `/marketplace?${query}` : "/marketplace";
}

function same(values: string[], label: (value: string) => string) {
  const unique = [...new Set(values)];
  if (unique.length === 1) return label(unique[0]);
  return "Mixed";
}
