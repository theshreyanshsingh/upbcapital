import { decideInquiry } from "@/actions/admin";
import { deadlinePassed } from "@/lib/auction";
import { notifyClosedAuctions } from "@/lib/listing-intel";
import { Notice } from "@/components/notice";
import { OfferThread } from "@/components/offer-thread";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { money, num, prettyDate, q } from "@/lib/format";
import { bpsToPercent } from "@/lib/money";
import { canCounter, workingAmount } from "@/lib/offers";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import Link from "next/link";

export const metadata = { title: "Offers" };

export default async function AdminOffersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole(["ADMIN"]);
  await notifyClosedAuctions();
  const params = await searchParams;
  const [inquiries, settings] = await Promise.all([
    prisma.inquiry.findMany({
      include: { buyer: { include: { referredBy: true } }, listing: { include: { broker: true } }, note: true, messages: { include: { author: true }, orderBy: { createdAt: "asc" } } },
      orderBy: { createdAt: "desc" },
    }),
    getSettings(),
  ]);
  const closings = await prisma.closing.findMany({ where: { inquiryId: { in: inquiries.map((item) => item.id) } } });
  const closingFor = new Map(closings.map((closing) => [closing.inquiryId, closing.id]));
  const premium = bpsToPercent(settings.buyerPremiumBps);
  return (
    <div>
      <PageIntro eyebrow="Offers" title="Bids and counters." lede={`Accepting a bid opens a closing. If it trades at the working price, the buyer also pays ${premium.toFixed(2)}% on top. Loan bids do not take the rest of the pool off the book.`} />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <ul className="mt-8 space-y-3">
        {inquiries.map((inquiry) => {
          const messages = inquiry.messages.map((message) => ({
            kind: message.kind,
            amount: message.amount ? num(message.amount) : null,
            createdAt: message.createdAt,
          }));
          const amount = workingAmount(inquiry.amount ? num(inquiry.amount) : null, messages);
          const closingId = closingFor.get(inquiry.id);
          return (
            <li key={inquiry.id} className="glass p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <Link href={`/admin/listings/${inquiry.listingId}`} className="font-semibold tracking-tight text-2xl text-foreground">{inquiry.listing.title}</Link>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {inquiry.buyer.name} · {inquiry.buyer.email} · {prettyDate(inquiry.createdAt)}
                    {inquiry.listing.broker ? ` · ${inquiry.listing.brokerRole === "AFFILIATE" ? "affiliate" : "broker"} ${inquiry.listing.broker.name}` : ""}
                    {inquiry.buyer.referredBy?.role === "BROKER" ? ` · referred by ${inquiry.buyer.referredBy.name}` : ""}
                    {inquiry.note ? ` · loan in ${inquiry.note.city}` : inquiry.type === "OFFER" ? " · whole listing" : ""}
                  </p>
                </div>
                <p className="text-[13px] font-medium text-link">{inquiry.type.replaceAll("_", " ").toLowerCase()} · {inquiry.status.toLowerCase()}</p>
              </div>
              {amount != null && (
                <p className="mt-3 text-sm text-muted-foreground">
                  Working bid {money(amount)} · premium {money((amount * settings.buyerPremiumBps) / 10000)} · all-in {money(amount + (amount * settings.buyerPremiumBps) / 10000)}
                </p>
              )}
              {inquiry.message && <p className="mt-2 text-sm text-foreground/85">{inquiry.message}</p>}
              {closingId && <Link href={`/closings/${closingId}`} className="mt-3 inline-block text-[13px] font-medium text-link">Open closing</Link>}
              {inquiry.type === "OFFER" && (
                <OfferThread
                  inquiryId={inquiry.id}
                  canCounter={canCounter(inquiry.status)}
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
              {(inquiry.status === "OPEN" || inquiry.status === "REVIEWED") && (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {inquiry.type === "OFFER" && inquiry.listing.bidMode !== "NONE" && !deadlinePassed(inquiry.listing.bidDeadline) && (
                    <p className="text-sm text-muted-foreground">Award opens after the deadline.</p>
                  )}
                  {inquiry.type === "OFFER" && (inquiry.listing.bidMode === "NONE" || deadlinePassed(inquiry.listing.bidDeadline)) && (
                    <form action={decideInquiry}>
                      <input type="hidden" name="inquiryId" value={inquiry.id} />
                      <input type="hidden" name="decision" value="ACCEPT" />
                      <SubmitButton className="h-9 text-[13px] font-medium">
                        {inquiry.listing.bidMode === "NONE" ? "Accept working price" : "Award"}
                      </SubmitButton>
                    </form>
                  )}
                  <form action={decideInquiry}>
                    <input type="hidden" name="inquiryId" value={inquiry.id} />
                    <input type="hidden" name="decision" value="DECLINE" />
                    <SubmitButton variant="outline" className="h-9 text-[13px] font-medium">Decline</SubmitButton>
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
