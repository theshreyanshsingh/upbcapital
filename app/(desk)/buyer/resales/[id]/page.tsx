import Link from "next/link";
import { notFound } from "next/navigation";
import { answerDeskBid } from "@/actions/desk-book";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/submit-button";
import { DiscrepancyAnswers } from "@/components/discrepancy-answers";
import { QuestionQueue } from "@/components/listing-questions";
import { RoomAccessPanel } from "@/components/room-access";
import { Notice } from "@/components/notice";
import { SaleApproval, WithdrawListing } from "@/components/sale-approval";
import { accessLog } from "@/lib/access-log";
import { requireRole } from "@/lib/auth";
import { bidderNamer } from "@/lib/bidder-alias";
import { money, num, q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { questionQueue } from "@/lib/questions";
import { roomRequests } from "@/lib/room-access";
import { deskBidNotAcceptable } from "@/lib/awards";

export const metadata = { title: "Your resale" };

const STATUS: Record<string, string> = {
  SUBMITTED: "With the desk for review. Nothing is live yet.",
  UNDER_REVIEW: "The desk is reading the file.",
  CHANGES_REQUESTED: "The desk asked for changes.",
  APPROVED: "Live to approved buyers.",
  PENDING: "In contract. The closing checklist is open.",
  SOLD: "Sold.",
  REJECTED: "The desk declined this listing.",
  WITHDRAWN: "You withdrew it from the book.",
};

// A buyer reselling a note they hold is its seller of record, but seller pages are closed to buyer accounts.
// This is where they see the resale and answer the bids that need their word.
export default async function ResalePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["BUYER"]);
  const { id } = await params;
  const query = await searchParams;
  const listing = await prisma.listing.findUnique({
    where: { id },
    include: {
      notes: true,
      inquiries: { where: { type: "OFFER" }, include: { buyer: true, messages: { select: { kind: true, amount: true, createdAt: true, authorId: true } } } },
      deskBids: { where: { status: "OPEN" }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!listing || listing.sellerId !== user.id) notFound();
  const ask = listing.notes.reduce((sum, note) => sum + num(note.askingPrice), 0);
  const deskBidBlock = deskBidNotAcceptable(listing);
  const [openClosings, differences] = await Promise.all([
    prisma.closing.count({ where: { listingId: listing.id, status: "OPEN" } }),
    prisma.fieldDiscrepancy.findMany({ where: { listingId: listing.id }, orderBy: { createdAt: "desc" } }),
  ]);
  // The room, as on a seller's page: bidder questions, access requests and the log, with bidders by letter.
  const [nameOf, questions, requests, log] = await Promise.all([
    bidderNamer(listing.id, user),
    questionQueue(listing.id),
    roomRequests(listing.id),
    accessLog(listing.id, user),
  ]);
  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/buyer/portfolio" className="text-[13px] font-medium text-link">Back to your portfolio</Link>
      <div className="mt-6">
        <Notice notice={q(query, "notice")} error={q(query, "error")} />
      </div>
      <p className="eyebrow mt-6">Your resale</p>
      <h1 className="mt-3 font-semibold tracking-tight text-3xl text-foreground">{listing.title}</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        {STATUS[listing.status] ?? listing.status} Asking {money(ask)} across {listing.notes.length} loan{listing.notes.length === 1 ? "" : "s"}.
      </p>
      <DiscrepancyAnswers
        rows={differences}
        loanLabels={Object.fromEntries(listing.notes.map((note) => [note.id, `${note.streetAddress || "No street"}, ${note.city}, ${note.state}`]))}
        canAnswer
        listingStatus={listing.status}
      />
      {listing.status !== "REJECTED" && listing.status !== "SOLD" && listing.status !== "WITHDRAWN" && (
        <SaleApproval listing={listing} offers={listing.inquiries} canAnswer />
      )}
      {listing.deskBids.map((bid) => (
        <div key={bid.id} className="mt-6 border border-link/30 bg-link/5 p-4 rounded-xl">
          <p className="eyebrow">The desk bid on this</p>
          <p className="mt-1 font-semibold tracking-tight text-2xl">{money(num(bid.amount))}</p>
          {bid.message && <p className="mt-1 text-sm text-muted-foreground">{bid.message}</p>}
          <p className="mt-2 text-sm text-muted-foreground">Accepting opens a closing with UPB Capital as the buyer. Nothing happens without your answer.</p>
          <form action={answerDeskBid} className="mt-3 flex flex-wrap gap-2">
            {/* Not name="id": it shadows form.id in the DOM, and React then drops the clicked button's value. */}
            <input type="hidden" name="bidId" value={bid.id} />
            {!deskBidBlock && (
                  <ConfirmSubmit
                    name="answer"
                    value="ACCEPTED"
                    title={`Sell to UPB Capital at ${money(num(bid.amount))}?`}
                    consequence="Accepting binds you to sell. It opens a closing with UPB Capital as the buyer at this price, and the other open bids on it are declined."
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
      <QuestionQueue
        rows={questions.map((row) => ({ ...row, asker: nameOf(row.asker) }))}
        from="resale"
        live={listing.status === "APPROVED"}
        loans={listing.kind === "POOL" ? listing.notes.map((note, index) => ({ id: note.id, label: `Loan ${index + 1} · ${note.city}, ${note.state}` })) : []}
      />
      <RoomAccessPanel
        listingId={listing.id}
        from="resale"
        roomApproval={Boolean(listing.roomApproval)}
        editable={["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED"].includes(listing.status)}
        requests={requests.map((request) => ({ ...request, bidder: nameOf(request.user) }))}
        engagement={log.status === 200 ? log.engagement : []}
      />
      <WithdrawListing listing={listing} offers={listing.inquiries} ask={ask} openClosings={openClosings} canWithdraw />
    </div>
  );
}
