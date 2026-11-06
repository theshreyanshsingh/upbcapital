import Link from "next/link";
import { redirect } from "next/navigation";
import { saveSearch } from "@/actions/buyer";
import { BookChips, type Chip } from "@/components/book-chips";
import { BookFilterSheet } from "@/components/book-filter-sheet";
import { BookFiltersForm } from "@/components/book-filters";
import { BookTable } from "@/components/book-table";
import { CompareBar } from "@/components/compare-picker";
import { ListingCard } from "@/components/listing-card";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { StateMap } from "@/components/us-map";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth";
import { openableListingIds } from "@/lib/access";
import {
  appliedChips,
  BID_MODES,
  bookMatches,
  defaultDir,
  facetCount,
  fileFiltersActive,
  filtersActive,
  filtersFor,
  filtersFromSaved,
  filtersQuery,
  KINDS,
  listOf,
  pageWindow,
  parseFilters,
  sortFor,
  SORTS,
  sortRows,
  stateCounts,
  toggleValue,
  type BookFilters,
  type BookSort,
  type MultiKey,
  type SortKey,
} from "@/lib/filters";
import { foreclosureFor } from "@/lib/foreclosure";
import { money, num, pct, q } from "@/lib/format";
import { loadIndicatives } from "@/lib/indicative";
import { labelOf, LIEN_POSITIONS, PAYMENT_STATUSES, US_STATES } from "@/lib/labels";
import { bookVeil, common, listingFigures, loansForSale } from "@/lib/metrics";
import { prisma } from "@/lib/prisma";
import { advanceSaleEvents, openEvents, roundText, when } from "@/lib/sale-events";
import { getSettings, isEarlyAccess, isPro } from "@/lib/settings";

export const metadata = { title: "The book" };

const VIEWS = [
  { value: "cards", label: "Cards" },
  { value: "table", label: "Table" },
  { value: "map", label: "Map" },
] as const;

export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  if (user.role === "BUYER" && user.accountStatus !== "APPROVED") redirect("/buyer/pending");
  const params = await searchParams;
  const pro = user.role === "ADMIN" || isPro(user);
  const applied = filtersFor(parseFilters(params), pro);
  const sort = sortFor(q(params, "sort"), q(params, "dir"), pro);
  const view = VIEWS.find((option) => option.value === q(params, "view"))?.value ?? "cards";
  // A sale event whose date passed moves first, so the book shows each listing on its current round's terms.
  await advanceSaleEvents().catch(() => null);
  const [settings, listings, saved, events] = await Promise.all([
    getSettings(),
    prisma.listing.findMany({
      where: { status: { in: ["APPROVED", "PENDING", "SOLD"] } },
      include: { notes: true, favorites: { where: { userId: user.id } } },
      orderBy: { approvedAt: "desc" },
    }),
    user.role === "BUYER" && pro ? prisma.savedSearch.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 8 }) : Promise.resolve([]),
    openEvents().catch(() => []),
  ]);
  // The event filter narrows the book to one open sale event's listings. An unknown or finished event is ignored.
  const eventId = events.find((event) => event.id === q(params, "event"))?.id;
  const inEvent = (listing: { saleEventId?: string | null }) => !eventId || listing.saleEventId === eventId;
  const openable = openableListingIds(listings, settings.earlyAccessHours, settings.freeBrowseLimit);
  const states = [...new Set(listings.flatMap((listing) => listing.notes.map((note) => note.state)))].sort();

  const rows = listings.map((listing) => {
    const notes = listing.notes.map((note) => ({
      city: note.city,
      state: note.state,
      paymentStatus: note.paymentStatus,
      lienPosition: note.lienPosition,
      propertyType: note.propertyType,
      occupancy: note.occupancy,
      foreclosureStatus: note.foreclosureStatus,
      monthsDelinquent: note.monthsDelinquent,
      upb: num(note.upb),
      askingPrice: num(note.askingPrice),
      estimatedValue: num(note.estimatedValue),
      monthlyPi: num(note.monthlyPi),
      interestRate: num(note.interestRate),
      tradeStatus: note.tradeStatus,
      modified: note.modified ?? null,
      bankruptcyChapter: note.bankruptcyChapter ?? null,
      bankruptcyFiledAt: note.bankruptcyFiledAt ?? null,
      hoaLien: note.hoaLien ?? null,
      taxDelinquent: note.taxDelinquent ?? null,
    }));
    // A live pool's row shows the loans still for sale.
    const forSale = loansForSale(listing.status, notes);
    const veil = bookVeil({
      sold: listing.status === "SOLD",
      pro,
      early: isEarlyAccess(listing.approvedAt, settings.earlyAccessHours),
      openable: openable.has(listing.id),
    });
    return {
      listing,
      forSale,
      veil,
      held: veil.hold !== null,
      figures: listingFigures(listing.kind, forSale),
      match: { kind: listing.kind, status: listing.status, bidMode: listing.bidMode, bidDeadline: listing.bidDeadline, notes },
      approvedAt: listing.approvedAt?.getTime() ?? 0,
      deadline: listing.bidMode !== "NONE" && listing.bidDeadline ? listing.bidDeadline.getTime() : null,
      state: forSale[0]?.state ?? "",
    };
  });

  const book = rows.filter((row) => row.listing.status !== "SOLD" && inEvent(row.listing)).map((row) => ({ listing: row.match, held: row.held }));
  const matched = sortRows(rows.filter((row) => inEvent(row.listing) && bookMatches(row.match, applied, row.held)), sort);
  const live = matched.filter((row) => row.listing.status !== "SOLD");
  const traded = matched.filter((row) => row.listing.status === "SOLD").slice(0, 3);
  const pageSize = view === "table" ? 25 : 12;
  const pages = pageWindow(live.length, q(params, "page"), pageSize);
  const shown = live.slice(pages.start, pages.end);
  // The indicative range is a figure, so it is read only for rows this viewer sees unveiled, and only for this page.
  const indicatives = pro
    ? await loadIndicatives(shown.filter((row) => row.veil.figures).map((row) => ({ id: row.listing.id, status: row.listing.status, notes: row.listing.notes }))).catch(() => new Map())
    : new Map();
  const indicativeOf = (id: string) => {
    const range = indicatives.get(id);
    return range ? { low: range.low, high: range.high, rate: range.rate } : null;
  };
  const heldSkipped = !pro && fileFiltersActive(applied) ? book.filter((row) => row.held).length : 0;

  const href = (next: { filters?: BookFilters; view?: string; sort?: BookSort; page?: number; event?: string | null } = {}) => {
    const search = filtersQuery(next.filters ?? applied);
    const nextEvent = next.event === undefined ? eventId : next.event;
    if (nextEvent) search.set("event", nextEvent);
    const nextView = next.view ?? view;
    const nextSort = next.sort ?? sort;
    if (nextView !== "cards") search.set("view", nextView);
    if (nextSort.key !== "new") search.set("sort", nextSort.key);
    if (nextSort.dir !== defaultDir(nextSort.key)) search.set("dir", nextSort.dir);
    if (next.page && next.page > 1) search.set("page", String(next.page));
    const query = search.toString();
    return query ? `/marketplace?${query}` : "/marketplace";
  };
  const sortHref = (key: SortKey) => href({ sort: { key, dir: sort.key === key ? (sort.dir === "asc" ? "desc" : "asc") : defaultDir(key) } });
  const here = href({ filters: applied });

  const chip = (key: MultiKey, value: string, label: string): Chip => ({
    label,
    count: facetCount(book, applied, key, value),
    on: listOf(applied[key]).includes(value),
    href: href({ filters: toggleValue(applied, key, value) }),
  });
  const single = (key: "kind" | "deadline", value: string, label: string): Chip => {
    const on = applied[key] === value;
    return { label, count: facetCount(book, applied, key, value), on, href: href({ filters: { ...applied, [key]: on ? undefined : value } }) };
  };
  const shownChip = (item: Chip) => item.on || item.count > 0;
  const groups = [
    { label: "Performance", chips: PAYMENT_STATUSES.map((status) => chip("paymentStatus", status.value, status.label)).filter(shownChip) },
    { label: "Lien", chips: LIEN_POSITIONS.map((lien) => chip("lienPosition", lien.value, lien.label)).filter(shownChip) },
    { label: "Type", chips: KINDS.map((kind) => single("kind", kind.value, kind.label)).filter(shownChip) },
    { label: "Bid style", chips: BID_MODES.map((mode) => chip("bidMode", mode.value, mode.label)).filter(shownChip) },
    { label: "Deadline", chips: [single("deadline", "yes", "Dated deadline")].filter(shownChip) },
    {
      label: "Sale event",
      chips: events.map((event) => ({
        label: event.name,
        count: rows.filter((row) => row.listing.status !== "SOLD" && row.listing.saleEventId === event.id && bookMatches(row.match, applied, row.held)).length,
        on: eventId === event.id,
        href: href({ event: eventId === event.id ? null : event.id, page: 1 }),
      })).filter(shownChip),
    },
  ];
  const nextEvent = events[0];
  const nextEventCount = nextEvent ? rows.filter((row) => row.listing.status !== "SOLD" && row.listing.saleEventId === nextEvent.id).length : 0;
  const eventName = events.find((event) => event.id === eventId)?.name;
  const counts = stateCounts(book, applied);
  const cells = US_STATES.map((state) => {
    const rule = foreclosureFor(state);
    const selected = applied.state === state;
    return {
      state,
      count: counts.get(state) ?? 0,
      selected,
      judicial: !rule.assumed && rule.process === "Judicial",
      href: href({ filters: { ...applied, state: selected ? undefined : state } }),
    };
  });
  const allNotes = listings.flatMap((listing) => listing.notes);
  const flagsPresent = {
    modified: allNotes.some((note) => note.modified != null),
    bankruptcy: allNotes.some((note) => note.bankruptcyChapter || note.bankruptcyFiledAt),
    hoaLien: allNotes.some((note) => note.hoaLien != null),
    taxDelinquent: allNotes.some((note) => note.taxDelinquent != null),
  };

  const filterProps = {
    filters: applied,
    pro,
    states,
    sort,
    view,
    flagsPresent,
    resetHref: href({ filters: {}, sort: { key: "new", dir: "desc" }, event: null }),
    event: eventId,
  };
  const appliedList = [
    ...appliedChips(applied).map((item) => ({ label: item.label, href: href({ filters: item.without }) })),
    ...(eventName ? [{ label: `Event: ${eventName}`, href: href({ event: null }) }] : []),
  ];
  const sortLabel = SORTS.find((option) => option.value === sort.key)?.label ?? "Newest";
  const filterSummary = appliedList.length ? `${appliedList.map((item) => item.label).join(" · ")} · ${sortLabel}` : `Everything live · ${sortLabel}`;

  return (
    <div>
      <PageIntro
        eyebrow="The book"
        title="Paper, currently offered."
        lede={pro ? "Full marks are open. Early listings are included." : `Free membership opens ${settings.freeBrowseLimit} listings. Balances and yields stay veiled, and new paper is held ${settings.earlyAccessHours} hours for Pro.`}
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      {nextEvent && (
        <section aria-labelledby="next-event" className="mt-4 flex flex-wrap items-center justify-between gap-3 border border-link/30 bg-link/5 px-4 py-3 rounded-xl">
          <div className="min-w-0">
            <h2 id="next-event" className="text-[13px] font-semibold text-foreground">Next sale event · {nextEvent.name}</h2>
            <p className="mt-1 text-sm text-muted-foreground tabular-nums">
              Indications due {when(nextEvent.indicationsAt)}. Best and final due {when(nextEvent.bestFinalAt)}. <span className="max-sm:hidden">{roundText(nextEvent)}</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[13px] font-medium">
            {nextEventCount > 0 && eventId !== nextEvent.id && (
              <Link href={href({ event: nextEvent.id, page: 1 })} className="text-link">See its {nextEventCount} listing{nextEventCount === 1 ? "" : "s"}</Link>
            )}
            <Link href="/events" className="text-link">All events</Link>
          </div>
        </section>
      )}
      <BookFiltersForm {...filterProps} className="max-md:hidden" />
      <BookFilterSheet count={appliedList.length} summary={filterSummary}>
        <BookFiltersForm {...filterProps} layout="sheet" />
      </BookFilterSheet>
      <BookChips groups={groups} applied={appliedList} clearHref={href({ filters: {}, event: null })} />

      {user.role === "BUYER" && pro ? (
        <section aria-labelledby="saved-views" className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 id="saved-views" className="eyebrow">Saved views</h2>
          {saved.map((search) => {
            const link = href({ filters: filtersFromSaved(search.filters) });
            return (
              <Link key={search.id} href={link} aria-current={link === here ? "page" : undefined} className={`text-[13px] font-medium ${link === here ? "text-foreground" : "text-link"}`}>
                {search.name}
              </Link>
            );
          })}
          {saved.length === 0 && <span className="text-[13px] text-muted-foreground">None yet. Filter the book, then save the view to get alerts.</span>}
          {saved.length > 0 && <Link href="/buyer/alerts" className="text-[13px] font-medium text-muted-foreground hover:text-foreground">Manage alerts</Link>}
          {filtersActive(applied) && (
            <form action={saveSearch} className="flex flex-wrap items-end gap-2 sm:ml-auto">
              <input type="hidden" name="filters" value={JSON.stringify(applied)} />
              <label className="block text-xs text-muted-foreground">
                Name this view
                <input name="name" required minLength={2} className="desk-input mt-1 w-56 max-w-full" />
              </label>
              <Button type="submit" variant="outline" className="h-10 text-[13px] font-medium">Save view and alert</Button>
            </form>
          )}
        </section>
      ) : (
        !pro && <p className="mt-4 text-sm text-muted-foreground">Saved views with alerts are part of Pro.</p>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-foreground tabular-nums">
          {live.length} listing{live.length === 1 ? "" : "s"} match{live.length === 1 ? "es" : ""}
          {live.length > 0 && <span className="text-muted-foreground max-sm:hidden"> · showing {pages.first}–{pages.end}</span>}
        </p>
        <nav aria-label="Book view" className="inline-flex rounded-lg border border-border bg-card p-0.5">
          {VIEWS.map((option) => (
            <Link
              key={option.value}
              href={href({ view: option.value })}
              aria-current={view === option.value ? "page" : undefined}
              className={`inline-flex min-h-8 items-center rounded-md px-3 text-[13px] font-medium pointer-coarse:min-h-9 pointer-coarse:px-3.5 ${view === option.value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {option.label}
            </Link>
          ))}
        </nav>
      </div>
      {heldSkipped > 0 && (
        <p className="mt-2 text-[13px] text-muted-foreground">
          Filters on the loan file skip the {heldSkipped} listing{heldSkipped === 1 ? "" : "s"} you can&apos;t open yet. <Link href="/buyer/subscription?reason=access" className="text-link">See Pro</Link>
        </p>
      )}

      {view === "map" && (
        <div className="mt-6">
          <StateMap label="Listings by state. Select a state to filter the book." cells={cells} />
        </div>
      )}

      {view === "table" ? (
        live.length > 0 && (
          <div className="mt-6">
            <BookTable
              pro={pro}
              sort={sort}
              sortHref={sortHref}
              rows={shown.map((row) => ({
                id: row.listing.id,
                href: `/marketplace/${row.listing.id}`,
                title: row.listing.title,
                kind: row.listing.kind,
                place: place(row.listing.kind, row.forSale),
                lien: same(row.forSale.map((note) => note.lienPosition), (value) => labelOf("lien", value)),
                performance: same(row.forSale.map((note) => note.paymentStatus), (value) => labelOf("payment", value)),
                loanCount: row.forSale.length,
                status: row.listing.status,
                bidMode: row.listing.bidMode,
                deadline: row.deadline == null ? null : new Date(row.deadline).toISOString(),
                hold: row.veil.hold,
                figures: row.veil.figures ? row.figures : null,
                indicative: row.veil.figures ? indicativeOf(row.listing.id) : null,
              }))}
            />
          </div>
        )
      ) : (
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {shown.map(({ listing, forSale, veil, figures, deadline }) => (
            <ListingCard
              key={listing.id}
              listingId={listing.id}
              href={`/marketplace/${listing.id}`}
              title={listing.title}
              city={forSale[0]?.city ?? ""}
              state={forSale[0]?.state ?? ""}
              kind={listing.kind}
              paymentLabel={same(forSale.map((note) => note.paymentStatus), (value) => labelOf("payment", value))}
              lienLabel={same(forSale.map((note) => note.lienPosition), (value) => labelOf("lien", value))}
              propertyLabel={same(forSale.map((note) => note.propertyType), (value) => labelOf("property", value))}
              status={listing.status}
              loanCount={forSale.length}
              locked={veil.hold !== null}
              lockReason={veil.hold}
              metrics={veil.figures ? { upb: figures.upb, asking: figures.asking, priceToUpb: figures.priceToUpb, yield: figures.yield } : null}
              favorited={listing.favorites.length > 0}
              canFavorite={user.role === "BUYER"}
              bidMode={listing.bidMode}
              deadline={deadline == null ? null : new Date(deadline).toISOString()}
              comparable
              indicative={veil.figures ? indicativeOf(listing.id) : null}
            />
          ))}
        </div>
      )}

      {live.length > 0 && <CompareBar />}

      {pages.pageCount > 1 && (
        <nav aria-label="Pages" className="mt-6 flex items-center gap-4 text-[13px] font-medium tabular-nums">
          {pages.page > 1 ? <Link className="text-link" href={href({ page: pages.page - 1 })}>Previous</Link> : <span className="text-muted-foreground">Previous</span>}
          <span className="text-muted-foreground">Page {pages.page} of {pages.pageCount}</span>
          {pages.page < pages.pageCount ? <Link className="text-link" href={href({ page: pages.page + 1 })}>Next</Link> : <span className="text-muted-foreground">Next</span>}
        </nav>
      )}
      {live.length === 0 && (
        <div className="mt-10 border border-dashed border-link/30 p-10 rounded-xl">
          <p className="font-semibold tracking-tight text-3xl text-foreground">Nothing matches.</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Widen the filters, or wait for the next tape.{" "}
            {(filtersActive(applied) || eventId) && <Link href={href({ filters: {}, event: null })} className="text-link">Clear the filters</Link>}
          </p>
        </div>
      )}
      {traded.length > 0 && (
        <section className="mt-16" aria-labelledby="recently-traded">
          <h2 id="recently-traded" className="eyebrow">Recently traded</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {traded.map(({ listing, figures }) => (
              <Link key={listing.id} href={`/marketplace/${listing.id}`} className="border border-border p-5 rounded-xl">
                <p className="text-[13px] font-medium text-muted-foreground">Sold</p>
                <h3 className="mt-2 font-semibold tracking-tight text-lg text-foreground">{listing.title}</h3>
                <p className="mt-3 text-sm text-muted-foreground tabular-nums">{pro ? `${pct(figures.priceToUpb, 0)} of UPB · ${money(num(listing.salePrice))}` : "Price veiled"}</p>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function same(values: string[], label: (value: string) => string) {
  const value = common(values);
  return value == null ? "Mixed" : label(value);
}

function place(kind: string, notes: { city: string; state: string }[]) {
  if (kind !== "POOL") return notes[0] ? `${notes[0].city}, ${notes[0].state}` : "";
  const states = [...new Set(notes.map((note) => note.state))].sort();
  return states.length > 3 ? `${states.slice(0, 3).join(", ")} +${states.length - 3}` : states.join(", ");
}
