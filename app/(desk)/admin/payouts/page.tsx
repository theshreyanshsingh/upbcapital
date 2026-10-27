import Link from "next/link";
import { markBrokerFeePaid } from "@/actions/broker";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { brokerRoleLabel } from "@/lib/broker-fees";
import { money, prettyDate, q } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Broker payouts" };

export default async function PayoutsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole(["ADMIN"]);
  const params = await searchParams;
  const fees = await prisma.brokerFee.findMany({
    include: { broker: true, closing: { include: { listing: true } } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
  const owed = fees.filter((fee) => fee.status === "OWED");
  const owedCents = owed.reduce((sum, fee) => sum + fee.amountCents, 0);
  return (
    <div>
      <PageIntro
        eyebrow="Payouts"
        title="What the desk owes."
        lede="A broker fee posts when the file closes. Mark it paid once the money has gone out. This queue does not store account numbers."
      />
      <p className="mt-4 font-semibold tracking-tight text-3xl text-foreground">{money(owedCents / 100)} <span className="text-2xl text-muted-foreground">owed</span></p>
      <div className="mt-4">
        <Notice notice={q(params, "notice")} error={q(params, "error")} />
      </div>
      <ul className="mt-6 space-y-3">
        {fees.length === 0 && <li className="border border-dashed border-border px-5 py-8 text-sm text-muted-foreground rounded-xl">No broker fees have posted. They appear here after a closing.</li>}
        {fees.map((fee) => (
          <li key={fee.id} className="glass flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-semibold tracking-tight text-2xl text-foreground">{fee.broker.name}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                <Link href={`/closings/${fee.closingId}`} className="text-link">{fee.closing.listing.title}</Link>
                {" · "}{brokerRoleLabel(fee.role)} · {prettyDate(fee.createdAt)}
              </p>
              <p className="mt-1 text-[13px] font-medium text-link">{fee.status === "PAID" ? `Paid ${fee.paidAt ? prettyDate(fee.paidAt) : ""}` : "Owed"}</p>
            </div>
            <div className="flex items-center justify-between gap-4 sm:justify-end">
              <p className="font-semibold tracking-tight text-3xl text-foreground">{money(fee.amountCents / 100)}</p>
              {fee.status === "OWED" && (
                <form action={markBrokerFeePaid}>
                  <input type="hidden" name="feeId" value={fee.id} />
                  <SubmitButton className="h-11 text-[13px] font-medium">Mark paid</SubmitButton>
                </form>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
