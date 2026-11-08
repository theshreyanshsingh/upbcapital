import { decideInquiry } from "@/actions/admin";
import { deadlinePassed, deskWalled } from "@/lib/auction";
import { askedPriceStands, awaitingSeller, sellerAgreed } from "@/lib/awards";
import { bidEntityNames } from "@/lib/buyer-entities";
import { notifyClosedAuctions } from "@/lib/listing-intel";
import { ConfirmRows, ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { OfferThread } from "@/components/offer-thread";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { money, num, prettyDate, q } from "@/lib/format";
import { feeTerms, feesFor, rateText } from "@/lib/fee-schedule";
import { bidExpired, buyerPrice, canCounter, counterFrom, openCounter } from "@/lib/offers";
import { prisma } from "@/lib/prisma";
import { awardBlocks } from "@/lib/private-listings";
import { getSettings } from "@/lib/settings";
import { deskCan } from "@/lib/staff";
import Link from "next/link";

export const metadata = { title: "Offers" };

export default async function AdminOffersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["ADMIN"]);
  await notifyClosedAuctions();
  const params = await searchParams;
  // Mine: offers on the listings this desk member owns.
  const mine = q(params, "mine") === "1";
  const sells = deskCan(user, "sales");
  const [inquiries, settings] = await Promise.all([
    prisma.inquiry.findMany({
      where: mine ? { listing: { deskOwnerId: user.id } } : undefined,
      include: { buyer: { include: { referredBy: true } }, listing: { include: { broker: true } }, note: true, messages: { include: { author: true }, orderBy: { createdAt: "asc" } } },
      orderBy: { createdAt: "desc" },
    }),
    getSettings(),
  ]);
  const closings = await prisma.closing.findMany({ where: { inquiryId: { in: inquiries.map((item) => item.id) } } });
  const closingFor = new Map(closings.map((closing) => [closing.inquiryId, closing.id]));
  // The buying entity each bid is for, when the buyer chose one beyond their main file.
  const entityOf = await bidEntityNames(inquiries.map((item) => item.buyerEntityId));
  // Live bids from a buyer the seller now excludes, or a private listing no longer shows to, can't be awarded.
  const hiddenBids = await awardBlocks(inquiries.filter((item) => item.type === "OFFER" && (item.status === "OPEN" || item.status === "REVIEWED" || item.status === "ACCEPTED")));
  const premium = rateText(feeTerms(null, settings), "premium");
  return (
    <div>
      <PageIntro eyebrow="Offers" title="Bids and counters." lede={`A bid goes to the seller for approval unless their reserve covers it. Approval opens a closing. If it trades at the working price, the buyer also pays ${premium} on top. Loan bids do not take the rest of the pool off the book.`} />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <OwnerFilter base="/admin/offers" mine={mine} />
      {!deskCan(user, "sealedBids") && <p className="mt-3 text-sm text-muted-foreground">Your desk role doesn&apos;t read sealed bids, so sealed and best-and-final amounts stay hidden until the deadline{deskCan(user, "deskBook") ? ", and until the listing leaves the market, since you bid for the desk book" : ""}.</p>}
      <ul className="mt-6 space-y-3">
        {inquiries.length === 0 && <li className="text-sm text-muted-foreground">{mine ? "No offers on listings you own." : "No offers yet."}</li>}
        {inquiries.map((inquiry) => {
          const messages = inquiry.messages.map((message) => ({
            kind: message.kind,
            amount: message.amount ? num(message.amount) : null,
            createdAt: message.createdAt,
            authorId: message.authorId,
          }));
          // The award price is what the buyer agreed to. A desk counter waits for the buyer to accept it.
          const amount = buyerPrice(inquiry.amount ? num(inquiry.amount) : null, messages, inquiry.buyerId);
          // The premium the closing will charge: the listing's own, fixed when it went live.
          const fees = amount != null ? feesFor(inquiry.listing, settings, amount) : null;
          const counter = openCounter(messages, inquiry.buyerId);
          const walled = inquiry.type === "OFFER" && deskWalled(inquiry.listing, user);
          const closingId = closingFor.get(inquiry.id);
          const agreed = amount
            ? sellerAgreed({ price: amount, reserve: inquiry.listing.reservePrice, approvedAmount: inquiry.sellerApprovedAmount, buyNow: { bid: inquiry.buyNow, price: inquiry.listing.buyNowPrice } })
            : null;
          const live = inquiry.type === "OFFER" && (inquiry.status === "OPEN" || inquiry.status === "REVIEWED");
          const lapsed = live && bidExpired(inquiry.expiresAt);
          const counterBy = counterFrom(messages, inquiry.buyerId, inquiry.listing.sellerId);
          const sellerLine = awaitingSeller(inquiry)
            ? `Waiting on the seller since ${prettyDate(inquiry.sellerAskedAt)}`
            : agreed === "buyNow"
              ? `At the seller's buy-it-now price, agreed in advance on ${prettyDate(inquiry.listing.buyNowSetAt)}, so awarding needs no further approval`
              : agreed === "reserve"
                ? `Within the seller's reserve of ${money(Number(inquiry.listing.reservePrice))}`
                : agreed === "approved"
                  ? inquiry.sellerCounterAmount != null && Math.abs(Number(inquiry.sellerCounterAmount) - (amount ?? 0)) < 0.005
                    ? "The buyer accepted the seller's counter, so the seller has agreed this price"
                    : "The seller approved this price"
                  : inquiry.sellerDeclined
                    ? `The seller declined ${money(Number(inquiry.sellerAskedAmount))} on ${prettyDate(inquiry.sellerAnsweredAt)}`
                    : inquiry.buyNow
                      ? "Placed at buy it now, but the seller has changed that price since. Accepting sends this to the seller for approval first"
                      : "Accepting sends this to the seller for approval first";
          return (
            <li key={inquiry.id} id={`offer-${inquiry.id}`} className="glass scroll-mt-6 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <Link href={`/admin/listings/${inquiry.listingId}`} className="font-semibold tracking-tight text-2xl text-foreground">{inquiry.listing.title}</Link>
                  <p className="mt-1 text-sm text-muted-foreground">
                    <Link href={`/admin/buyers/${inquiry.buyerId}`} className="text-link">{inquiry.buyer.name}</Link> · {inquiry.buyer.email} · {prettyDate(inquiry.createdAt)}
                    {inquiry.listing.broker ? ` · ${inquiry.listing.brokerRole === "AFFILIATE" ? "affiliate" : "broker"} ${inquiry.listing.broker.name}` : ""}
                    {inquiry.buyer.referredBy?.role === "BROKER" ? ` · referred by ${inquiry.buyer.referredBy.name}` : ""}
                    {inquiry.note ? ` · loan in ${inquiry.note.city}` : inquiry.type === "OFFER" ? " · whole listing" : ""}
                  </p>
                </div>
                <p className="text-[13px] font-medium text-link">
                  {inquiry.buyNow ? "buy it now" : inquiry.type.replaceAll("_", " ").toLowerCase()} · {inquiry.status.toLowerCase()}
                </p>
              </div>
              {walled && <p className="mt-3 text-sm text-muted-foreground">Amount sealed until the deadline.</p>}
              {amount != null && !walled && (
                <p className="mt-3 text-sm text-muted-foreground">
                  Buyer&apos;s price {money(amount)} · premium {money((fees?.premiumCents ?? 0) / 100)} · all-in {money((fees?.buyerTotalCents ?? 0) / 100)}
                </p>
              )}
              {live && counter != null && !walled && (
                <p className="mt-2 text-[13px] text-muted-foreground">
                  {counterBy === "seller" ? `Seller counter ${money(counter)}, already approved by the seller` : `Desk counter ${money(counter)}`} · waiting on the buyer to accept
                </p>
              )}
              {inquiry.type === "OFFER" && inquiry.expiresAt && (
                <p className={`mt-2 text-[13px] ${lapsed ? "text-bad" : "text-muted-foreground"}`}>
                  {inquiry.status === "EXPIRED" || lapsed ? `Lapsed ${prettyDate(inquiry.expiresAt)} · the buyer's good-until date passed` : `Good until ${prettyDate(inquiry.expiresAt)}`}
                </p>
              )}
              {hiddenBids.get(inquiry.id) && <p role="status" className="mt-2 text-[13px] font-medium text-bad">{hiddenBids.get(inquiry.id)}</p>}
              {inquiry.status === "WITHDRAWN" && <p className="mt-2 text-[13px] text-muted-foreground">Withdrawn by the buyer{inquiry.withdrawnAt ? ` ${prettyDate(inquiry.withdrawnAt)}` : ""}</p>}
              {live && !walled && <p className={`mt-2 text-[13px] ${agreed ? "text-good" : "text-muted-foreground"}`}>{sellerLine}</p>}
              {/* The seller's own pick, behind the same wall as the amount it agreed to. */}
              {live && !walled && inquiry.sellerRequestedAt && (
                <p className="mt-2 text-[13px] font-medium text-foreground">
                  Seller asked to award this bid · {prettyDate(inquiry.sellerRequestedAt)}
                  {askedPriceStands(inquiry.sellerApprovedAmount, amount) ? "" : " · the bid has changed since, so ask the seller again"}
                </p>
              )}
              {inquiry.buyerEntityId && entityOf.get(inquiry.buyerEntityId) && (
                <p className="mt-2 text-[13px] text-muted-foreground">
                  For {entityOf.get(inquiry.buyerEntityId)!.name} · {entityOf.get(inquiry.buyerEntityId)!.kind}
                </p>
              )}
              {inquiry.message && !walled && <p className="mt-2 text-sm text-foreground/85">{inquiry.message}</p>}
              {closingId && <Link href={`/closings/${closingId}`} className="mt-3 inline-block text-[13px] font-medium text-link">Open closing</Link>}
              {inquiry.type === "OFFER" && !closingId && deskCan(user, "sealedBids") && <Link href={`/admin/listings/${inquiry.listingId}#bids`} className="mt-3 inline-block text-[13px] font-medium text-link">Compare on the bid sheet</Link>}
              {inquiry.type === "OFFER" && !walled && (
                <OfferThread
                  inquiryId={inquiry.id}
                  canCounter={sells && canCounter(inquiry.status)}
                  readOnly={!sells}
                  messages={inquiry.messages.map((message) => ({
                    id: message.id,
                    kind: message.kind,
                    body: message.body,
                    amount: message.amount ? num(message.amount) : null,
                    author: message.author.name,
                    when: prettyDate(message.createdAt),
                  }))}
                />
              )}
              {sells && (inquiry.status === "OPEN" || inquiry.status === "REVIEWED") && (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {inquiry.type === "OFFER" && inquiry.listing.status === "APPROVED" && inquiry.listing.bidMode !== "NONE" && !deadlinePassed(inquiry.listing.bidDeadline) && (
                    <p className="text-sm text-muted-foreground">Award opens after the deadline.</p>
                  )}
                  {inquiry.type === "OFFER" && inquiry.listing.status !== "APPROVED" && (
                    <p className="text-sm text-muted-foreground">The listing isn&apos;t live, so this bid can&apos;t be awarded.</p>
                  )}
                  {lapsed && <p className="text-sm text-muted-foreground">The good-until date passed, so this bid can&apos;t be awarded.</p>}
                  {inquiry.type === "OFFER" && !lapsed && inquiry.listing.status === "APPROVED" && (inquiry.listing.bidMode === "NONE" || deadlinePassed(inquiry.listing.bidDeadline)) && (
                    <form action={decideInquiry}>
                      <input type="hidden" name="inquiryId" value={inquiry.id} />
                      <input type="hidden" name="decision" value="ACCEPT" />
                      {agreed && amount != null ? (
                        <ConfirmSubmit
                          title={`Award ${inquiry.listing.title} at ${money(amount)}?`}
                          consequence={`This opens the closing with ${inquiry.buyer.name}, puts ${inquiry.note ? "the loan" : "the listing"} in contract and declines the other bids on it. It can't be undone from here.`}
                          details={
                            <ConfirmRows
                              rows={[
                                ["Buyer's price", money(amount)],
                                ["Buyer premium", money((fees?.premiumCents ?? 0) / 100)],
                                ["Buyer all-in", money((fees?.buyerTotalCents ?? 0) / 100)],
                              ]}
                            />
                          }
                          confirmLabel="Award and open the closing"
                          pendingLabel="Awarding…"
                          className="h-9 text-[13px] font-medium"
                        >
                          {inquiry.listing.bidMode === "NONE" ? "Accept the buyer's price" : "Award at the buyer's price"}
                        </ConfirmSubmit>
                      ) : (
                        <SubmitButton className="h-9 text-[13px] font-medium" pendingLabel="Sending…">
                          {awaitingSeller(inquiry) ? "Ask the seller again" : "Send to the seller"}
                        </SubmitButton>
                      )}
                    </form>
                  )}
                  <form action={decideInquiry}>
                    <input type="hidden" name="inquiryId" value={inquiry.id} />
                    <input type="hidden" name="decision" value="DECLINE" />
                    <ConfirmSubmit
                      title={`Decline ${inquiry.buyer.name}'s ${inquiry.type === "OFFER" ? "bid" : "request"}?`}
                      consequence="The buyer is told the desk declined it, and it leaves the book. It can't be reopened."
                      confirmLabel="Decline it"
                      pendingLabel="Declining…"
                      tone="danger"
                      className="h-9 text-[13px] font-medium"
                    >
                      Decline
                    </ConfirmSubmit>
                  </form>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// All offers, or only those on listings this desk member owns.
function OwnerFilter({ base, mine }: { base: string; mine: boolean }) {
  const pill = (active: boolean) =>
    `inline-flex min-h-9 items-center rounded-full border px-3.5 text-[13px] font-medium ${active ? "border-link/50 bg-link/10 text-link" : "border-border bg-card text-muted-foreground hover:text-foreground"}`;
  return (
    <nav aria-label="Whose offers" className="mt-6 flex gap-2">
      <Link href={base} aria-current={!mine ? "page" : undefined} className={pill(!mine)}>All</Link>
      <Link href={`${base}?mine=1`} aria-current={mine ? "page" : undefined} className={pill(mine)}>Mine</Link>
    </nav>
  );
}
