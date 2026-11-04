import Link from "next/link";
import { notFound } from "next/navigation";
import { answerDeskBid } from "@/actions/desk-book";
import { Notice } from "@/components/notice";
import { SaleApproval } from "@/components/sale-approval";
import { requireRole } from "@/lib/auth";
import { money, num, q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
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
      {listing.status !== "REJECTED" && listing.status !== "SOLD" && (
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
            {!deskBidBlock && <button type="submit" name="answer" value="ACCEPTED" className="h-9 rounded-lg bg-foreground px-3 text-[13px] font-medium text-background">Accept</button>}
            <button type="submit" name="answer" value="DECLINED" className="h-9 rounded-lg border border-border px-3 text-[13px] font-medium hover:bg-hover">Decline</button>
          </form>
          {deskBidBlock && <p className="mt-2 text-sm text-muted-foreground">{deskBidBlock}</p>}
        </div>
      ))}
    </div>
  );
}
