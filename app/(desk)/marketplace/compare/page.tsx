import Link from "next/link";
import { redirect } from "next/navigation";
import { PageIntro } from "@/components/page-intro";
import { StatusPill } from "@/components/status-pill";
import { requireUser } from "@/lib/auth";
import { canOpenListing, openableListingIds } from "@/lib/access";
import { BID_MODES } from "@/lib/filters";
import { money, num, pct, prettyDate } from "@/lib/format";
import { labelOf } from "@/lib/labels";
import { COMPARE_LIMIT, compareColumn, type CompareColumn, type FlagCount } from "@/lib/metrics";
import { prisma } from "@/lib/prisma";
import { canSee, invitedTo, listingAccess } from "@/lib/private-listings";
import { getSettings, isPro } from "@/lib/settings";

export const metadata = { title: "Compare" };

// What a cell says, or null when this viewer may not see it.
type Cell = string | null;
type Row = { label: string; cells: Cell[]; figure?: boolean };

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  if (user.role === "BUYER" && user.accountStatus !== "APPROVED") redirect("/buyer/pending");
  const params = await searchParams;
  const asked = [...new Set((Array.isArray(params.ids) ? params.ids : [params.ids ?? ""]).flatMap((value) => value.split(",")).map((value) => value.trim()))]
    .filter((value) => /^[A-Za-z0-9_-]{1,64}$/.test(value));
  const ids = asked.slice(0, COMPARE_LIMIT);
  const pro = user.role === "ADMIN" || isPro(user);
  const [settings, found, live, sight] = await Promise.all([
    getSettings(),
    ids.length ? prisma.listing.findMany({ where: { id: { in: ids } }, include: { notes: true } }) : Promise.resolve([]),
    prisma.listing.findMany({ where: { status: { in: ["APPROVED", "PENDING"] } }, select: { id: true, status: true, approvedAt: true, visibility: true } }),
    listingAccess(user),
  ]);
  const openable = openableListingIds(live, settings.earlyAccessHours, settings.freeBrowseLimit);
  const byId = new Map(found.map((listing) => [listing.id, listing]));
  // Each listing passes the same check its own page runs, one by one, before anything about it shows. One hidden
  // from this viewer reads as missing (lib/private-listings.ts).
  const columns: CompareColumn[] = ids.flatMap((id) => {
    const listing = byId.get(id);
    if (!listing || !canSee(sight, listing)) return [{ id, hidden: true, hold: null, title: "", card: null, file: null, figures: null }];
    const access = canOpenListing({
      invited: invitedTo(sight, listing),
      viewer: user,
      status: listing.status,
      approvedAt: listing.approvedAt,
      earlyAccessHours: settings.earlyAccessHours,
      openableIds: openable,
      listingId: listing.id,
      sellerId: listing.sellerId,
      brokerId: listing.brokerId,
      launchAt: listing.launchAt,
    });
    return [compareColumn({
      id: listing.id,
      title: listing.title,
      kind: listing.kind,
      status: listing.status,
      bidMode: listing.bidMode,
      bidDeadline: listing.bidDeadline,
      notes: listing.notes.map((note) => ({
        upb: num(note.upb),
        askingPrice: num(note.askingPrice),
        estimatedValue: num(note.estimatedValue),
        monthlyPi: num(note.monthlyPi),
        interestRate: num(note.interestRate),
        paymentStatus: note.paymentStatus,
        tradeStatus: note.tradeStatus,
        city: note.city,
        state: note.state,
        lienPosition: note.lienPosition,
        propertyType: note.propertyType,
        occupancy: note.occupancy,
        foreclosureStatus: note.foreclosureStatus,
        monthsDelinquent: note.monthsDelinquent,
        modified: note.modified,
        bankruptcyChapter: note.bankruptcyChapter,
        bankruptcyFiledAt: note.bankruptcyFiledAt,
        hoaLien: note.hoaLien,
        taxDelinquent: note.taxDelinquent,
      })),
    }, access, pro)];
  });
  const shownIds = columns.map((column) => column.id);
  const without = (id: string) => {
    const rest = shownIds.filter((item) => item !== id);
    return rest.length ? `/marketplace/compare?${rest.map((item) => `ids=${encodeURIComponent(item)}`).join("&")}` : "/marketplace";
  };

  const mixed = (value: string | null, label: (code: string) => string) => (value == null ? "Mixed" : label(value));
  const flag = (count: FlagCount, none: string) => (count == null ? "Not on the tape" : count.flagged === 0 ? none : `${count.flagged} of ${count.of} loan${count.of === 1 ? "" : "s"}`);
  const card = (read: (column: NonNullable<CompareColumn["card"]>) => string): Cell[] => columns.map((column) => (column.card ? read(column.card) : null));
  const file = (read: (column: NonNullable<CompareColumn["file"]>) => string): Cell[] => columns.map((column) => (column.file ? read(column.file) : null));
  const figure = (read: (column: NonNullable<CompareColumn["figures"]>) => string): Cell[] => columns.map((column) => (column.figures ? read(column.figures) : null));
  const sections: { title: string; note?: string; rows: Row[] }[] = [
    {
      title: "The listing",
      rows: [
        { label: "Type", cells: card((item) => (item.kind === "POOL" ? `Pool · ${item.loanCount} loans for sale` : "Note")) },
        { label: "Place", cells: card((item) => (item.kind === "POOL" ? item.states.join(", ") : `${item.city}, ${item.states[0] ?? ""}`)) },
        { label: "Lien", cells: card((item) => mixed(item.lien, (code) => labelOf("lien", code))) },
        { label: "Performance", cells: card((item) => mixed(item.performance, (code) => labelOf("payment", code))) },
        { label: "Property", cells: card((item) => mixed(item.property, (code) => labelOf("property", code))) },
        { label: "Bid style", cells: card((item) => BID_MODES.find((mode) => mode.value === item.bidMode)?.label ?? item.bidMode) },
        { label: "Deadline", cells: card((item) => (item.deadline ? prettyDate(item.deadline) : "None")) },
      ],
    },
    {
      title: "Economics",
      note: "Yield is current yield at the ask: the tape's annual P&I over the price, gross before servicing and closing costs, on performing loans only. Value is the seller's estimate. A pool shows the totals of the loans still for sale.",
      rows: [
        { label: "UPB", figure: true, cells: figure((item) => money(item.upb)) },
        { label: "Ask", figure: true, cells: figure((item) => money(item.asking)) },
        { label: "Price / UPB", figure: true, cells: figure((item) => pct(item.priceToUpb)) },
        { label: "Current yield", figure: true, cells: figure((item) => (item.yield == null ? "None" : `${pct(item.yield)}${item.performingCount < item.loanCount ? ` on ${item.performingCount} of ${item.loanCount}` : ""}`)) },
        { label: "Note rate", figure: true, cells: figure((item) => `${pct(item.noteRate, 2)}${item.loanCount > 1 ? " weighted" : ""}`) },
        { label: "Value", figure: true, cells: figure((item) => (item.value ? money(item.value) : "—")) },
        { label: "Price / value", figure: true, cells: figure((item) => pct(item.priceToValue)) },
        { label: "LTV", figure: true, cells: figure((item) => pct(item.ltv)) },
      ],
    },
    {
      title: "The loan file",
      note: "From the seller's tape, open on each listing you can open. A tape flag shows only where the tape carries it.",
      rows: [
        { label: "Occupancy", cells: file((item) => mixed(item.occupancy, (code) => labelOf("occupancy", code))) },
        { label: "Foreclosure", cells: file((item) => mixed(item.foreclosure, (code) => labelOf("foreclosure", code))) },
        { label: "Months delinquent", cells: file((item) => (item.monthsDelinquent[0] === item.monthsDelinquent[1] ? String(item.monthsDelinquent[0]) : `${item.monthsDelinquent[0]} to ${item.monthsDelinquent[1]}`)) },
        { label: "Modified", cells: file((item) => flag(item.modified, "None marked")) },
        { label: "Bankruptcy", cells: file((item) => flag(item.bankruptcy, "None on the tape")) },
        { label: "HOA lien", cells: file((item) => flag(item.hoaLien, "None marked")) },
        { label: "Tax delinquent", cells: file((item) => flag(item.taxDelinquent, "None marked")) },
      ],
    },
  ];
  const veilCopy = (column: CompareColumn, figureRow: boolean) => {
    if (column.hidden) return "—";
    if (column.hold) return column.hold === "early" ? "Early access · Pro" : "Beyond the free book";
    return figureRow ? "Pro" : "—";
  };

  return (
    <div>
      <PageIntro
        eyebrow="The book"
        title="Side by side."
        lede={pro ? "Each listing shows what its own page shows you. Figures are open." : "Each listing shows what its own page shows you. Balances, prices and yields stay veiled on the free desk."}
      />
      <Link href="/marketplace" className="text-[13px] font-medium text-link">Back to the book</Link>
      {asked.length > COMPARE_LIMIT && (
        <p className="mt-4 text-sm text-muted-foreground">Compare shows {COMPARE_LIMIT} listings at a time. These are the first {COMPARE_LIMIT} you picked.</p>
      )}
      {columns.length < 2 ? (
        <div className="mt-8 border border-dashed border-link/30 p-10 rounded-xl">
          <p className="font-semibold tracking-tight text-2xl text-foreground">Pick two or more listings.</p>
          <p className="mt-2 text-sm text-muted-foreground">Tick Compare on up to {COMPARE_LIMIT} cards or rows in the book, then choose Compare side by side.</p>
        </div>
      ) : (
        <div className="mt-8 glass relative overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <caption className="sr-only">Listings compared side by side</caption>
            <thead>
              <tr className="border-b border-border align-top">
                <th scope="col" className="sticky left-0 z-[1] w-44 bg-card px-4 py-4 text-xs font-normal text-muted-foreground">Listing</th>
                {columns.map((column) => (
                  <th key={column.id} scope="col" className="min-w-52 px-4 py-4 font-normal">
                    {column.hidden ? (
                      <p className="text-sm text-muted-foreground">Not on the open book</p>
                    ) : (
                      <>
                        <Link href={column.hold ? `/buyer/subscription?reason=${column.hold}` : `/marketplace/${column.id}`} className="font-semibold tracking-tight text-foreground hover:text-link">
                          {column.title}
                        </Link>
                        <span className="mt-2 block">{column.card && <StatusPill status={column.card.status} />}</span>
                        {column.hold && <span className="mt-1 block text-xs font-medium text-link">{column.hold === "early" ? "Early access · Pro" : "Beyond the free book"}</span>}
                      </>
                    )}
                    <Link href={without(column.id)} className="mt-2 inline-block text-xs font-medium text-muted-foreground hover:text-foreground">Remove</Link>
                  </th>
                ))}
              </tr>
            </thead>
            {sections.map((section) => (
              <tbody key={section.title}>
                <tr className="border-t border-border bg-muted/40">
                  <th scope="colgroup" colSpan={columns.length + 1} className="px-4 py-2 text-left">
                    <span className="eyebrow">{section.title}</span>
                    {section.note && <span className="mt-1 block text-xs font-normal leading-relaxed text-muted-foreground">{section.note}</span>}
                  </th>
                </tr>
                {section.rows.map((row) => {
                  const seen = row.cells.filter((cell): cell is string => cell != null);
                  const differs = new Set(seen).size > 1;
                  return (
                    <tr key={row.label} className="border-t border-border">
                      <th scope="row" className="sticky left-0 z-[1] bg-card px-4 py-3 text-left text-[13px] font-medium text-muted-foreground">
                        {row.label}
                        {differs && <span className="ml-2 text-xs font-normal text-link">Differs</span>}
                      </th>
                      {row.cells.map((cell, index) => (
                        <td key={columns[index].id} className={`px-4 py-3 tabular-nums ${cell == null ? "text-muted-foreground" : "text-foreground"}`}>
                          {cell ?? veilCopy(columns[index], Boolean(row.figure))}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </div>
  );
}
