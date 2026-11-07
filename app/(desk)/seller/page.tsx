import Link from "next/link";
import { MarketView } from "@/components/market-view";
import { MasterAgreementBanner } from "@/components/master-agreement-banner";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SellerIdentityBanner } from "@/components/seller-identity";
import { StatusPill } from "@/components/status-pill";
import { requireRole } from "@/lib/auth";
import { compsFor, loadClosedTrades, marketView, suggestedPrice } from "@/lib/comps";
import { isReleaseBuild } from "@/lib/deploy";
import { money, num, q } from "@/lib/format";
import { feeTerms, feesFor, rateText } from "@/lib/fee-schedule";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "Seller desk" };

export default async function SellerHome({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER", "ADMIN"]);
  const params = await searchParams;
  const settings = await getSettings();
  const listings = await prisma.listing.findMany({
    where: { sellerId: user.id },
    include: { notes: true, inquiries: true },
    orderBy: { createdAt: "desc" },
  });
  const liveListings = listings.filter((listing) => listing.status === "APPROVED" || listing.status === "PENDING");
  const askOf = (listing: (typeof listings)[number]) => listing.notes.reduce((sum, note) => sum + num(note.askingPrice), 0);
  const liveAsk = liveListings.reduce((sum, listing) => sum + askOf(listing), 0);
  // Each listing at its own fees on its own ask, since a graded schedule charges by the size of each sale.
  const commission = liveListings.reduce((sum, listing) => sum + feesFor(listing, settings, askOf(listing)).commissionCents / 100, 0);
  const today = feeTerms(null, settings);
  const soldNet = listings.filter((listing) => listing.netToSellerCents != null).reduce((sum, listing) => sum + (listing.netToSellerCents ?? 0), 0);
  const [peers, trades] = await Promise.all([
    prisma.note.findMany({
      where: { listing: { status: { in: ["APPROVED", "PENDING"] }, kind: "SINGLE" } },
      select: { state: true, paymentStatus: true, upb: true, askingPrice: true, listingId: true },
    }),
    loadClosedTrades(),
  ]);
  const book = peers.map((note) => ({
    state: note.state,
    paymentStatus: note.paymentStatus,
    upb: num(note.upb),
    askingPrice: num(note.askingPrice),
    listingId: note.listingId,
  }));
  const views = listings.reduce((sum, listing) => sum + listing.viewCount, 0);
  const offers = listings.reduce((sum, listing) => sum + listing.inquiries.filter((inquiry) => inquiry.type === "OFFER").length, 0);

  return (
    <div>
      <PageIntro
        eyebrow="Seller desk"
        title={user.companyName || user.name}
        lede={`Commission comes off the accepted price: ${rateText(today, "commission")}. Buyers also pay a premium on top, ${rateText(today, "premium")}. It is not taken from you.`}
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <MasterAgreementBanner user={user} kind="MASTER_SALE" back="/seller" />
      {user.role === "INSTITUTIONAL_SELLER" && user.accountStatus !== "APPROVED" && (
        <p className="mt-6 border border-link/30 bg-link/10 px-4 py-3 text-sm text-foreground rounded-xl">
          {user.companyName || "This institution"} is waiting on the desk. Tape upload opens after approval.
        </p>
      )}
      <SellerIdentityBanner user={user} />
      <div className="mt-8 grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3">
        <Figure k="Live asking price" v={money(liveAsk)} />
        <Figure k="Estimated commission" v={money(commission)} />
        <Figure k="Net on closed trades" v={money(soldNet / 100)} />
        <Figure k="Listing views" v={String(views)} />
        <Figure k="Offers" v={String(offers)} />
        <Figure k="Inquiries" v={String(listings.reduce((sum, listing) => sum + listing.inquiries.length, 0))} />
      </div>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/seller/notes/new" className="inline-flex h-11 items-center bg-primary px-5 text-[13px] font-medium text-primary-foreground rounded-lg">List a note</Link>
        {user.role === "INSTITUTIONAL_SELLER" && (
          <Link href="/seller/pools/new" className="inline-flex h-11 items-center border border-link/40 px-5 text-[13px] font-medium text-link rounded-lg">Upload a tape</Link>
        )}
      </div>
      <div className="mt-10 divide-y divide-border border border-border rounded-xl">
        {listings.length === 0 && <p className="px-5 py-8 text-sm text-muted-foreground">Nothing listed yet.</p>}
        {listings.map((listing) => {
          const ask = listing.notes.reduce((sum, note) => sum + num(note.askingPrice), 0);
          const subject = listing.kind === "SINGLE" && listing.notes[0]
            ? {
                state: listing.notes[0].state,
                paymentStatus: listing.notes[0].paymentStatus,
                upb: num(listing.notes[0].upb),
                askingPrice: num(listing.notes[0].askingPrice),
              }
            : null;
          const suggestion = subject
            ? suggestedPrice(subject, book.filter((row) => row.listingId !== listing.id))
            : null;
          const closed = listing.kind === "SINGLE" && listing.notes[0]
            ? compsFor({ state: listing.notes[0].state, lienPosition: listing.notes[0].lienPosition, paymentStatus: listing.notes[0].paymentStatus }, trades)
            : null;
          const offerCount = listing.inquiries.filter((inquiry) => inquiry.type === "OFFER").length;
          return (
            <Link key={listing.id} href={`/seller/listings/${listing.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-5 hover:bg-muted/60">
              <div>
                <p className="font-semibold tracking-tight text-2xl text-foreground">{listing.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {listing.kind === "POOL" ? `${listing.notes.length} loans` : listing.notes[0]?.city} · {listing.viewCount} views · {listing.inquiries.length} inquiries · {offerCount} offers · ask {money(ask)}
                </p>
                {suggestion && (
                  <p className="mt-1 text-sm text-link tabular-nums">Suggested {money(suggestion.price)} from {suggestion.sample} live asks at {suggestion.priceToUpb.toFixed(0)}% of UPB.</p>
                )}
                {closed && (
                  <p className="mt-1 text-sm text-muted-foreground tabular-nums">
                    Closed trades like this: median {closed.median}% of UPB across {closed.count} ({closed.label}).
                  </p>
                )}
              </div>
              <StatusPill status={listing.status} />
            </Link>
          );
        })}
      </div>
      <div className="mt-10">
        <MarketView view={marketView(trades)} audience="seller" demo={!isReleaseBuild(process.env)} />
      </div>
    </div>
  );
}

function Figure({ k, v }: { k: string; v: string }) {
  return (
    <div className="glass @container p-4 sm:p-5">
      <p className="eyebrow">{k}</p>
      {/* Sized to the card, so a long figure shrinks to fit rather than overflowing or breaking mid-number. */}
      <p className="figure mt-2 text-[clamp(1.125rem,13cqi,1.875rem)] leading-tight font-semibold tracking-tight whitespace-nowrap text-foreground sm:mt-3">{v}</p>
    </div>
  );
}
