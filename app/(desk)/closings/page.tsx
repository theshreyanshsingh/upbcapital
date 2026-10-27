import Link from "next/link";
import { PageIntro } from "@/components/page-intro";
import { requireUser } from "@/lib/auth";
import { money, prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Closings" };

export default async function ClosingsPage() {
  const user = await requireUser();
  const referredInquiryIds = user.role === "BROKER" && user.accountStatus === "APPROVED"
    ? (await prisma.inquiry.findMany({ where: { buyer: { referredById: user.id } }, select: { id: true } })).map((item) => item.id)
    : [];
  const closings = await prisma.closing.findMany({
    where:
      user.role === "ADMIN"
        ? {}
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
    include: { listing: true, steps: true },
    orderBy: { openedAt: "desc" },
  });
  return (
    <div>
      <PageIntro eyebrow="Closing" title="Files in motion." lede="Each accepted offer has a checklist. The buyer’s all-in includes the premium. The seller’s net is after commission." />
      <ul className="divide-y divide-border border border-border rounded-xl">
        {closings.length === 0 && <li className="px-5 py-8 text-sm text-muted-foreground">No closings yet.</li>}
        {closings.map((closing) => {
          const done = closing.steps.filter((step) => step.status === "COMPLETE").length;
          return (
            <li key={closing.id} className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-5">
              <div>
                <Link href={`/closings/${closing.id}`} className="font-semibold tracking-tight text-3xl text-foreground">{closing.listing.title}</Link>
                <p className="mt-1 text-sm text-muted-foreground">
                  {closing.status.toLowerCase()} · {done}/{closing.steps.length} steps · opened {prettyDate(closing.openedAt)}
                </p>
              </div>
              <p className="text-sm text-foreground">All-in {money(closing.buyerTotalCents / 100)}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
