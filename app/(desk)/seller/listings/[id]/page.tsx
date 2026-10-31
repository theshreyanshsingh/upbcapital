import Link from "next/link";
import { notFound } from "next/navigation";
import { bulkReprice, duplicateListing } from "@/actions/desk";
import { answerDeskBid } from "@/actions/desk-book";
import { updateOwnListingMeta } from "@/actions/listings";
import { AuctionForm } from "@/components/auction-form";
import { ComplianceNote } from "@/components/compliance-note";
import { Countdown } from "@/components/countdown";
import { Notice } from "@/components/notice";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { hideCompetingBids } from "@/lib/auction";
import { docLabel } from "@/lib/labels";
import { money, num, prettyDate, q } from "@/lib/format";
import { bpsToPercent } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "Your listing" };

export default async function SellerListingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER", "ADMIN"]);
  const { id } = await params;
  const query = await searchParams;
  const listing = await prisma.listing.findUnique({
    where: { id },
    include: { notes: true, documents: true, seller: true, inquiries: { include: { buyer: true } }, deskBids: { where: { status: "OPEN" }, orderBy: { createdAt: "desc" } }, reviews: { include: { author: true }, orderBy: { createdAt: "desc" } } },
  });
  if (!listing || (listing.sellerId !== user.id && user.role !== "ADMIN")) notFound();
  const settings = await getSettings();
  const ask = listing.notes.reduce((sum, note) => sum + num(note.askingPrice), 0);
  const commission = listing.sellerCommissionCents != null ? listing.sellerCommissionCents / 100 : (ask * settings.sellerCommissionBps) / 10000;
  const net = listing.netToSellerCents != null ? listing.netToSellerCents / 100 : ask - commission;
  const editable = listing.status === "SUBMITTED" || listing.status === "CHANGES_REQUESTED";
  const sealed = hideCompetingBids({ bidMode: listing.bidMode, deadline: listing.bidDeadline, isDesk: user.role === "ADMIN" });

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div>
        <Notice notice={q(query, "notice")} error={q(query, "error")} />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <StatusPill status={listing.status} />
          <span className="text-[13px] font-medium text-muted-foreground">{listing.kind === "POOL" ? `${listing.notes.length} loans` : "Single note"}</span>
        </div>
        <h1 className="mt-4 font-semibold tracking-tight text-[28px] text-foreground">{listing.title}</h1>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">{listing.summary}</p>
        <ComplianceNote states={listing.notes.map((note) => note.state)} sellerFinanced={listing.sellerFinanced} sellerRole={listing.seller.role} />
        {editable && listing.kind === "SINGLE" && (
          <Link href={`/seller/listings/${listing.id}/edit`} className="mt-6 inline-flex h-11 items-center border border-link/40 px-5 text-[13px] font-medium text-link rounded-lg">Edit and resubmit</Link>
        )}
        {editable && listing.kind === "POOL" && (
          <form action={updateOwnListingMeta} className="mt-8 space-y-4 border border-border p-5 rounded-xl">
            <input type="hidden" name="listingId" value={listing.id} />
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Pool name</span>
              <input name="title" defaultValue={listing.title} className="desk-input mt-2" />
            </label>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Narrative</span>
              <textarea name="summary" defaultValue={listing.summary} className="desk-input mt-2 min-h-28" />
            </label>
            <SubmitButton className="h-11 text-[13px] font-medium">Save and resubmit</SubmitButton>
          </form>
        )}
        <section className="mt-10">
          {listing.deskBids.map((bid) => (
            <div key={bid.id} className="mb-6 border border-link/30 bg-link/5 p-4 rounded-xl">
              <p className="eyebrow">The desk bid on this</p>
              <p className="mt-1 font-semibold tracking-tight text-2xl">{money(num(bid.amount))}</p>
              {bid.message && <p className="mt-1 text-sm text-muted-foreground">{bid.message}</p>}
              <p className="mt-2 text-sm text-muted-foreground">Accepting opens a closing with UPB Capital as the buyer. Nothing happens without your answer.</p>
              {listing.sellerId === user.id && (
                <form action={answerDeskBid} className="mt-3 flex flex-wrap gap-2">
                  {/* Not name="id": it shadows form.id in the DOM, and React then drops the clicked button's value. */}
                  <input type="hidden" name="bidId" value={bid.id} />
                  <button type="submit" name="answer" value="ACCEPTED" className="h-9 rounded-lg bg-foreground px-3 text-[13px] font-medium text-background">Accept</button>
                  <button type="submit" name="answer" value="DECLINED" className="h-9 rounded-lg border border-border px-3 text-[13px] font-medium hover:bg-hover">Decline</button>
                </form>
              )}
            </div>
          ))}
          <p className="eyebrow">Inquiries</p>
          <ul className="mt-4 divide-y divide-border border border-border rounded-xl">
            {listing.inquiries.length === 0 && <li className="px-4 py-4 text-sm text-muted-foreground">No inquiries yet.</li>}
            {listing.inquiries.map((inquiry) => (
              <li key={inquiry.id} className="px-4 py-4">
                <p className="text-sm text-foreground">{inquiry.buyer.name} · {inquiry.type.replaceAll("_", " ").toLowerCase()} · {inquiry.status.toLowerCase()}</p>
                {inquiry.amount && !sealed && <p className="mt-1 font-semibold tracking-tight text-2xl">{money(num(inquiry.amount))}</p>}
                {inquiry.amount && sealed && <p className="mt-1 text-sm text-muted-foreground">Amount sealed until the deadline.</p>}
                {!(sealed && inquiry.type === "OFFER") && <p className="mt-1 text-sm text-muted-foreground">{inquiry.message}</p>}
              </li>
            ))}
          </ul>
        </section>
        <section className="mt-8">
          <p className="eyebrow">Desk notes</p>
          <ul className="mt-4 space-y-3">
            {listing.reviews.map((review) => (
              <li key={review.id} className="border border-border px-4 py-3 rounded-xl">
                <p className="text-[13px] font-medium text-link">{review.action.replaceAll("_", " ").toLowerCase()} · {prettyDate(review.createdAt)}</p>
                <p className="mt-2 text-sm text-foreground">{review.comment}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <aside className="glass h-fit p-6">
        <p className="eyebrow">Your economics</p>
        <p className="mt-3 font-semibold tracking-tight text-3xl text-foreground">{money(listing.salePrice ? num(listing.salePrice) : ask)}</p>
        <p className="text-[13px] font-medium text-muted-foreground">{listing.salePrice ? "Sale price" : "Asking price"}</p>
        <dl className="mt-5 space-y-2 text-sm">
          <div className="flex justify-between"><dt className="text-muted-foreground">Commission {bpsToPercent(settings.sellerCommissionBps).toFixed(2)}%</dt><dd>{money(commission)}</dd></div>
          <div className="flex justify-between border-t border-border pt-2"><dt>Estimated net</dt><dd className="font-semibold tracking-tight text-xl">{money(net)}</dd></div>
        </dl>
        <p className="mt-4 text-sm text-muted-foreground">{listing.viewCount} views · {listing.inquiries.length} inquiries</p>
        {listing.bidDeadline && listing.bidMode !== "NONE" && (
          <div className="mt-4"><Countdown deadline={listing.bidDeadline.toISOString()} mode={listing.bidMode} /></div>
        )}
        <AuctionForm listingId={listing.id} bidMode={listing.bidMode} deadline={listing.bidDeadline} />
        {listing.kind === "POOL" && (
          <form action={bulkReprice} className="mt-4 space-y-3 border border-border p-4 rounded-xl">
            <p className="eyebrow">Bulk price</p>
            <input type="hidden" name="listingId" value={listing.id} />
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Percent of UPB</span>
              <input name="percent" type="number" min={1} max={150} step="0.1" defaultValue={80} className="desk-input mt-2" aria-label="Percent of unpaid principal" />
            </label>
            <SubmitButton variant="outline" className="h-10 text-[13px] font-medium">Reprice the tape</SubmitButton>
          </form>
        )}
        <form action={duplicateListing} className="mt-4">
          <input type="hidden" name="listingId" value={listing.id} />
          <SubmitButton variant="ghost" className="h-10 px-0 text-[13px] font-medium text-link">Duplicate listing</SubmitButton>
        </form>
        <ul className="mt-6 space-y-2 text-sm text-muted-foreground">
          {listing.documents.map((document) => (
            <li key={document.id}><a className="text-link" href={`/api/documents/${document.id}`}>{docLabel(document.type)} · {document.originalName}</a></li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
