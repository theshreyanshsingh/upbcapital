import Link from "next/link";
import { PageIntro } from "@/components/page-intro";
import { requireUser } from "@/lib/auth";
import { q } from "@/lib/format";
import { closingClock, targetDays } from "@/lib/closing-clock";
import { getSettings } from "@/lib/settings";
import { money, prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { buyerDueCents, sellerNetCents } from "@/lib/settlement";

export const metadata = { title: "Closings" };

export default async function ClosingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  // The desk can narrow the list to the closings it runs.
  const mine = user.role === "ADMIN" && q(await searchParams, "mine") === "1";
  const referredInquiryIds = user.role === "BROKER" && user.accountStatus === "APPROVED"
    ? (await prisma.inquiry.findMany({ where: { buyer: { referredById: user.id } }, select: { id: true } })).map((item) => item.id)
    : [];
  const closings = await prisma.closing.findMany({
    where:
      user.role === "ADMIN"
        ? mine ? { deskOwnerId: user.id } : {}
        : user.role === "BUYER"
          ? {
              OR: [
                { inquiryId: { in: (await prisma.inquiry.findMany({ where: { buyerId: user.id }, select: { id: true } })).map((item) => item.id) } },
                { funders: { some: { userId: user.id } } },
              ],
            }
          : user.role === "BROKER"
            ? {
                OR: [
                  { listing: { brokerId: user.id } },
                  { listing: { sellerId: user.id } },
                  { inquiryId: { in: referredInquiryIds } },
                ],
              }
            : { listing: { sellerId: user.id } },
    include: {
      listing: true,
      steps: true,
      funders: { where: { userId: user.id } },
      brokerFees: { where: { brokerId: user.id } },
    },
    orderBy: { openedAt: "desc" },
  });
  // Each side sees its own figure: the buyer what they wire, the seller what they net, a broker their fee.
  const figure = (closing: (typeof closings)[number]) => {
    if (user.role === "ADMIN") return `All-in ${money(buyerDueCents(closing) / 100)} · net ${money(sellerNetCents(closing) / 100)}`;
    if (closing.listing.sellerId === user.id) return `Net ${money(sellerNetCents(closing) / 100)}`;
    const share = closing.funders[0];
    if (share) return `Your share ${money(Number(share.amount) + share.premiumCents / 100)}`;
    if (user.role === "BUYER") return `All-in ${money(buyerDueCents(closing) / 100)}`;
    const fee = closing.brokerFees.reduce((sum, row) => sum + row.amountCents, 0);
    return fee ? `Your fee ${money(fee / 100)}` : null;
  };
  const days = targetDays((await getSettings()).closingTargetDays);
  return (
    <div>
      <PageIntro eyebrow="Closing" title="Files in motion." lede="Each accepted offer has a checklist. The buyer’s all-in includes the premium. The seller’s net is after commission." />
      {user.role === "ADMIN" && (
        <nav aria-label="Whose closings" className="mb-4 flex gap-2">
          {[{ label: "All", on: !mine, href: "/closings" }, { label: "Mine", on: mine, href: "/closings?mine=1" }].map((item) => (
            <Link
              key={item.label}
              href={item.href}
              aria-current={item.on ? "page" : undefined}
              className={`inline-flex min-h-9 items-center rounded-full border px-3.5 text-[13px] font-medium ${item.on ? "border-link/50 bg-link/10 text-link" : "border-border bg-card text-muted-foreground hover:text-foreground"}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      )}
      <ul className="divide-y divide-border border border-border rounded-xl">
        {closings.length === 0 && <li className="px-5 py-8 text-sm text-muted-foreground">{mine ? "You don't own any closings yet." : "No closings yet."}</li>}
        {closings.map((closing) => {
          const done = closing.steps.filter((step) => step.status === "COMPLETE").length;
          const clock = closingClock(closing, closing.steps, days);
          const amount = figure(closing);
          return (
            <li key={closing.id} className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-5">
              <div>
                <Link href={`/closings/${closing.id}`} className="font-semibold tracking-tight text-3xl text-foreground">{closing.listing.title}</Link>
                <p className="mt-1 text-sm text-muted-foreground">
                  {closing.status.toLowerCase()} · {done}/{closing.steps.length} steps · opened {prettyDate(closing.openedAt)}
                  {closing.status === "OPEN" ? ` · target ${prettyDate(clock.target)}` : ""}
                </p>
                {(clock.overdue > 0 || clock.late) && (
                  <p className="mt-1 text-[13px] font-medium text-bad">
                    {clock.overdue > 0 ? `${clock.overdue} step${clock.overdue === 1 ? "" : "s"} late` : ""}
                    {clock.overdue > 0 && clock.late ? " · " : ""}
                    {clock.late ? "past the target close" : ""}
                  </p>
                )}
              </div>
              {amount && <p className="text-sm text-foreground">{amount}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
