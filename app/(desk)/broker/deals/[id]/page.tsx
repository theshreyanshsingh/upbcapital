import Link from "next/link";
import { notFound } from "next/navigation";
import { answerDeskBid } from "@/actions/desk-book";
import { resubmitBrokerDeal } from "@/actions/broker";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { DiscrepancyAnswers } from "@/components/discrepancy-answers";
import { ReaderSummary } from "@/components/document-reader";
import { QuestionQueue } from "@/components/listing-questions";
import { RoomAccessPanel } from "@/components/room-access";
import { RoomFiles } from "@/components/room-files";
import { MandateFile } from "@/components/seller-identity";
import { SubmitButton } from "@/components/submit-button";
import { SaleApproval, WithdrawListing } from "@/components/sale-approval";
import { Notice } from "@/components/notice";
import { PhotoManager } from "@/components/photo-manager";
import { ResultConsent } from "@/components/result-consent";
import { accessLog } from "@/lib/access-log";
import { requireRole } from "@/lib/auth";
import { bidderNamer } from "@/lib/bidder-alias";
import { brokerRoleLabel } from "@/lib/broker-fees";
import { money, num, prettyDate, q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { questionQueue } from "@/lib/questions";
import { roomRequests } from "@/lib/room-access";
import { deskContact } from "@/lib/staff";
import { deskBidNotAcceptable } from "@/lib/awards";
import { reviewLabel } from "@/lib/listing-status";

export const metadata = { title: "Deal" };

const TRACK = [
  { key: "filed", label: "Filed", detail: "The desk has the file and the authorization." },
  { key: "review", label: "Desk review", detail: "Nothing is live until this clears." },
  { key: "live", label: "On the book", detail: "Approved buyers can open it." },
  { key: "contract", label: "In contract", detail: "A price is accepted and a closing is open." },
  { key: "closed", label: "Closed", detail: "The fee is calculated and posted." },
] as const;

function stageIndex(status: string) {
  if (status === "SOLD") return 4;
  if (status === "PENDING") return 3;
  if (status === "APPROVED") return 2;
  return 1;
}

// What the desk review step says while the file sits there.
function reviewDetail(status: string, fallback: string) {
  if (status === "REJECTED") return "The desk declined this file.";
  if (status === "CHANGES_REQUESTED") return "The desk asked for changes. Answer them below and resubmit.";
  if (status === "WITHDRAWN") return "This file was withdrawn from the book.";
  return fallback;
}

export default async function BrokerDealPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["BROKER"]);
  const { id } = await params;
  const query = await searchParams;
  const listing = await prisma.listing.findUnique({
    where: { id },
    include: {
      notes: true,
      closings: { include: { brokerFees: true } },
      deskBids: { where: { status: "OPEN" }, orderBy: { createdAt: "desc" } },
      inquiries: { where: { type: "OFFER" }, include: { buyer: true, messages: { select: { kind: true, amount: true, createdAt: true, authorId: true } } } },
      reviews: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!listing || listing.brokerId !== user.id) notFound();
  const differences = await prisma.fieldDiscrepancy.findMany({ where: { listingId: listing.id }, orderBy: { createdAt: "desc" } });
  const ask = listing.notes.reduce((sum, note) => sum + num(note.askingPrice), 0);
  const deskBidBlock = deskBidNotAcceptable(listing);
  const index = stageIndex(listing.status);
  const fees = listing.closings.flatMap((closing) => closing.brokerFees.filter((fee) => fee.brokerId === user.id));
  const declined = listing.status === "REJECTED" || listing.status === "WITHDRAWN";
  const openClosings = listing.closings.filter((closing) => closing.status === "OPEN").length;
  // The desk's decisions and notes, newest first. The broker's own filing note and resubmits show too, for the thread.
  const reviews = listing.reviews;
  const changeRequest = listing.status === "CHANGES_REQUESTED" ? reviews.find((review) => review.action === "REQUEST_CHANGES") : undefined;
  // The room: bidder questions, access requests and the log, with bidders by letter until an award.
  const [nameOf, questions, requests, log] = await Promise.all([
    bidderNamer(listing.id, user),
    questionQueue(listing.id),
    roomRequests(listing.id),
    accessLog(listing.id, user),
  ]);
  const loanOptions = listing.notes.map((note, index) => ({ id: note.id, label: `Loan ${index + 1} · ${note.streetAddress ? `${note.streetAddress}, ` : ""}${note.city}, ${note.state}` }));
  const roomOpenStatus = ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED"].includes(listing.status);
  const contact = await deskContact(listing.deskOwnerId);

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/broker" className="text-[13px] font-medium text-link">Back to the desk</Link>
      <div className="mt-6">
        <Notice notice={q(query, "notice")} error={q(query, "error")} />
      </div>
      <p className="eyebrow mt-6">{brokerRoleLabel(listing.brokerRole)}</p>
      <h1 className="mt-3 font-semibold tracking-tight text-3xl text-foreground">{listing.title}</h1>
      <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
        For {listing.clientSellerName}. {listing.clientRelationship}
      </p>
      {contact && (
        <p className="mt-2 text-sm text-muted-foreground">
          Your desk contact: {contact.name} · <a className="text-link" href={`mailto:${contact.email}`}>{contact.email}</a>
        </p>
      )}
      <dl className="mt-6 grid gap-3 sm:grid-cols-3">
        <Stat k="Asking" v={money(ask)} />
        <Stat k="Loans" v={String(listing.notes.length)} />
        <Stat k="Filed" v={prettyDate(listing.submittedAt)} />
      </dl>
      {listing.summary && <p className="mt-6 text-sm leading-relaxed text-foreground/85">{listing.summary}</p>}
      <DiscrepancyAnswers
        rows={differences}
        loanLabels={Object.fromEntries(listing.notes.map((note) => [note.id, `${note.streetAddress || "No street"}, ${note.city}, ${note.state}`]))}
        canAnswer={listing.brokerId === user.id}
        listingStatus={listing.status}
        client={listing.clientSellerName || "your client"}
      />
      <ReaderSummary listingId={listing.id} />
      {changeRequest && (
        <section className="mt-8 border border-warn/40 bg-warn/10 p-5 rounded-xl" aria-labelledby="changes-heading">
          <p id="changes-heading" className="eyebrow">The desk asked for changes · {prettyDate(changeRequest.createdAt)}</p>
          <p className="mt-2 text-sm text-foreground">{changeRequest.comment}</p>
          <form action={resubmitBrokerDeal} className="mt-4 space-y-4">
            <input type="hidden" name="listingId" value={listing.id} />
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Summary buyers read</span>
              <textarea name="summary" defaultValue={listing.summary} required minLength={10} className="desk-input mt-2 min-h-28" />
            </label>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">What you changed, for the desk</span>
              <textarea name="changes" required minLength={3} className="desk-input mt-2 min-h-20" />
            </label>
            <p className="text-xs text-muted-foreground">
              {listing.kind === "POOL"
                ? "Loan figures can't be edited here yet. Add documents with Add files below. If the desk asked for new figures, say so above and write the desk with the corrected tape."
                : "Loan figures and documents can't be edited here yet. If the desk asked for those, say so above and write the desk with the corrected file."}
            </p>
            <SubmitButton className="h-11 text-[13px] font-medium" pendingLabel="Resubmitting…">Save and resubmit</SubmitButton>
          </form>
        </section>
      )}
      {listing.kind === "POOL" && roomOpenStatus && <RoomFiles listingId={listing.id} from="broker" live={listing.status === "APPROVED"} loans={loanOptions} />}
      <MandateFile listingId={listing.id} open={roomOpenStatus} />
      {listing.status !== "REJECTED" && listing.status !== "WITHDRAWN" && <SaleApproval listing={listing} offers={listing.inquiries} canAnswer={listing.sellerId === user.id} />}
      <QuestionQueue
        rows={questions.map((row) => ({ ...row, asker: nameOf(row.asker) }))}
        from="broker"
        live={listing.status === "APPROVED"}
        loans={listing.kind === "POOL" ? loanOptions : []}
      />
      <RoomAccessPanel
        listingId={listing.id}
        from="broker"
        roomApproval={Boolean(listing.roomApproval)}
        editable={roomOpenStatus}
        requests={requests.map((request) => ({ ...request, bidder: nameOf(request.user) }))}
        engagement={log.status === 200 ? log.engagement : []}
      />
      {listing.deskBids.map((bid) => (
        <div key={bid.id} className="mt-6 border border-link/30 bg-link/5 p-4 rounded-xl">
          <p className="eyebrow">The desk bid on this</p>
          <p className="mt-1 font-semibold tracking-tight text-2xl">{money(num(bid.amount))}</p>
          {bid.message && <p className="mt-1 text-sm text-muted-foreground">{bid.message}</p>}
          <p className="mt-2 text-sm text-muted-foreground">Accepting opens a closing with UPB Capital as the buyer. Answer only with {listing.clientSellerName || "your client"}&apos;s agreement.</p>
          <form action={answerDeskBid} className="mt-3 flex flex-wrap gap-2">
            {/* Not name="id": it shadows form.id in the DOM, and React then drops the clicked button's value. */}
            <input type="hidden" name="bidId" value={bid.id} />
            {!deskBidBlock && (
                  <ConfirmSubmit
                    name="answer"
                    value="ACCEPTED"
                    title={`Sell to UPB Capital at ${money(num(bid.amount))}?`}
                    consequence="Accepting binds your client to sell. It opens a closing with UPB Capital as the buyer at this price, and the other open bids on it are declined."
                    confirmLabel="Accept the desk's bid"
                    pendingLabel="Accepting…"
                    className="h-9 px-3 text-[13px] font-medium"
                  >
                    Accept
                  </ConfirmSubmit>
                )}
            <SubmitButton name="answer" value="DECLINED" variant="outline" pendingLabel="Declining…" className="h-9 px-3 text-[13px] font-medium">Decline</SubmitButton>
          </form>
          {deskBidBlock && <p className="mt-2 text-sm text-muted-foreground">{deskBidBlock}</p>}
        </div>
      ))}

      <ol className="mt-10 space-y-0">
        {TRACK.map((step, stepIndex) => {
          const state = declined && stepIndex > 0 ? "wait" : stepIndex < index ? "done" : stepIndex === index ? "now" : "wait";
          return (
            <li key={step.key} className="grid grid-cols-[28px_minmax(0,1fr)] gap-4">
              <div className="flex flex-col items-center">
                <span className={`mt-1 size-3 rounded-full ${state === "wait" ? "bg-muted" : "bg-primary"} ${state === "now" ? "ring-4 ring-link/25" : ""}`} />
                {stepIndex < TRACK.length - 1 && <span className={`w-px flex-1 ${stepIndex < index ? "bg-link/70" : "bg-muted"}`} />}
              </div>
              <div className="pb-8">
                <p className={`font-semibold tracking-tight text-2xl ${state === "wait" ? "text-muted-foreground" : "text-foreground"}`}>{step.label}</p>
                <p className="mt-1 text-sm text-muted-foreground">{stepIndex === 1 ? reviewDetail(listing.status, step.detail) : step.detail}</p>
              </div>
            </li>
          );
        })}
      </ol>

      {reviews.length > 0 && (
        <section className="mb-8" aria-labelledby="reviews-heading">
          <p id="reviews-heading" className="eyebrow">Desk review</p>
          <ul className="mt-4 space-y-3">
            {reviews.map((review) => (
              <li key={review.id} className="border border-border px-4 py-3 rounded-xl">
                <p className="text-[13px] font-medium text-link">{reviewLabel(review.action)} · {prettyDate(review.createdAt)}</p>
                <p className="mt-2 text-sm text-foreground">{review.comment}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <PhotoManager listing={listing} />
      <ResultConsent listing={listing} client={listing.clientSellerName || undefined} />
      <section className="mt-8 glass p-5 md:p-6">
        <p className="eyebrow">Fee</p>
        {fees.length === 0 && <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Nothing is owed yet. The fee is calculated from the desk’s premium and commission when this file closes.</p>}
        <ul className="mt-3 space-y-3">
          {fees.map((fee) => (
            <li key={fee.id} className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-muted-foreground">{brokerRoleLabel(fee.role)} · {fee.status === "PAID" ? "Paid" : "Owed"}</span>
              <span className="font-semibold tracking-tight text-3xl text-foreground">{money(fee.amountCents / 100)}</span>
            </li>
          ))}
        </ul>
        {listing.authorizationName && <p className="mt-4 text-xs text-muted-foreground">Authorization on file · {listing.authorizationName}</p>}
      </section>
      <WithdrawListing listing={listing} offers={listing.inquiries} ask={ask} openClosings={openClosings} canWithdraw />
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="border border-border px-4 py-3 rounded-xl">
      <dt className="text-xs font-medium text-muted-foreground">{k}</dt>
      <dd className="mt-1 font-semibold tracking-tight text-2xl text-foreground">{v}</dd>
    </div>
  );
}
