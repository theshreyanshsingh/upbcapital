import { notFound } from "next/navigation";
import { adminUpdateListing, decideInquiry, reviewListing } from "@/actions/admin";
import { placeDeskBid } from "@/actions/desk-book";
import { sendToBuyers } from "@/actions/outreach";
import { AuctionForm } from "@/components/auction-form";
import { ComplianceNote } from "@/components/compliance-note";
import { DeskNotes } from "@/components/desk-notes";
import { Notice } from "@/components/notice";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { listingActivity } from "@/lib/activity";
import { requireRole } from "@/lib/auth";
import { bidSheet, type BidRow } from "@/lib/bid-sheet";
import { money, num, pct, prettyDate, q } from "@/lib/format";
import { labelOf } from "@/lib/labels";
import { RESEND_AFTER, sendAudience } from "@/lib/outreach";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { deskDecisionAllowed } from "@/lib/listing-status";

export const metadata = { title: "Review listing" };

export default async function AdminListingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["ADMIN"]);
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
  const settings = await getSettings();
  const [activity, audience, bids] = await Promise.all([
    listingActivity(listing.id, listing.sellerId),
    sendAudience(listing.id),
    bidSheet(listing.id, settings.buyerPremiumBps),
  ]);
  const now = Date.now();
  const sentRecently = (at: Date | null) => Boolean(at && now - at.getTime() < RESEND_AFTER.LISTING);
  const deadlineOpen = listing.bidMode !== "NONE" && Boolean(listing.bidDeadline && listing.bidDeadline.getTime() > now);
  const listingHref = `/admin/listings/${listing.id}`;

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

        <section className="mt-6 border border-border p-5 rounded-xl" aria-labelledby="activity-heading">
          <p id="activity-heading" className="eyebrow">Buyer activity</p>
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat k="Buyers opened" v={activity.viewers.length} hint={`${activity.viewsThisWeek} opens this week`} />
            <Stat k="Signed NDA" v={activity.ndas.length} />
            <Stat k="Saved" v={activity.favorites.length} />
            <Stat k="Bidders" v={activity.bidders} hint={`${activity.offers} bid${activity.offers === 1 ? "" : "s"} · ${activity.questions} other request${activity.questions === 1 ? "" : "s"}`} />
          </dl>
          {activity.sends.reached > 0 && (
            <p className="mt-3 text-sm text-muted-foreground">
              Sent to {activity.sends.reached} buyer{activity.sends.reached === 1 ? "" : "s"} · {activity.sends.viewed} opened it after · {activity.sends.offered} bid after
            </p>
          )}
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <p className="text-[13px] font-medium text-foreground">Who opened it</p>
              {activity.viewers.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">No buyer has opened it yet.</p>
              ) : (
                <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
                  {activity.viewers.slice(0, 12).map((row) => (
                    <li key={row.user.id}>{row.user.companyName || row.user.name} · {row.count} open{row.count === 1 ? "" : "s"} · last {prettyDate(row.last)}</li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="text-[13px] font-medium text-foreground">Who signed the NDA</p>
              {activity.ndas.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">No signatures yet.</p>
              ) : (
                <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
                  {activity.ndas.slice(0, 12).map((nda) => (
                    <li key={nda.id}>
                      {nda.signerName || nda.user?.name} · {prettyDate(nda.acknowledgedAt)} · {nda.method.toLowerCase()}
                      {nda.ipAddress ? ` · ${nda.ipAddress}` : ""}
                      {nda.signatureProvider ? ` · ${nda.signatureProvider}${nda.signatureRef ? ` ${nda.signatureRef}` : ""}` : ""}
                    </li>
                  ))}
                </ul>
              )}
              {activity.favorites.length > 0 && (
                <p className="mt-3 text-sm text-muted-foreground">Saved by {activity.favorites.map((favorite) => favorite.user.companyName || favorite.user.name).join(", ")}</p>
              )}
            </div>
          </div>
          <div className="mt-4">
            <p className="text-[13px] font-medium text-foreground">Data room log</p>
            {activity.downloads.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">No buyer has downloaded a file.</p>
            ) : (
              <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
                {activity.downloads.slice(0, 25).map((row) => (
                  <li key={row.id}>{row.actor?.companyName || row.actor?.name} · {row.detail} · {prettyDate(row.createdAt)}</li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="mt-6 border border-border p-5 rounded-xl" aria-labelledby="send-heading">
          <p id="send-heading" className="eyebrow">Send to matched buyers</p>
          {listing.status !== "APPROVED" ? (
            <p className="mt-2 text-sm text-muted-foreground">Approve the listing first. Only live paper goes out.</p>
          ) : audience.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No buyer&apos;s buy box fits this listing yet.</p>
          ) : (
            <form action={sendToBuyers} className="mt-3 space-y-3">
              <input type="hidden" name="listingId" value={listing.id} />
              <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">
                {audience.map((row) => (
                  <li key={row.userId}>
                    <label className={`flex items-start gap-2 ${row.eligible ? "text-foreground" : "text-muted-foreground"}`}>
                      <input type="checkbox" name="buyer" value={row.userId} defaultChecked={row.eligible && !sentRecently(row.lastSent)} disabled={!row.eligible} className="mt-1" />
                      <span>
                        {row.name} · {row.box} · score {row.score}
                        {row.lastSent ? ` · sent ${prettyDate(row.lastSent)}` : ""}
                        {row.offered ? " · bid" : row.viewed ? " · opened" : ""}
                        {row.optedOut ? " · turned off desk picks" : !row.approved ? " · account not approved" : ""}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <textarea name="note" aria-label="Note from the desk" placeholder="Optional line from the desk. No borrower names or addresses." className="desk-input min-h-16" maxLength={400} />
              <p className="text-xs text-muted-foreground">The email carries the title, loan count, states, and a link. Anyone sent this listing in the last 7 days is skipped.</p>
              <div className="flex flex-wrap gap-2">
                <button type="submit" name="kind" value="LISTING" className="h-10 rounded-lg bg-primary px-4 text-[13px] font-medium text-primary-foreground">Send the listing</button>
                {deadlineOpen && (
                  <button type="submit" name="kind" value="DEADLINE" className="h-10 rounded-lg border border-border px-4 text-[13px] font-medium text-foreground">Announce the bid deadline</button>
                )}
              </div>
            </form>
          )}
        </section>
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

        <section id="bids" className="mt-8 scroll-mt-6">
          <p className="eyebrow">Bid sheet</p>
          <p className="mt-1 text-sm text-muted-foreground">Highest price first. All-in includes the {pct(settings.buyerPremiumBps / 100, 2)} premium and is checked against the funds the desk verified.</p>
          {bids.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No live bids.</p>
          ) : (
            <div className="mt-3 overflow-x-auto border border-border rounded-xl">
              <table className="min-w-full text-left text-sm">
                <thead className="text-xs font-medium text-muted-foreground">
                  <tr>{["#", "Buyer", "Bid", "All-in", "Of ask", "Of UPB", "Funds", "Record", "Read"].map((heading) => <th key={heading} className="px-3 py-2 font-normal">{heading}</th>)}</tr>
                </thead>
                <tbody>
                  {bids.map((bid) => (
                    <tr key={bid.inquiryId} className="border-t border-border align-top">
                      <td className="px-3 py-2 text-muted-foreground">{bid.rank}</td>
                      <td className="px-3 py-2">
                        <p className="text-foreground">{bid.buyerName}</p>
                        <p className="text-xs text-muted-foreground">{bid.noteLabel ? `Loan in ${bid.noteLabel}` : "Whole listing"} · {bid.status.toLowerCase()} · {prettyDate(bid.createdAt)}</p>
                      </td>
                      <td className="px-3 py-2 font-medium text-foreground">{money(bid.amount)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{money(bid.allIn)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{pct(bid.ofAsk)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{pct(bid.ofUpb)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{fundsLabel(bid)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{bid.record.closed} closed · {bid.record.canceled} canceled</td>
                      <td className="px-3 py-2">
                        <p className={bid.strength === "strong" ? "text-good" : bid.strength === "weak" ? "text-bad" : "text-foreground"}>{bid.strength}</p>
                        {bid.flags.map((flag) => <p key={flag} className="text-xs text-muted-foreground">{flag}</p>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

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
            {/* Only the decisions that apply from this status; the action checks the same rule. */}
            {deskDecisionAllowed("UNDER_REVIEW", listing.status) && <Decision action="UNDER_REVIEW" label="Mark under review" />}
            {deskDecisionAllowed("APPROVE", listing.status) && <Decision action="APPROVE" label="Approve · make live" />}
            {deskDecisionAllowed("REQUEST_CHANGES", listing.status) && <Decision action="REQUEST_CHANGES" label="Request changes" />}
            {deskDecisionAllowed("REJECT", listing.status) && <Decision action="REJECT" label="Reject" />}
            {deskDecisionAllowed("MARK_PENDING", listing.status) && <Decision action="MARK_PENDING" label="Mark in contract" />}
            {deskDecisionAllowed("MARK_SOLD", listing.status) && <Decision action="MARK_SOLD" label="Mark sold" />}
            {listing.status === "SOLD" && <p className="text-sm text-muted-foreground">Sold. No further decisions apply.</p>}
          </div>
        </form>
        <ul className="space-y-1 text-xs text-muted-foreground">
          {listing.documents.map((document) => (
            <li key={document.id}><a className="text-link" href={`/api/documents/${document.id}`}>{document.originalName}</a></li>
          ))}
        </ul>
        {note && <p className="text-xs text-muted-foreground">{labelOf("payment", note.paymentStatus)} · {labelOf("lien", note.lienPosition)}</p>}
        <AuctionForm listingId={listing.id} bidMode={listing.bidMode} deadline={listing.bidDeadline} canAnnounce={listing.status === "APPROVED"} />
        <DeskNotes subjectType="listing" subjectId={listing.id} back={listingHref} viewerId={user.id} />
      </aside>
    </div>
  );
}

function Stat({ k, v, hint }: { k: string; v: number; hint?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{k}</dt>
      <dd className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{v}</dd>
      {hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}

function fundsLabel(bid: BidRow) {
  const amount = bid.proof.amount != null ? money(bid.proof.amount) : "";
  if (bid.funds === "covered") return `Covered · ${amount}`;
  if (bid.funds === "short") return `Short · ${amount} verified`;
  if (bid.funds === "expired") return `Expired · ${amount}`;
  return "No verified amount";
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
