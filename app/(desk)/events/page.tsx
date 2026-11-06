import Link from "next/link";
import { redirect } from "next/navigation";
import { PageIntro } from "@/components/page-intro";
import { requireUser } from "@/lib/auth";
import { money, num } from "@/lib/format";
import { loansForSale } from "@/lib/metrics";
import { prisma } from "@/lib/prisma";
import { advanceSaleEvents, EVENT_STATUS_LABEL, openEvents, roundText, when } from "@/lib/sale-events";
import { isPro } from "@/lib/settings";

export const metadata = { title: "Sale events" };

export default async function EventsPage() {
  const user = await requireUser();
  if (user.role === "BUYER" && user.accountStatus !== "APPROVED") redirect("/buyer/pending");
  // Figures follow the book's veil: balances and prices are for Pro and the desk.
  const pro = user.role === "ADMIN" || isPro(user);
  // The book is for buyers and the desk. A seller following an event notice sees the calendar without its links.
  const canBook = user.role === "BUYER" || user.role === "ADMIN";
  // A round whose date passed moves before the page prints it. A failure here leaves it for the daily job.
  await advanceSaleEvents().catch(() => null);
  const events = await openEvents();
  // Only listings on the public book count, so a withdrawn or declined file never shows here.
  const listings = events.length
    ? await prisma.listing.findMany({
        where: { saleEventId: { in: events.map((event) => event.id) }, status: { in: ["APPROVED", "PENDING", "SOLD"] } },
        select: { saleEventId: true, sellerId: true, status: true, notes: { select: { upb: true, askingPrice: true, tradeStatus: true } } },
      })
    : [];

  return (
    <div>
      <PageIntro
        eyebrow="Sale events"
        title="Dated sales, two rounds each."
        lede="Each event takes sealed indications by its first date. Then every buyer who can bid gets one best-and-final bid by the second date. The desk awards after that."
      />
      {events.length === 0 && (
        <div className="mt-8 border border-dashed border-link/30 p-10 rounded-xl">
          <p className="font-semibold tracking-tight text-2xl text-foreground">No events on the calendar.</p>
          <p className="mt-2 text-sm text-muted-foreground">
            The desk posts each one here with both dates.{canBook && <> <Link href="/marketplace" className="text-link">Browse the book</Link> in the meantime.</>}
          </p>
        </div>
      )}
      <ul className="mt-6 grid gap-4 lg:grid-cols-2">
        {events.map((event) => {
          const own = listings.filter((listing) => listing.saleEventId === event.id);
          const sellers = new Set(own.map((listing) => listing.sellerId)).size;
          const loans = own.flatMap((listing) => loansForSale(listing.status, listing.notes));
          const upb = loans.reduce((sum, loan) => sum + num(loan.upb), 0);
          const ask = loans.reduce((sum, loan) => sum + num(loan.askingPrice), 0);
          return (
            <li key={event.id} id={event.id} className="scroll-mt-6 border border-border p-5 rounded-xl">
              <p className="text-xs font-medium text-link">{EVENT_STATUS_LABEL[event.status] ?? event.status}</p>
              <h2 className="mt-1 font-semibold tracking-tight text-xl text-foreground">{event.name}</h2>
              {event.summary && <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{event.summary}</p>}
              <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground">Indications due</dt>
                  <dd className="mt-1 text-sm font-medium text-foreground tabular-nums">{when(event.indicationsAt)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Best and final due</dt>
                  <dd className="mt-1 text-sm font-medium text-foreground tabular-nums">{when(event.bestFinalAt)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Listings</dt>
                  <dd className="mt-1 text-sm font-medium text-foreground tabular-nums">
                    {own.length} from {sellers} seller{sellers === 1 ? "" : "s"} · {loans.length} loan{loans.length === 1 ? "" : "s"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Balance and ask</dt>
                  <dd className="mt-1 text-sm font-medium text-foreground tabular-nums">
                    {pro ? (loans.length ? `${money(upb)} UPB · ${money(ask)} ask` : "—") : "Open with Pro"}
                  </dd>
                </div>
              </dl>
              <p className="mt-4 text-sm text-foreground">{roundText(event)}</p>
              {own.length > 0 ? (canBook && (
                <Link href={`/marketplace?event=${event.id}`} className="mt-4 inline-flex h-10 items-center rounded-lg border border-border px-4 text-[13px] font-medium text-foreground hover:border-foreground/30">
                  See the {own.length} listing{own.length === 1 ? "" : "s"}
                </Link>
              )) : (
                <p className="mt-4 text-sm text-muted-foreground">Listings to come.</p>
              )}
            </li>
          );
        })}
      </ul>
      {!pro && user.role === "BUYER" && events.length > 0 && (
        <p className="mt-6 text-sm text-muted-foreground">
          Balances and asks are veiled on the free desk. <Link href="/buyer/subscription" className="text-link">See Pro</Link>
        </p>
      )}
    </div>
  );
}
