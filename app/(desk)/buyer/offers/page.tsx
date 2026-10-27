import Link from "next/link";
import { OfferThread } from "@/components/offer-thread";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { money, num, prettyDate, q } from "@/lib/format";
import { canCounter, workingAmount } from "@/lib/offers";
import { prisma } from "@/lib/prisma";

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
    include: { listing: true, note: true, messages: { include: { author: true }, orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "desc" },
  });
  const closings = await prisma.closing.findMany({ where: { inquiryId: { in: inquiries.map((item) => item.id) } } });
  const closingFor = new Map(closings.map((closing) => [closing.inquiryId, closing.id]));
  return (
    <div>
      <PageIntro eyebrow="Inquiries" title="What you have asked for." />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <ul className="mt-8 space-y-3">
        {inquiries.length === 0 && <li className="text-sm text-muted-foreground">No offers or requests yet.</li>}
        {inquiries.map((inquiry) => {
          const amount = workingAmount(
            inquiry.amount ? num(inquiry.amount) : null,
            inquiry.messages.map((message) => ({ kind: message.kind, amount: message.amount ? num(message.amount) : null, createdAt: message.createdAt })),
          );
          const closingId = closingFor.get(inquiry.id);
          return (
            <li key={inquiry.id} className="glass p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <Link href={`/marketplace/${inquiry.listingId}`} className="font-semibold tracking-tight text-2xl text-foreground">{inquiry.listing.title}</Link>
                <span className="text-[13px] font-medium text-link">{inquiry.status.toLowerCase()}</span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {inquiry.type.replaceAll("_", " ").toLowerCase()}
                {inquiry.note ? ` · ${inquiry.note.city}` : ""}
                {amount != null ? ` · ${money(amount)}` : ""} · {prettyDate(inquiry.createdAt)}
              </p>
              {closingId && <Link href={`/closings/${closingId}`} className="mt-3 inline-block text-[13px] font-medium text-link">Closing checklist</Link>}
              {inquiry.type === "OFFER" ? (
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
