import Link from "next/link";
import { withdrawInquiry } from "@/actions/buyer";
import { BackupAsks } from "@/components/backup-asks";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { DestructionRequests } from "@/components/destruction-requests";
import { MasterAgreementBanner } from "@/components/master-agreement-banner";
import { OfferThread } from "@/components/offer-thread";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { money, num, prettyDate, q } from "@/lib/format";
import { standingLoanPrices } from "@/lib/loan-prices";
import { bidExpired, buyerPrice, canCounter, counterFrom, openCounter, withdrawBlock } from "@/lib/offers";
import { prisma } from "@/lib/prisma";
import { seatBylines } from "@/lib/seats";

export const metadata = { title: "Inquiries" };

export default async function OffersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const user = await requireRole(["BUYER"]);
  const inquiries = await prisma.inquiry.findMany({
    where: { buyerId: user.id },
    include: { listing: { include: { notes: { select: { id: true, city: true, state: true }, orderBy: { createdAt: "asc" } } } }, note: true, messages: { include: { author: true }, orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "desc" },
  });
  const closings = await prisma.closing.findMany({ where: { inquiryId: { in: inquiries.map((item) => item.id) } } });
  // A group's counter is answered seat by seat on the group page, and its bid is withdrawn there too, not by the lead here.
  const groupFor = new Map((await prisma.groupBuy.findMany({ where: { inquiryId: { in: inquiries.map((item) => item.id) } }, select: { id: true, inquiryId: true } })).map((group) => [group.inquiryId, group.id]));
  const closingFor = new Map(closings.map((closing) => [closing.inquiryId, closing.id]));
  // Which of the firm's seats placed each bid, and who approved it when it waited (lib/seats.ts).
  const bylines = await seatBylines(user.id, inquiries.map((item) => item.id));
  return (
    <div>
      <PageIntro eyebrow="Inquiries" title="What you have asked for." />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <MasterAgreementBanner user={user} kind="MASTER_PURCHASE" back="/buyer/offers" />
      <DestructionRequests userId={user.id} />
      <BackupAsks userId={user.id} />
      <ul className="mt-8 space-y-3">
        {inquiries.length === 0 && <li className="text-sm text-muted-foreground">No offers or requests yet.</li>}
        {inquiries.map((inquiry) => {
          const priced = inquiry.messages.map((message) => ({ kind: message.kind, amount: message.amount ? num(message.amount) : null, createdAt: message.createdAt, authorId: message.authorId }));
          const amount = buyerPrice(inquiry.amount ? num(inquiry.amount) : null, priced, inquiry.buyerId);
          const counter = openCounter(priced, inquiry.buyerId);
          const closingId = closingFor.get(inquiry.id);
          const groupId = groupFor.get(inquiry.id);
          const live = inquiry.type === "OFFER" && canCounter(inquiry.status);
          const lapsed = live && bidExpired(inquiry.expiresAt);
          // A whole-pool bid can carry a price for each loan, and can name new ones with a new price.
          const poolBid = inquiry.type === "OFFER" && !inquiry.noteId && inquiry.listing.kind === "POOL" && !groupId;
          const loanPrices = poolBid ? standingLoanPrices(inquiry.loanPrices, amount) : null;
          const withdrawProblem = withdrawBlock({ type: inquiry.type, status: inquiry.status, bidMode: inquiry.listing.bidMode, bidDeadline: inquiry.listing.bidDeadline, group: Boolean(groupId) });
          return (
            <li key={inquiry.id} id={`inquiry-${inquiry.id}`} className="glass scroll-mt-6 p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <Link href={`/marketplace/${inquiry.listingId}`} className="font-semibold tracking-tight text-2xl text-foreground">{inquiry.listing.title}</Link>
                <span className="text-[13px] font-medium text-link">{inquiry.status.toLowerCase()}</span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {inquiry.type.replaceAll("_", " ").toLowerCase()}
                {inquiry.note ? ` · ${inquiry.note.city}` : ""}
                {amount != null ? ` · ${money(amount)}` : ""} · {prettyDate(inquiry.createdAt)}
                {bylines.has(inquiry.id) ? ` · ${bylines.get(inquiry.id)}` : ""}
                {inquiry.type === "OFFER" && inquiry.expiresAt ? ` · ${inquiry.status === "EXPIRED" || lapsed ? "lapsed" : "good until"} ${prettyDate(inquiry.expiresAt)}` : ""}
                {inquiry.status === "WITHDRAWN" && inquiry.withdrawnAt ? ` · withdrawn ${prettyDate(inquiry.withdrawnAt)}` : ""}
              </p>
              {loanPrices && (
                <p className="mt-1 text-sm text-muted-foreground">
                  Priced loan by loan · {inquiry.allowPartial ? "the seller may take part of the pool at your loan prices" : "whole pool only"}
                </p>
              )}
              {closingId && <Link href={`/closings/${closingId}`} className="mt-3 inline-block text-[13px] font-medium text-link">Closing checklist</Link>}
              {live && !lapsed && groupId && (
                <p className="mt-3 text-sm text-muted-foreground">
                  A group&apos;s bid is withdrawn by the group.{" "}
                  <Link href={`/groups/${groupId}`} className="text-link">Drop your seat or dissolve it on the group page</Link>.
                </p>
              )}
              {live && !lapsed && !groupId && withdrawProblem && <p className="mt-3 text-sm text-muted-foreground">{withdrawProblem}</p>}
              {live && !lapsed && !withdrawProblem && amount != null && (
                <form action={withdrawInquiry} className="mt-3">
                  <input type="hidden" name="inquiryId" value={inquiry.id} />
                  <ConfirmSubmit
                    title={`Withdraw your ${money(amount)} bid?`}
                    consequence={`The bid on ${inquiry.listing.title} closes and the desk is told. ${inquiry.listing.bidMode === "BEST_AND_FINAL" ? "Best and final allows one bid, so you can't bid on it again." : "You can send a new bid while the listing is live."}`}
                    confirmLabel="Withdraw the bid"
                    pendingLabel="Withdrawing…"
                    tone="danger"
                    variant="outline"
                    className="h-9 text-[13px] font-medium"
                  >
                    Withdraw bid
                  </ConfirmSubmit>
                </form>
              )}
              {inquiry.type === "OFFER" ? (
                <OfferThread
                  inquiryId={inquiry.id}
                  canCounter={canCounter(inquiry.status) && !lapsed}
                  acceptAmount={groupId ? null : counter}
                  acceptFrom={counterFrom(priced, inquiry.buyerId, inquiry.listing.sellerId) ?? "desk"}
                  loans={poolBid ? inquiry.listing.notes.map((note, index) => ({ id: note.id, label: `Loan ${index + 1} · ${note.city}, ${note.state}`, ask: null })) : []}
                  messages={inquiry.messages.map((message) => ({
                    id: message.id,
                    kind: message.kind,
                    body: message.body,
                    amount: message.amount ? num(message.amount) : null,
                    // Buyers don't learn who the seller is from the thread.
                    author: message.authorId === inquiry.listing.sellerId ? "Seller" : message.author.name,
                    when: prettyDate(message.createdAt),
                  }))}
                />
              ) : (
                inquiry.message && <p className="mt-2 text-sm text-foreground/80">{inquiry.message}</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
