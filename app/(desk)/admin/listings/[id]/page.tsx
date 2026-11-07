import { notFound } from "next/navigation";
import Link from "next/link";
import { adminUpdateListing, reviewListing } from "@/actions/admin";
import { placeDeskBid } from "@/actions/desk-book";
import { addEventListing, removeEventListing } from "@/actions/sale-events";
import { sendToBuyers } from "@/actions/outreach";
import { AuctionForm } from "@/components/auction-form";
import { ComplianceNote } from "@/components/compliance-note";
import { DeskNotes } from "@/components/desk-notes";
import { DiscrepancyDesk } from "@/components/discrepancy-desk";
import { LaunchControls } from "@/components/launch-controls";
import { DocumentReaderPanel } from "@/components/document-reader";
import { QuestionQueue } from "@/components/listing-questions";
import { RoomAccessPanel } from "@/components/room-access";
import { LoanFileDesk } from "@/components/loan-file-desk";
import { PhotoManager } from "@/components/photo-manager";
import { ResultConsent } from "@/components/result-consent";
import { StandingBidSheet } from "@/components/standing-bid-sheet";
import { BidLoanPrices } from "@/components/bid-loan-prices";
import { PoolPlanPanel } from "@/components/pool-plan";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { isPrivateDocument } from "@/lib/acl";
import { accessLog } from "@/lib/access-log";
import { listingActivity } from "@/lib/activity";
import { realName } from "@/lib/bidder-alias";
import { questionQueue } from "@/lib/questions";
import { roomRequests } from "@/lib/room-access";
import { deadlinePassed, deskWalled, eventSetsTerms } from "@/lib/auction";
import { requireRole } from "@/lib/auth";
import { bidSheetFor, type BidRow } from "@/lib/bid-sheet";
import { bidEntityNames } from "@/lib/buyer-entities";
import { loadPoolPlan } from "@/lib/pool-optimizer";
import { saveDealOwner } from "@/actions/staff";
import { dealOwners, deskCan, deskContact, deskWrites } from "@/lib/staff";
import { gateMessage } from "@/lib/discrepancies";
import { READER_ID, READER_NAME } from "@/lib/ai-reading";
import { money, num, pct, prettyDate, q } from "@/lib/format";
import { labelOf } from "@/lib/labels";
import { launchPending, launchTime } from "@/lib/launch-rules";
import { completeness, completenessLine, groupByNote, verifiedMap } from "@/lib/loan-file";
import { RESEND_AFTER, sendAudience } from "@/lib/outreach";
import { buyerPrice } from "@/lib/offers";
import { DUPLICATE_REASONS, duplicatesFor } from "@/lib/duplicates";
import { prisma } from "@/lib/prisma";
import { feeTerms, rateText } from "@/lib/fee-schedule";
import { getSettings } from "@/lib/settings";
import { joinBlock, leaveBlock, roundText, when } from "@/lib/sale-events";
import { sheetShows, standingSheet } from "@/lib/standing-bids";
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
      // Photos have their own panel, so the file lists and the desk's document pickers leave them out.
      documents: { where: { type: { not: "PHOTO" } } },
      inquiries: { include: { buyer: true, messages: { select: { kind: true, amount: true, createdAt: true, authorId: true } } }, orderBy: { createdAt: "desc" } },
      reviews: { include: { author: true }, orderBy: { createdAt: "desc" } },
      matches: { include: { buyBox: { include: { user: true } } }, orderBy: { score: "desc" } },
      deskBids: { orderBy: { createdAt: "desc" }, take: 5 },
    },
  });
  if (!listing) notFound();
  const note = listing.notes[0];
  const ask = listing.notes.reduce((sum, item) => sum + num(item.askingPrice), 0);
  const settings = await getSettings();
  // Standing bids show while the tape is in review or live, so the desk sees demand before it approves.
  const standingOpen = sheetShows(listing.status);
  const [activity, audience, bids, standing] = await Promise.all([
    listingActivity(listing.id, listing.sellerId),
    sendAudience(listing.id),
    bidSheetFor(user, listing.id, settings.buyerPremiumBps),
    standingOpen ? standingSheet(listing) : Promise.resolve([]),
  ]);
  // The room as the desk sees it: real names, with each bidder's letter in the log so the desk and seller agree.
  const [questions, requests, log] = await Promise.all([questionQueue(listing.id), roomRequests(listing.id), accessLog(listing.id, user)]);
  const now = Date.now();
  const sentRecently = (at: Date | null) => Boolean(at && now - at.getTime() < RESEND_AFTER.LISTING);
  const deadlineOpen = listing.bidMode !== "NONE" && Boolean(listing.bidDeadline && listing.bidDeadline.getTime() > now);
  // Marking by hand waits for the deadline, as an award does. The action checks the same rule.
  const biddingOpen = listing.bidMode !== "NONE" && !deadlinePassed(listing.bidDeadline, new Date(now));
  const canMarkSold = deskDecisionAllowed("MARK_SOLD", listing.status) && !biddingOpen;
  const listingHref = `/admin/listings/${listing.id}`;
  // The loan file shows one loan at a time, so a 2,000-loan pool is one set of forms, not 2,000.
  const fileNote = listing.notes.find((item) => item.id === q(query, "loan")) ?? note;
  // Loans that look like ones on another open listing. A relist is legitimate, so this informs and never blocks.
  const duplicates = await duplicatesFor(listing.id);
  const noteIds = listing.notes.map((item) => item.id);
  const [allCollateral, allRisks, differences] = await Promise.all([
    prisma.collateralItem.findMany({ where: { noteId: { in: noteIds } }, orderBy: [{ sequence: "asc" }, { createdAt: "asc" }] }),
    prisma.riskCheck.findMany({ where: { noteId: { in: noteIds } }, orderBy: { checkedAt: "desc" } }),
    prisma.fieldDiscrepancy.findMany({ where: { listingId: listing.id }, orderBy: { createdAt: "desc" } }),
  ]);
  // Approval waits on every open tape difference. The action refuses on the same count.
  const approvalGate = gateMessage(differences.filter((row) => row.status === "OPEN").length);
  const holder = listing.clientSellerName || listing.seller.companyName || listing.seller.name || null;
  const collateralByNote = groupByNote(allCollateral);
  const risksByNote = groupByNote(allRisks);
  const fileCollateral = fileNote ? collateralByNote.get(fileNote.id) ?? [] : [];
  const fileRisks = fileNote ? risksByNote.get(fileNote.id) ?? [] : [];
  const deskIds = [
    ...fileCollateral.map((item) => item.updatedById),
    ...fileRisks.map((check) => check.checkedById),
    ...Object.values(verifiedMap(fileNote?.verifiedFields)).map((entry) => entry.by),
    ...differences.flatMap((row) => [row.raisedById, row.resolvedById]),
  ].filter((value): value is string => Boolean(value));
  const deskPeople = deskIds.length
    ? Object.fromEntries((await prisma.user.findMany({ where: { id: { in: [...new Set(deskIds)] } }, select: { id: true, name: true } })).map((person) => [person.id, person.name]))
    : {};
  const filePosition = fileNote ? listing.notes.findIndex((item) => item.id === fileNote.id) : -1;
  // The sale event this listing trades in, if any, and the events it could still join.
  const [saleEvent, joinable] = await Promise.all([
    listing.saleEventId ? prisma.saleEvent.findUnique({ where: { id: listing.saleEventId } }) : null,
    prisma.saleEvent.findMany({ where: { status: { in: ["PLANNED", "INDICATIONS"] }, indicationsAt: { gt: new Date(now) } }, orderBy: { indicationsAt: "asc" } }),
  ]);
  const liveBids = listing.inquiries.filter((inquiry) => inquiry.type === "OFFER" && ["OPEN", "REVIEWED", "ACCEPTED"].includes(inquiry.status)).length;
  const inEvent = saleEvent && eventSetsTerms(saleEvent.status) ? saleEvent : null;
  const fileHref = (index: number) => (index >= 0 && index < listing.notes.length ? `${listingHref}?loan=${listing.notes[index].id}#loan-file` : null);
  // A pool bid's loan prices and the optimiser's combination are sealed amounts, so they show only beside the sheet.
  const poolLoans = listing.notes.map((item, index) => ({ id: item.id, label: `Loan ${index + 1} · ${item.city}, ${item.state}` }));
  const inquiryOf = new Map(listing.inquiries.map((inquiry) => [inquiry.id, inquiry]));
  // The buying entity a bid is for, when the buyer chose one beyond their main file.
  const entityOf = bids?.length ? await bidEntityNames(listing.inquiries.map((inquiry) => inquiry.buyerEntityId)) : new Map<string, { name: string; kind: string }>();
  const poolPlan = listing.kind === "POOL" && bids?.length ? await loadPoolPlan(listing.id) : null;
  // What this desk role may change here. The actions check the same capabilities; the forms just stay out of the way.
  const sells = deskCan(user, "sales");
  const books = deskCan(user, "deskBook");
  // Sealed and best-and-final amounts stay behind the wall for a role that doesn't read sealed bids.
  const walled = deskWalled(listing, user, new Date(now));
  const [owners, owner] = await Promise.all([sells ? dealOwners() : Promise.resolve([]), deskContact(listing.deskOwnerId)]);

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
        <section aria-labelledby="owner-heading" className="mt-4 flex flex-wrap items-end justify-between gap-3 border border-border p-4 rounded-xl">
          <div className="min-w-0">
            <p id="owner-heading" className="text-[13px] text-muted-foreground">Deal owner</p>
            <p className="text-sm text-foreground">{owner ? `${owner.name} · ${owner.email}` : "No one yet. The seller sees the desk's general contact."}</p>
            {(sells || deskCan(user, "compliance")) && (
              <p className="mt-1 text-[13px] font-medium">
                <a className="text-link" href={`/api/listings/${listing.id}/sale-file`}>Sale file (CSV)</a>
                {" · "}
                <a className="text-link" href={`/api/listings/${listing.id}/sale-file?format=pdf`}>Summary (PDF)</a>
              </p>
            )}
          </div>
          {sells && (
            <form action={saveDealOwner} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="kind" value="listing" />
              <input type="hidden" name="id" value={listing.id} />
              <select name="ownerId" defaultValue={listing.deskOwnerId ?? ""} aria-label="Deal owner" className="desk-input h-9 w-48">
                <option value="">No owner</option>
                {owners.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
              </select>
              <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Saving…">Save owner</SubmitButton>
            </form>
          )}
        </section>
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

        <RoomAccessPanel
          listingId={listing.id}
          from="admin"
          roomApproval={Boolean(listing.roomApproval)}
          editable={sells && ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED"].includes(listing.status)}
          readOnly={!sells}
          requests={requests.map((request) => ({ ...request, bidder: realName(request.user) }))}
          engagement={log.status === 200 ? log.engagement : []}
        />
        <QuestionQueue
          rows={questions.map((row) => ({ ...row, asker: realName(row.asker) }))}
          from="admin"
          live={listing.status === "APPROVED"}
          readOnly={!sells}
          loans={listing.kind === "POOL" ? listing.notes.map((item, index) => ({ id: item.id, label: `Loan ${index + 1} · ${item.streetAddress ? `${item.streetAddress}, ` : ""}${item.city}, ${item.state}` })) : []}
        />

        <section className="mt-6 border border-border p-5 rounded-xl" aria-labelledby="send-heading">
          <p id="send-heading" className="eyebrow">Send to matched buyers</p>
          {!sells ? (
            <p className="mt-2 text-sm text-muted-foreground">Sending listings is for the sales side of the desk. {audience.length} buyer{audience.length === 1 ? "" : "s"} match it.</p>
          ) : listing.status !== "APPROVED" ? (
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
        {books && (
          <form action={placeDeskBid} className="mt-6 grid gap-3 border border-border p-5 sm:grid-cols-2 rounded-xl">
            <p className="eyebrow sm:col-span-2">Desk bid</p>
            <input type="hidden" name="listingId" value={listing.id} />
            <label className="block"><span className="text-[13px] text-muted-foreground">Amount</span><input name="amount" inputMode="decimal" className="desk-input mt-2" aria-label="Desk bid amount" required /></label>
            <label className="block"><span className="text-[13px] text-muted-foreground">Note</span><input name="message" className="desk-input mt-2" aria-label="Desk bid note" /></label>
            <div className="sm:col-span-2"><SubmitButton className="h-11 text-[13px] font-medium">Bid for the desk</SubmitButton></div>
            {listing.deskBids.length > 0 && <p className="text-sm text-muted-foreground sm:col-span-2">{listing.deskBids.length} desk bid{listing.deskBids.length === 1 ? "" : "s"} on file. Latest {money(Number(listing.deskBids[0].amount))} · {listing.deskBids[0].status.toLowerCase()}.</p>}
          </form>
        )}

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
              <label><span className="text-[13px] text-muted-foreground">UPB</span><input name="upb" inputMode="decimal" defaultValue={num(note.upb)} className="desk-input mt-2" /></label>
              <label><span className="text-[13px] text-muted-foreground">Asking price</span><input name="askingPrice" inputMode="decimal" defaultValue={num(note.askingPrice)} className="desk-input mt-2" /></label>
              <label><span className="text-[13px] text-muted-foreground">Value</span><input name="estimatedValue" inputMode="decimal" defaultValue={num(note.estimatedValue)} className="desk-input mt-2" /></label>
              <label><span className="text-[13px] text-muted-foreground">Rate</span><input name="interestRate" defaultValue={num(note.interestRate)} className="desk-input mt-2" /></label>
              <label><span className="text-[13px] text-muted-foreground">Monthly P&I</span><input name="monthlyPi" defaultValue={num(note.monthlyPi)} className="desk-input mt-2" /></label>
              <label><span className="text-[13px] text-muted-foreground">Months delinquent</span><input name="monthsDelinquent" defaultValue={note.monthsDelinquent} className="desk-input mt-2" /></label>
            </div>
          )}
          {listing.kind === "POOL" && (
            <div className="relative overflow-x-auto">
              <table className="min-w-full text-left text-xs">
                <thead className="text-xs font-medium text-muted-foreground">
                  <tr>{["Loan", "UPB", "Ask", "Value", "Status"].map((heading) => <th key={heading} className="px-2 py-2 font-normal">{heading}</th>)}</tr>
                </thead>
                <tbody>
                  {listing.notes.map((item) => (
                    <tr key={item.id} className="border-t border-border">
                      <td className="px-2 py-2">{item.city}, {item.state}</td>
                      <td className="px-2 py-2"><input name={`upb_${item.id}`} inputMode="decimal" aria-label={`UPB, loan in ${item.city}, ${item.state}`} defaultValue={num(item.upb)} className="desk-input" /></td>
                      <td className="px-2 py-2"><input name={`ask_${item.id}`} inputMode="decimal" aria-label={`Ask, loan in ${item.city}, ${item.state}`} defaultValue={num(item.askingPrice)} className="desk-input" /></td>
                      <td className="px-2 py-2"><input name={`value_${item.id}`} inputMode="decimal" aria-label={`Value, loan in ${item.city}, ${item.state}`} defaultValue={num(item.estimatedValue)} className="desk-input" /></td>
                      <td className="px-2 py-2">
                        <select name={`status_${item.id}`} aria-label={`Status, loan in ${item.city}, ${item.state}`} defaultValue={item.paymentStatus} className="desk-input">
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
          {sells ? <SubmitButton className="h-11 text-[13px] font-medium">Save edits</SubmitButton> : <p className="text-sm text-muted-foreground">Edits are for the sales side of the desk.</p>}
        </form>

        {duplicates.length > 0 && (
          <section className="mt-8 border border-warn/40 bg-warn/5 p-4 rounded-xl" aria-labelledby="duplicates-heading">
            <p id="duplicates-heading" className="eyebrow">Possible duplicate</p>
            <ul className="mt-2 space-y-1 text-sm text-foreground">
              {duplicates.map((match) => (
                <li key={`${match.noteId}-${match.note.id}`}>
                  Loan in {match.note.city}, {match.note.state} · {DUPLICATE_REASONS[match.reason]} ·{" "}
                  <Link href={`/admin/listings/${match.listing.id}`} className="text-link">{match.listing.title}</Link>
                  {" "}· {match.listing.status.replaceAll("_", " ").toLowerCase()} · {match.seller.name}
                </li>
              ))}
            </ul>
          </section>
        )}

        <DiscrepancyDesk
          rows={differences}
          loans={listing.notes.map((item) => ({ id: item.id, label: `${item.city}, ${item.state} · ${item.streetAddress || "No street"}`, record: item }))}
          people={{ ...deskPeople, [READER_ID]: READER_NAME }}
          listingId={listing.id}
          listingStatus={listing.status}
          readOnly={!sells}
        />

        {fileNote && (
          <LoanFileDesk
            note={fileNote}
            collateral={fileCollateral}
            risks={fileRisks}
            documents={listing.documents.filter((document) => document.noteId === fileNote.id || !isPrivateDocument(document, listing))}
            holder={holder}
            people={deskPeople}
            discrepancies={differences.filter((row) => row.noteId === fileNote.id)}
            listedAt={listing.submittedAt}
            readOnly={!sells}
            heading={`${fileNote.streetAddress || "No street"} · ${fileNote.city}, ${fileNote.state}${fileNote.borrowerName ? ` · ${fileNote.borrowerName}` : ""} · ${labelOf("lien", fileNote.lienPosition)} lien`}
            picker={listing.kind === "POOL" ? {
              action: listingHref,
              previous: fileHref(filePosition - 1),
              next: fileHref(filePosition + 1),
              position: `Loan ${filePosition + 1} of ${listing.notes.length}`,
              options: listing.notes.map((item, index) => ({
                id: item.id,
                label: `${index + 1}. ${item.city}, ${item.state} · ${item.streetAddress || "No street"} · ${completenessLine(completeness(item, collateralByNote.get(item.id) ?? [], risksByNote.get(item.id) ?? [], { holder }))}`,
              })),
            } : undefined}
          />
        )}

        <DocumentReaderPanel listingId={listing.id} noteId={fileNote?.id ?? null} canAct={sells} />

        {standingOpen && <StandingBidSheet listingId={listing.id} status={listing.status} rows={standing} walled={walled} canInvite={sells} />}

        <PhotoManager listing={listing} desk readOnly={!sells} />
        <section id="bids" className="mt-8 scroll-mt-6">
          <p className="eyebrow">Bid sheet</p>
          <p className="mt-1 text-sm text-muted-foreground">Highest price first. All-in includes the buyer premium of {rateText(feeTerms(listing, settings), "premium")} and is checked against the funds the desk verified.</p>
          {bids === null ? (
            <p className="mt-3 text-sm text-muted-foreground">The bid sheet is for desk roles that read sealed bids. Your role sees how many bids there are, not their amounts.</p>
          ) : bids.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No live bids.</p>
          ) : (
            <div className="mt-3 relative overflow-x-auto border border-border rounded-xl">
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
                        {entityOf.get(inquiryOf.get(bid.inquiryId)?.buyerEntityId ?? "") && (
                          <p className="text-xs text-muted-foreground">For {entityOf.get(inquiryOf.get(bid.inquiryId)?.buyerEntityId ?? "")!.name}</p>
                        )}
                        {/* The sheet is behind the sealed-bids wall already, so the seller's pick shows with the amounts. */}
                        {inquiryOf.get(bid.inquiryId)?.sellerRequestedAt && (
                          <p className="text-xs font-medium text-foreground">Seller asked to award this bid</p>
                        )}
                        {!bid.noteLabel && <BidLoanPrices loanPrices={inquiryOf.get(bid.inquiryId)?.loanPrices} allowPartial={inquiryOf.get(bid.inquiryId)?.allowPartial} price={bid.amount} loans={poolLoans} />}
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
          {poolPlan && (
            <PoolPlanPanel
              listingId={listing.id}
              plan={poolPlan.plan}
              loans={poolPlan.loans}
              canAward={deskCan(user, "sales") && listing.status === "APPROVED" && !biddingOpen}
              waiting={listing.status !== "APPROVED" ? "The listing isn't live, so the combination can't be awarded." : biddingOpen ? "Award this after the bid deadline." : deskCan(user, "sales") ? null : "Your desk role doesn't cover awards."}
            />
          )}
        </section>

        <section className="mt-8">
          <p className="eyebrow">Inquiries</p>
          <ul className="mt-3 space-y-3">
            {listing.inquiries.map((inquiry) => (
              <li key={inquiry.id} className="border border-border p-4 rounded-xl">
                <p className="text-sm text-foreground">{inquiry.buyer.name} · {inquiry.type.replaceAll("_", " ").toLowerCase()} · {inquiry.status.toLowerCase()}</p>
                {inquiry.amount && walled && inquiry.type === "OFFER" && <p className="text-sm text-muted-foreground">Amount sealed until the deadline.</p>}
                {inquiry.amount && !(walled && inquiry.type === "OFFER") && (
                  <p className="font-semibold tracking-tight text-3xl tabular-nums">
                    {money(buyerPrice(num(inquiry.amount), inquiry.messages.map((message) => ({ ...message, amount: message.amount == null ? null : num(message.amount) })), inquiry.buyerId) ?? num(inquiry.amount))}
                  </p>
                )}
                {/* A buyer's note can quote their price, so it stays behind the wall with the amount. */}
                {!(walled && inquiry.type === "OFFER") && <p className="text-sm text-muted-foreground">{inquiry.message}</p>}
                {/* Awards and declines happen on the offer book, which shows the counters, the seller's answer and the all-in. */}
                {(inquiry.status === "OPEN" || inquiry.status === "REVIEWED") && (
                  <Link href={`/admin/offers#offer-${inquiry.id}`} className="mt-3 inline-block text-[13px] font-medium text-link">Decide on the offer book</Link>
                )}
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
        {listing.status === "APPROVED" && launchPending(listing) && listing.launchAt && (
          <p role="status" className="rounded-lg border border-link/30 bg-link/5 px-3 py-2 text-sm text-foreground tabular-nums">
            Coming soon until {launchTime(listing.launchAt)}. Buyers see a teaser and can save it. The room, bids and alerts open at that time.
          </p>
        )}
        {sells && listing.status === "APPROVED" && launchPending(listing) && listing.launchAt && <LaunchControls listingId={listing.id} launchAt={listing.launchAt} />}
        {!sells ? (
          <p className="text-sm text-muted-foreground">Review decisions are for the sales side of the desk.</p>
        ) : (
        <form action={reviewListing} className="space-y-3">
          <input type="hidden" name="listingId" value={listing.id} />
          <label className="block text-sm text-muted-foreground">
            Comment to the seller
            <textarea name="comment" className="desk-input mt-2 min-h-28" />
          </label>
          {deskDecisionAllowed("APPROVE", listing.status) && (
            <label className="block text-sm text-muted-foreground">
              Launch time (UTC), for Approve
              <input name="launchAt" type="datetime-local" className="desk-input mt-2" aria-describedby="launch-hint" />
              <span id="launch-hint" className="mt-1 block text-xs">Leave blank to go live now. A future time shows it as coming soon until then.</span>
            </label>
          )}
          {canMarkSold && (
            <>
              <label className="block text-sm text-muted-foreground">
                Sale price
                <input name="salePrice" defaultValue={ask} className="desk-input mt-2" />
              </label>
              <label className="block text-sm text-muted-foreground">
                Seller&apos;s agreement, for Mark sold
                <input name="consent" className="desk-input mt-2" maxLength={300} placeholder="The seller’s email and its date" />
              </label>
            </>
          )}
          <div className="grid gap-2">
            {/* Only the decisions that apply from this status; the action checks the same rule. */}
            {deskDecisionAllowed("UNDER_REVIEW", listing.status) && <Decision action="UNDER_REVIEW" label="Mark under review" />}
            {deskDecisionAllowed("APPROVE", listing.status) && (approvalGate ? (
              <p role="status" className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-foreground">
                Approval is on hold. {approvalGate} <a href="#differences" className="font-medium text-link">See the differences</a>
              </p>
            ) : <Decision action="APPROVE" label="Approve · live now, or at the launch time" />)}
            {deskDecisionAllowed("REQUEST_CHANGES", listing.status) && <Decision action="REQUEST_CHANGES" label="Request changes" />}
            {deskDecisionAllowed("REJECT", listing.status) && <Decision action="REJECT" label="Reject" />}
            {deskDecisionAllowed("MARK_PENDING", listing.status) && !biddingOpen && <Decision action="MARK_PENDING" label="Mark in contract" />}
            {canMarkSold && <Decision action="MARK_SOLD" label="Mark sold" />}
            {biddingOpen && (deskDecisionAllowed("MARK_PENDING", listing.status) || deskDecisionAllowed("MARK_SOLD", listing.status)) && (
              <p className="text-sm text-muted-foreground">Bids are open. Mark in contract or sold after the deadline.</p>
            )}
            {listing.status === "SOLD" && <p className="text-sm text-muted-foreground">Sold. No further decisions apply.</p>}
          </div>
        </form>
        )}
        <ul className="space-y-1 text-xs text-muted-foreground">
          {listing.documents.map((document) => (
            <li key={document.id}><a className="text-link" href={`/api/documents/${document.id}`}>{document.originalName}</a></li>
          ))}
        </ul>
        {note && <p className="text-xs text-muted-foreground">{labelOf("payment", note.paymentStatus)} · {labelOf("lien", note.lienPosition)}</p>}
        {inEvent ? (
          <EventPanel listingId={listing.id} event={inEvent} leave={sells ? leaveBlock({ eventStatus: inEvent.status, liveBids }) : "Sale events are run by the sales side of the desk."} />
        ) : !sells ? (
          <p className="mt-6 text-sm text-muted-foreground">Bid terms: {listing.bidMode === "NONE" ? "open offers" : `${listing.bidMode.replaceAll("_", " ").toLowerCase()} until ${prettyDate(listing.bidDeadline)}`}. The sales side of the desk sets them.</p>
        ) : (
          <>
            <AuctionForm listingId={listing.id} bidMode={listing.bidMode} deadline={listing.bidDeadline} canAnnounce={listing.status === "APPROVED"} />
            {listing.status === "APPROVED" && (
              <EventJoin
                listingId={listing.id}
                events={joinable}
                block={joinable[0] ? joinBlock({ event: joinable[0], listing, currentEventStatus: null, liveBids, consent: "recorded", now: new Date(now) }) : null}
              />
            )}
          </>
        )}
        <ResultConsent listing={listing} desk readOnly={!sells} />
        <DeskNotes subjectType="listing" subjectId={listing.id} back={listingHref} viewerId={user.id} readOnly={!deskWrites(user)} />
      </aside>
    </div>
  );
}

type EventRow = { id: string; name: string; status: string; indicationsAt: Date; bestFinalAt: Date };

// An open sale event sets this listing's terms, so its panel stands where the bid terms form would.
function EventPanel({ listingId, event, leave }: { listingId: string; event: EventRow; leave: string | null }) {
  return (
    <section aria-labelledby="sale-event-heading" className="mt-6 space-y-3 border border-border p-4 rounded-xl">
      <p id="sale-event-heading" className="eyebrow">Sale event</p>
      <p className="text-sm text-foreground">
        In <Link href={`/admin/events/${event.id}`} className="font-medium text-link">{event.name}</Link>, which sets its bid terms.
      </p>
      <p className="text-sm text-muted-foreground tabular-nums">Indications due {when(event.indicationsAt)}. Best and final due {when(event.bestFinalAt)}.</p>
      <p className="text-sm text-foreground">{roundText(event)}</p>
      {leave ? (
        <p className="text-xs text-muted-foreground">{leave}</p>
      ) : (
        <form action={removeEventListing}>
          <input type="hidden" name="eventId" value={event.id} />
          <input type="hidden" name="listingId" value={listingId} />
          <input type="hidden" name="back" value="listing" />
          <ConfirmSubmit
            title="Take this listing out of the event?"
            consequence="It goes back to open offers with no deadline, and its seller is told."
            confirmLabel="Take it out"
            pendingLabel="Saving…"
            variant="outline"
            className="h-10 w-full text-[13px] font-medium"
          >
            Take out of the event
          </ConfirmSubmit>
        </form>
      )}
    </section>
  );
}

// Entering a live listing in an event, on the seller's recorded agreement.
function EventJoin({ listingId, events, block }: { listingId: string; events: EventRow[]; block: string | null }) {
  if (events.length === 0) return null;
  return (
    <form action={addEventListing} className="mt-6 space-y-3 border border-border p-4 rounded-xl">
      <p className="eyebrow">Sale event</p>
      {block ? (
        <p className="text-sm text-muted-foreground">{block}</p>
      ) : (
        <>
          <input type="hidden" name="listingId" value={listingId} />
          <input type="hidden" name="back" value="listing" />
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Event</span>
            <select name="eventId" required className="desk-input mt-2">
              {events.map((event) => (
                <option key={event.id} value={event.id}>{event.name} · indications {when(event.indicationsAt)}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">How the seller agreed</span>
            <input name="consent" required minLength={3} maxLength={300} className="desk-input mt-2" placeholder="The seller’s email and its date" />
          </label>
          <ConfirmSubmit
            title="Enter this listing in the event?"
            consequence="Its bid terms become the event's: sealed indications until the indications date, then one best-and-final bid each until the second date. Awards wait for that date. The seller is emailed with the agreement you recorded."
            typed={[["Seller's agreement", "consent", "text"]]}
            confirmLabel="Enter the listing"
            pendingLabel="Adding…"
            className="h-10 w-full text-[13px] font-medium"
          >
            Add to the event
          </ConfirmSubmit>
        </>
      )}
    </form>
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

// Mark sold and Reject can't be taken back from this page, so they ask first and restate what was typed.
function Decision({ action, label }: { action: string; label: string }) {
  if (action === "MARK_SOLD") {
    return (
      <ConfirmSubmit
        name="action"
        value={action}
        title="Mark this listing sold?"
        consequence="This records the sale at the price below, posts the premium and commission, marks every loan sold, emails the seller and declines the open bids. It can't be undone from here."
        typed={[["Sale price", "salePrice", "money"], ["Seller's agreement", "consent", "text"]]}
        confirmLabel="Mark sold"
        pendingLabel="Recording…"
        className="h-10 w-full text-[13px] font-medium"
      >
        {label}
      </ConfirmSubmit>
    );
  }
  if (action === "REJECT") {
    return (
      <ConfirmSubmit
        name="action"
        value={action}
        title="Reject this listing?"
        consequence="The seller is told it was rejected, with your comment, and it comes off the book. To list it again they file a new one."
        typed={[["Comment to the seller", "comment", "text"]]}
        confirmLabel="Reject the listing"
        pendingLabel="Rejecting…"
        tone="danger"
        className="h-10 w-full text-[13px] font-medium"
      >
        {label}
      </ConfirmSubmit>
    );
  }
  if (action === "MARK_PENDING") {
    return (
      <ConfirmSubmit
        name="action"
        value={action}
        title="Mark this listing in contract?"
        consequence="It stops taking bids and its data room closes to everyone but the desk. Use this only when a sale is agreed outside the offer book."
        confirmLabel="Mark in contract"
        pendingLabel="Saving…"
        className="h-10 w-full text-[13px] font-medium"
      >
        {label}
      </ConfirmSubmit>
    );
  }
  return (
    <SubmitButton
      name="action"
      value={action}
      variant={action === "REQUEST_CHANGES" ? "outline" : "default"}
      pendingLabel="Saving…"
      className="h-10 w-full text-[13px] font-medium"
    >
      {label}
    </SubmitButton>
  );
}
