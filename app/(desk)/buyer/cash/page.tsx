import Link from "next/link";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { CASH_KIND_LABELS, SOON_DAYS, loadCashNeeds, pageOf, statusText, type CashStatus } from "@/lib/cash-needs";
import { money, prettyDate, q } from "@/lib/format";
import { cn } from "@/lib/utils";
import { RENEW_FUNDS } from "@/lib/verification";

export const metadata = { title: "Cash needs" };

const STATUS_TONE: Record<CashStatus, string> = {
  late: "text-bad",
  due_soon: "text-warn",
  due: "text-muted-foreground",
  received: "text-good",
};

const BID_STATUS: Record<string, string> = {
  OPEN: "Open",
  REVIEWED: "Reviewed",
  ACCEPTED: "Accepted, closing not open yet",
};

// The columns of a row on a wide screen. Below md each row is a card.
const OWED_COLUMNS = "md:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1fr)]";
const BID_COLUMNS = "md:grid-cols-[minmax(0,1.7fr)_minmax(0,1.4fr)_minmax(0,1fr)]";

export default async function CashNeedsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["BUYER"]);
  const params = await searchParams;
  const now = new Date();
  const cash = await loadCashNeeds(user.id, now);
  const owed = pageOf(cash.items, Number(q(params, "page") || 1));
  const bids = pageOf(cash.bids, Number(q(params, "bids") || 1));
  const empty = cash.items.length === 0 && cash.bids.length === 0;
  const href = (next: { page?: number; bids?: number }) => {
    const search = new URLSearchParams();
    const page = next.page ?? owed.page;
    const bidPage = next.bids ?? bids.page;
    if (page > 1) search.set("page", String(page));
    if (bidPage > 1) search.set("bids", String(bidPage));
    const text = search.toString();
    return text ? `/buyer/cash?${text}` : "/buyer/cash";
  };
  const totals = [
    { label: "Late", cents: cash.totals.lateCents, tone: cash.totals.lateCents > 0 ? "text-bad" : "text-foreground" },
    { label: "Next 7 days", cents: cash.totals.next7Cents, tone: "text-foreground" },
    { label: "Next 30 days", cents: cash.totals.next30Cents, tone: "text-foreground" },
    { label: "Later", cents: cash.totals.laterCents, tone: "text-foreground" },
  ];
  const links = (
    <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
      {cash.items.length > 0 && (
        <a href="/api/cash-needs" className="inline-flex min-h-10 items-center font-medium text-link">Download CSV</a>
      )}
      <Link href="/account/notifications#calendar" className="inline-flex min-h-10 items-center font-medium text-link">Your calendar feed</Link>
      <span className="text-muted-foreground">The feed carries each deposit date and target close, never an amount.</span>
    </p>
  );
  return (
    <div className="min-w-0">
      <PageIntro
        eyebrow="Cash needs"
        title="What you owe, and when."
        lede="Deposits and closing wires on your open closings, by due date, from the figures on each closing page. UPB holds no money: each wire goes where that closing's wire instructions say, and the desk records it when it lands."
      />

      {empty ? (
        <>
          <p className="border border-dashed border-link/30 px-5 py-8 text-sm text-muted-foreground rounded-xl">
            Nothing is owed and no bids are live. When a bid of yours is awarded, its deposit and closing wire show here with their dates.
          </p>
          {links}
        </>
      ) : (
        <>
          <section aria-labelledby="totals-heading">
            <h2 id="totals-heading" className="sr-only">Totals still owed</h2>
            <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {totals.map((total) => (
                <div key={total.label} className="min-w-0 rounded-xl border border-border p-3 sm:p-4">
                  <dt className="text-[13px] text-muted-foreground">{total.label}</dt>
                  <dd className={cn("mt-1 text-base font-semibold tracking-tight tabular-nums wrap-anywhere sm:text-xl", total.tone)}>{money(total.cents / 100, 2)}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">
              Still owed, as recorded. The 30-day figure includes the next 7 days. What the desk has recorded as received counts in none of them.
            </p>
            {links}
          </section>

          <section aria-labelledby="owed-heading" className="mt-8">
            <h2 id="owed-heading" className="text-[15px] font-semibold tracking-tight text-foreground">Owed on open closings</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              The deposit is due by its date and the balance by the target close. Until the deposit lands, the balance shown is the all-in less the deposit, so no dollar counts twice. Due within {SOON_DAYS} days and late are marked.
            </p>
            {cash.items.length === 0 ? (
              <p className="mt-4 border border-dashed border-border px-5 py-6 text-sm text-muted-foreground rounded-xl">No open closings. Nothing is owed yet.</p>
            ) : (
              <div className="mt-4 overflow-hidden rounded-xl border border-border">
                <div aria-hidden className={cn("hidden gap-x-4 border-b border-border px-5 py-2 text-[12px] font-medium text-muted-foreground md:grid", OWED_COLUMNS)}>
                  <span>Closing</span>
                  <span>Amount</span>
                  <span>Due</span>
                  <span>Status</span>
                </div>
                <ul className="divide-y divide-border">
                  {owed.rows.map((item) => (
                    <li key={`${item.closingId}-${item.kind}`} className={cn("grid grid-cols-2 gap-x-3 gap-y-1 px-4 py-4 md:items-baseline md:gap-x-4 md:px-5", OWED_COLUMNS)}>
                      <div className="col-span-2 min-w-0 md:col-span-1">
                        <Link href={`/closings/${item.closingId}`} className="inline-flex min-h-10 items-center font-medium text-foreground break-words hover:text-link">{item.title}</Link>
                        <p className="mt-0.5 text-[13px] text-muted-foreground break-words">
                          {CASH_KIND_LABELS[item.kind]} · {item.detail}
                        </p>
                      </div>
                      <p className={cn("col-span-2 text-[15px] font-semibold tabular-nums md:col-span-1", item.status === "received" ? "text-muted-foreground" : "text-foreground")}>
                        {money(item.cents / 100, 2)}
                      </p>
                      <p className="min-w-0 text-sm text-foreground">
                        <span className="text-muted-foreground md:hidden">Due </span>
                        {item.dueAt ? prettyDate(item.dueAt) : "No date set"}
                      </p>
                      <p className={cn("min-w-0 text-right text-sm font-medium md:text-left", STATUS_TONE[item.status])}>{statusText(item)}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <Pager label="Owed rows" page={owed.page} pages={owed.pages} href={(page) => href({ page })} />
          </section>

          <section aria-labelledby="bids-heading" className="mt-10">
            <h2 id="bids-heading" className="text-[15px] font-semibold tracking-tight text-foreground">If your open bids win</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Not owed yet. Each figure is a live bid&apos;s all-in, with the buyer premium, as your verified-funds ceiling counts it on the bid form. Bids on the same loan hold one amount, the highest. A bid is owed only once it is awarded, and its deposit and balance then show above.
            </p>
            <div className={cn("mt-4 rounded-xl border p-4 sm:p-5", cash.credential?.expired ? "border-bad/40" : "border-link/30 bg-link/5")}>
              {cash.credential ? (
                <>
                  <p className="font-semibold tracking-tight text-foreground tabular-nums">{cash.credential.line}</p>
                  {cash.credential.expired && <p className="mt-1 text-sm text-foreground">{RENEW_FUNDS}</p>}
                  <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2 md:grid-cols-4">
                    <div className="min-w-0">
                      <dt className="text-muted-foreground">Verified funds</dt>
                      <dd className="text-foreground tabular-nums">{money(cash.credential.amount)}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-muted-foreground">Held by open closings</dt>
                      <dd className="text-foreground tabular-nums">{money(cash.heldByClosingsCents / 100)}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-muted-foreground">Held by live bids</dt>
                      <dd className="text-foreground tabular-nums">{money(cash.heldByBidsCents / 100)}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-muted-foreground">Headroom left</dt>
                      <dd className="text-foreground tabular-nums">{money(Math.max(0, (cash.headroomCents ?? 0) / 100))}</dd>
                    </div>
                  </dl>
                </>
              ) : (
                <p className="text-sm text-foreground">
                  The desk hasn&apos;t verified a funds amount on your buyer file, so no ceiling applies to your bids.{" "}
                  <Link href="/buyer/verification" className="inline-flex min-h-10 items-center font-medium text-link">Your buyer file</Link>
                </p>
              )}
            </div>
            {cash.bids.length === 0 ? (
              <p className="mt-4 border border-dashed border-border px-5 py-6 text-sm text-muted-foreground rounded-xl">No live bids hold funds.</p>
            ) : (
              <div className="mt-4 overflow-hidden rounded-xl border border-border">
                <div aria-hidden className={cn("hidden gap-x-4 border-b border-border px-5 py-2 text-[12px] font-medium text-muted-foreground md:grid", BID_COLUMNS)}>
                  <span>Listing</span>
                  <span>Your bid</span>
                  <span>All-in held</span>
                </div>
                <ul className="divide-y divide-border">
                  {bids.rows.map((row) => (
                    <li key={row.key} className={cn("grid grid-cols-1 gap-y-1 px-4 py-4 md:items-baseline md:gap-x-4 md:px-5", BID_COLUMNS)}>
                      <div className="min-w-0">
                        <Link href={`/marketplace/${row.listingId}`} className="inline-flex min-h-10 items-center font-medium text-foreground break-words hover:text-link">{row.title}</Link>
                        <p className="mt-0.5 text-[13px] text-muted-foreground break-words">{row.loan}</p>
                      </div>
                      <div className="min-w-0 space-y-0.5 text-sm text-foreground">
                        {row.bids.map((bid) => (
                          <p key={bid.id} className="break-words">
                            {bid.price != null ? money(bid.price, 2) : "No price"}
                            <span className="text-muted-foreground">
                              {" "}· {BID_STATUS[bid.status] ?? bid.status.toLowerCase()}
                              {bid.expiresAt && bid.status !== "ACCEPTED" ? ` · good until ${prettyDate(bid.expiresAt)}` : ""}
                            </span>
                          </p>
                        ))}
                      </div>
                      <p className="text-[15px] font-semibold tabular-nums text-foreground">
                        <span className="text-[13px] font-normal text-muted-foreground md:hidden">All-in held </span>
                        {money(row.allInCents / 100, 2)}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <Pager label="Bid rows" page={bids.page} pages={bids.pages} href={(page) => href({ bids: page })} />
          </section>
        </>
      )}
    </div>
  );
}

function Pager({ label, page, pages, href }: { label: string; page: number; pages: number; href: (page: number) => string }) {
  if (pages <= 1) return null;
  return (
    <nav aria-label={label} className="mt-3 flex flex-wrap items-center gap-3 text-[13px]">
      {page > 1 && <Link href={href(page - 1)} className="inline-flex min-h-10 items-center font-medium text-link">Previous</Link>}
      <span className="text-muted-foreground">Page {page} of {pages}</span>
      {page < pages && <Link href={href(page + 1)} className="inline-flex min-h-10 items-center font-medium text-link">Next</Link>}
    </nav>
  );
}
