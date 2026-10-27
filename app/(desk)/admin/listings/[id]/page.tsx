import { notFound } from "next/navigation";
import { adminUpdateListing, decideInquiry, reviewListing } from "@/actions/admin";
import { placeDeskBid } from "@/actions/desk-book";
import { AuctionForm } from "@/components/auction-form";
import { ComplianceNote } from "@/components/compliance-note";
import { Notice } from "@/components/notice";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { money, num, prettyDate, q } from "@/lib/format";
import { labelOf } from "@/lib/labels";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Review listing" };

export default async function AdminListingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole(["ADMIN"]);
  const { id } = await params;
  const query = await searchParams;
  const listing = await prisma.listing.findUnique({
    where: { id },
    include: {
      notes: true,
      seller: true,
      broker: true,
      documents: true,
      inquiries: { include: { buyer: true }, orderBy: { createdAt: "desc" } },
      reviews: { include: { author: true }, orderBy: { createdAt: "desc" } },
      matches: { include: { buyBox: { include: { user: true } } }, orderBy: { score: "desc" } },
      deskBids: { orderBy: { createdAt: "desc" }, take: 5 },
    },
  });
  if (!listing) notFound();
  const note = listing.notes[0];
  const ask = listing.notes.reduce((sum, item) => sum + num(item.askingPrice), 0);

  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div>
        <Notice notice={q(query, "notice")} error={q(query, "error")} />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <StatusPill status={listing.status} />
          <span className="text-sm text-muted-foreground">{listing.seller.companyName || listing.seller.name}</span>
        </div>
        <h1 className="mt-3 font-semibold tracking-tight text-[28px] text-foreground">{listing.title}</h1>
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground">{listing.summary}</p>
        {listing.broker && (
          <p className="mt-3 text-sm text-foreground">
            {listing.brokerRole === "AFFILIATE" ? "Referring affiliate" : "Seller's broker"} {listing.broker.name}
            {listing.clientSellerName ? ` for ${listing.clientSellerName}` : ""}
            {listing.clientRelationship ? ` · ${listing.clientRelationship}` : ""}
          </p>
        )}
        <ComplianceNote states={listing.notes.map((item) => item.state)} sellerFinanced={listing.sellerFinanced} sellerRole={listing.seller.role} />
        <p className="mt-4 text-sm text-foreground">Aggregate ask {money(ask)} · {listing.notes.length} loan{listing.notes.length === 1 ? "" : "s"} · {listing.matches.length} buy-box matches</p>
        {listing.matches.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
            {listing.matches.slice(0, 6).map((match) => (
              <li key={match.id}>{match.buyBox.user.name} · {match.buyBox.name} · {match.score}</li>
            ))}
          </ul>
        )}
        <form action={placeDeskBid} className="mt-6 grid gap-3 border border-border p-5 sm:grid-cols-2 rounded-xl">
          <p className="eyebrow sm:col-span-2">Desk bid</p>
          <input type="hidden" name="listingId" value={listing.id} />
          <label className="block"><span className="text-[13px] text-muted-foreground">Amount</span><input name="amount" className="desk-input mt-2" aria-label="Desk bid amount" required /></label>
          <label className="block"><span className="text-[13px] text-muted-foreground">Note</span><input name="message" className="desk-input mt-2" aria-label="Desk bid note" /></label>
          <div className="sm:col-span-2"><SubmitButton className="h-11 text-[13px] font-medium">Bid for the desk</SubmitButton></div>
          {listing.deskBids.length > 0 && <p className="text-sm text-muted-foreground sm:col-span-2">{listing.deskBids.length} desk bid{listing.deskBids.length === 1 ? "" : "s"} on file. Latest {money(Number(listing.deskBids[0].amount))} · {listing.deskBids[0].status.toLowerCase()}.</p>}
        </form>

        <form action={adminUpdateListing} className="mt-8 space-y-4 border border-border p-5 rounded-xl">
          <p className="eyebrow">Edit</p>
          <input type="hidden" name="listingId" value={listing.id} />
          <label className="block"><span className="text-[13px] text-muted-foreground">Title</span><input name="title" defaultValue={listing.title} className="desk-input mt-2" /></label>
          <label className="block"><span className="text-[13px] text-muted-foreground">Narrative</span><textarea name="summary" defaultValue={listing.summary} className="desk-input mt-2 min-h-24" /></label>
          {listing.kind === "SINGLE" && note && (
            <div className="grid gap-3 md:grid-cols-2">
              <label className="md:col-span-2"><span className="text-[13px] text-muted-foreground">Street</span><input name="streetAddress" defaultValue={note.streetAddress} className="desk-input mt-2" /></label>
              <label><span className="text-[13px] text-muted-foreground">City</span><input name="city" defaultValue={note.city} className="desk-input mt-2" /></label>
              <label><span className="text-[13px] text-muted-foreground">State</span><input name="state" defaultValue={note.state} className="desk-input mt-2" /></label>
              <label><span className="text-[13px] text-muted-foreground">ZIP</span><input name="zip" defaultValue={note.zip} className="desk-input mt-2" /></label>
              <label><span className="text-[13px] text-muted-foreground">Borrower</span><input name="borrowerName" defaultValue={note.borrowerName} className="desk-input mt-2" /></label>
              <label><span className="text-[13px] text-muted-foreground">UPB</span><input name="upb" defaultValue={num(note.upb)} className="desk-input mt-2" /></label>
              <label><span className="text-[13px] text-muted-foreground">Asking price</span><input name="askingPrice" defaultValue={num(note.askingPrice)} className="desk-input mt-2" /></label>
              <label><span className="text-[13px] text-muted-foreground">Value</span><input name="estimatedValue" defaultValue={num(note.estimatedValue)} className="desk-input mt-2" /></label>
              <label><span className="text-[13px] text-muted-foreground">Rate</span><input name="interestRate" defaultValue={num(note.interestRate)} className="desk-input mt-2" /></label>
              <label><span className="text-[13px] text-muted-foreground">Monthly P&I</span><input name="monthlyPi" defaultValue={num(note.monthlyPi)} className="desk-input mt-2" /></label>
              <label><span className="text-[13px] text-muted-foreground">Months delinquent</span><input name="monthsDelinquent" defaultValue={note.monthsDelinquent} className="desk-input mt-2" /></label>
            </div>
          )}
          {listing.kind === "POOL" && (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-xs">
                <thead className="text-xs font-medium text-muted-foreground">
                  <tr>{["Loan", "UPB", "Ask", "Value", "Status"].map((heading) => <th key={heading} className="px-2 py-2 font-normal">{heading}</th>)}</tr>
                </thead>
                <tbody>
                  {listing.notes.map((item) => (
                    <tr key={item.id} className="border-t border-border">
                      <td className="px-2 py-2">{item.city}, {item.state}</td>
                      <td className="px-2 py-2"><input name={`upb_${item.id}`} defaultValue={num(item.upb)} className="desk-input" /></td>
                      <td className="px-2 py-2"><input name={`ask_${item.id}`} defaultValue={num(item.askingPrice)} className="desk-input" /></td>
                      <td className="px-2 py-2"><input name={`value_${item.id}`} defaultValue={num(item.estimatedValue)} className="desk-input" /></td>
                      <td className="px-2 py-2">
                        <select name={`status_${item.id}`} defaultValue={item.paymentStatus} className="desk-input">
                          <option value="PERFORMING">Performing</option>
                          <option value="SUB_PERFORMING">Sub-performing</option>
                          <option value="NON_PERFORMING">Non-performing</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <SubmitButton className="h-11 text-[13px] font-medium">Save edits</SubmitButton>
        </form>

        <section className="mt-8">
          <p className="eyebrow">Inquiries</p>
          <ul className="mt-3 space-y-3">
            {listing.inquiries.map((inquiry) => (
              <li key={inquiry.id} className="border border-border p-4 rounded-xl">
                <p className="text-sm text-foreground">{inquiry.buyer.name} · {inquiry.type.replaceAll("_", " ").toLowerCase()} · {inquiry.status.toLowerCase()}</p>
                {inquiry.amount && <p className="font-semibold tracking-tight text-3xl">{money(num(inquiry.amount))}</p>}
                <p className="text-sm text-muted-foreground">{inquiry.message}</p>
                <div className="mt-3 flex gap-2">
                  {inquiry.type === "OFFER" && inquiry.status === "OPEN" && (
                    <form action={decideInquiry}><input type="hidden" name="inquiryId" value={inquiry.id} /><input type="hidden" name="decision" value="ACCEPT" /><SubmitButton className="h-9 text-[13px] font-medium">Accept</SubmitButton></form>
                  )}
                  {inquiry.status === "OPEN" && (
                    <form action={decideInquiry}><input type="hidden" name="inquiryId" value={inquiry.id} /><input type="hidden" name="decision" value="DECLINE" /><SubmitButton variant="outline" className="h-9 text-[13px] font-medium">Decline</SubmitButton></form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section className="mt-8 space-y-3">
          {listing.reviews.map((review) => (
            <article key={review.id} className="border border-border px-4 py-3 rounded-xl">
              <p className="text-[13px] font-medium text-link">{review.action.replaceAll("_", " ").toLowerCase()} · {review.author.name} · {prettyDate(review.createdAt)}</p>
              <p className="mt-2 text-sm">{review.comment}</p>
            </article>
          ))}
        </section>
      </div>
      <aside className="h-fit space-y-4 border border-link/30 p-5 rounded-xl">
        <p className="eyebrow">Decision</p>
        <form action={reviewListing} className="space-y-3">
          <input type="hidden" name="listingId" value={listing.id} />
          <textarea name="comment" placeholder="Comment to the seller" className="desk-input min-h-28" />
          <label className="block text-sm text-muted-foreground">
            Sale price
            <input name="salePrice" defaultValue={ask} className="desk-input mt-2" />
          </label>
          <div className="grid gap-2">
            <Decision action="UNDER_REVIEW" label="Mark under review" />
            <Decision action="APPROVE" label="Approve · make live" />
            <Decision action="REQUEST_CHANGES" label="Request changes" />
            <Decision action="REJECT" label="Reject" />
            <Decision action="MARK_PENDING" label="Mark in contract" />
            <Decision action="MARK_SOLD" label="Mark sold" />
          </div>
        </form>
        <ul className="space-y-1 text-xs text-muted-foreground">
          {listing.documents.map((document) => (
            <li key={document.id}><a className="text-link" href={`/api/documents/${document.id}`}>{document.originalName}</a></li>
          ))}
        </ul>
        {note && <p className="text-xs text-muted-foreground">{labelOf("payment", note.paymentStatus)} · {labelOf("lien", note.lienPosition)}</p>}
        <AuctionForm listingId={listing.id} bidMode={listing.bidMode} deadline={listing.bidDeadline} />
      </aside>
    </div>
  );
}

function Decision({ action, label }: { action: string; label: string }) {
  const quiet = action === "REJECT" || action === "REQUEST_CHANGES";
  return (
    <button
      type="submit"
      name="action"
      value={action}
      className={quiet
        ? "h-10 w-full border border-border text-[13px] font-medium text-foreground rounded-lg"
        : "h-10 w-full bg-primary text-[13px] font-medium text-primary-foreground rounded-lg"}
    >
      {label}
    </button>
  );
}
