import Link from "next/link";
import { approveBrokerFeeAction, markBrokerFeePaid } from "@/actions/broker";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { PayoutAccountList } from "@/components/finance-panels";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { brokerRoleLabel } from "@/lib/broker-fees";
import { unset } from "@/lib/db-filters";
import { money, prettyDate, q } from "@/lib/format";
import { payoutAccountsFor, payoutLabel } from "@/lib/payout-accounts";
import { prisma } from "@/lib/prisma";
import { deskCan } from "@/lib/staff";

export const metadata = { title: "Broker payouts" };

export default async function PayoutsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Every desk role reads the queue. A fee leaves in two steps by two desk members: approving it to a verified
  // account is wire work, and recording it paid is closings work. The actions check the same.
  const viewer = await requireRole(["ADMIN"]);
  const approves = deskCan(viewer, "approveWires");
  const closes = deskCan(viewer, "closings");
  const params = await searchParams;
  const [fees, waiting] = await Promise.all([
    prisma.brokerFee.findMany({
      include: { broker: { include: { brokerProfile: { select: { payoutNote: true } } } }, closing: { include: { listing: true } } },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    }),
    // A broker's account waiting for its call-back shows below even before a fee is owed.
    prisma.payoutAccount.findMany({ where: { status: "PENDING", ...unset("retiredAt"), user: { role: "BROKER" } }, select: { userId: true } }),
  ]);
  const owed = fees.filter((fee) => fee.status === "OWED");
  const owedCents = owed.reduce((sum, fee) => sum + fee.amountCents, 0);
  const brokerIds = [...new Set([...owed.map((fee) => fee.brokerId), ...waiting.map((row) => row.userId)])];
  const accountIds = [...new Set(fees.map((fee) => fee.payoutAccountId).filter((id): id is string => Boolean(id)))];
  const deskIds = [...new Set(fees.flatMap((fee) => [fee.approvedById, fee.paidById]).filter((id): id is string => Boolean(id)))];
  const [brokers, accountLists, paidTo, deskPeople] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: brokerIds } }, select: { id: true, name: true } }),
    Promise.all(brokerIds.map((id) => payoutAccountsFor(id))),
    accountIds.length ? prisma.payoutAccount.findMany({ where: { id: { in: accountIds } } }) : Promise.resolve([]),
    deskIds.length ? prisma.user.findMany({ where: { id: { in: deskIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ]);
  const accountsOf = new Map(brokerIds.map((id, index) => [id, accountLists[index]]));
  const accountById = new Map(paidTo.map((account) => [account.id, account]));
  const nameOf = new Map(deskPeople.map((person) => [person.id, person.name]));
  const deskName = (id: string | null) => (id ? nameOf.get(id) ?? "A desk member" : "A desk member");
  return (
    <div>
      <PageIntro
        eyebrow="Payouts"
        title="What the desk owes."
        lede="A broker fee posts when the file closes. It goes only to a payout account of the broker's that the desk verified by call-back. One desk member approves it to that account, after a fresh sanctions screen, and another records it paid once the money has gone. This queue does not store account numbers."
      />
      <p className="mt-4 font-semibold tracking-tight text-3xl text-foreground">{money(owedCents / 100)} <span className="text-2xl text-muted-foreground">owed</span></p>
      <div className="mt-4">
        <Notice notice={q(params, "notice")} error={q(params, "error")} />
      </div>
      <ul className="mt-6 space-y-3">
        {fees.length === 0 && <li className="border border-dashed border-border px-5 py-8 text-sm text-muted-foreground rounded-xl">No broker fees have posted. They appear here after a closing.</li>}
        {fees.map((fee) => {
          const account = fee.payoutAccountId ? accountById.get(fee.payoutAccountId) : undefined;
          const choices = (accountsOf.get(fee.brokerId) ?? []).filter((row) => row.status === "VERIFIED" && !row.held);
          const approved = fee.status === "OWED" && fee.approvedAt;
          return (
            <li key={fee.id} className="glass flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="font-semibold tracking-tight text-2xl text-foreground">{fee.broker.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  <Link href={`/closings/${fee.closingId}`} className="text-link">{fee.closing.listing.title}</Link>
                  {" · "}{brokerRoleLabel(fee.role)} · {prettyDate(fee.createdAt)}
                </p>
                {fee.broker.brokerProfile?.payoutNote && <p className="mt-1 text-xs text-muted-foreground">How the broker likes to be paid: {fee.broker.brokerProfile.payoutNote}</p>}
                <p className="mt-1 text-[13px] font-medium text-link">
                  {fee.status === "PAID"
                    ? `Paid ${fee.paidAt ? prettyDate(fee.paidAt) : ""}${account ? ` to ${payoutLabel(account)}` : ""}`
                    : approved
                      ? `Approved to ${account ? payoutLabel(account) : "a payout account"} by ${deskName(fee.approvedById)} ${prettyDate(fee.approvedAt)}`
                      : "Owed"}
                </p>
                {fee.status === "PAID" && fee.paidById && <p className="mt-1 text-xs text-muted-foreground">Recorded paid by {deskName(fee.paidById)}{fee.approvedById ? `, approved by ${deskName(fee.approvedById)}` : ""}</p>}
              </div>
              <div className="flex flex-col gap-3 sm:items-end">
                <p className="font-semibold tracking-tight text-3xl text-foreground">{money(fee.amountCents / 100)}</p>
                {fee.status === "OWED" && !approved && approves && (
                  choices.length ? (
                    <form action={approveBrokerFeeAction} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="feeId" value={fee.id} />
                      <select name="accountId" required defaultValue="" aria-label={`Payout account for ${fee.broker.name}`} className="desk-input max-w-72">
                        <option value="" disabled>Verified payout account</option>
                        {choices.map((choice) => <option key={choice.id} value={choice.id}>{payoutLabel(choice)} · {choice.accountName}</option>)}
                      </select>
                      <ConfirmSubmit
                        title={`Approve ${money(fee.amountCents / 100, 2)} to ${fee.broker.name}?`}
                        consequence="The broker and the name on the account are screened against today's sanctions list first. Another desk member then records it paid once the money has gone."
                        confirmLabel="Approve the payment"
                        pendingLabel="Screening…"
                        className="h-11 text-[13px] font-medium"
                      >
                        Approve
                      </ConfirmSubmit>
                    </form>
                  ) : (
                    <p className="max-w-72 text-xs text-muted-foreground sm:text-right">No verified payout account. The broker adds one under Payouts and invoices, and the desk calls them back below.</p>
                  )
                )}
                {approved && closes && fee.approvedById !== viewer.id && (
                  <form action={markBrokerFeePaid}>
                    <input type="hidden" name="feeId" value={fee.id} />
                    <ConfirmSubmit
                      title={`Record ${money(fee.amountCents / 100, 2)} paid to ${fee.broker.name}?`}
                      consequence={`Record it only once the money has gone to ${account ? payoutLabel(account) : "the approved account"}. The broker is told.`}
                      confirmLabel="Record it paid"
                      pendingLabel="Saving…"
                      className="h-11 text-[13px] font-medium"
                    >
                      Record paid
                    </ConfirmSubmit>
                  </form>
                )}
                {approved && fee.approvedById === viewer.id && <p className="text-xs text-muted-foreground">You approved it, so another desk member records it paid.</p>}
              </div>
            </li>
          );
        })}
      </ul>

      <section id="broker-accounts" aria-labelledby="broker-accounts-heading" className="glass mt-8 scroll-mt-6 p-6">
        <p id="broker-accounts-heading" className="eyebrow">Broker payout accounts</p>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Brokers with a fee owed, and any broker&apos;s account waiting for its call-back. Call the broker on a number you find yourself, never one from the request or an email. Another desk member who approves wires then verifies it.
        </p>
        {brokerIds.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No broker accounts waiting.</p>}
        {brokers.map((broker) => {
          const accounts = accountsOf.get(broker.id) ?? [];
          return (
            <div key={broker.id} className="mt-5">
              <p className="text-sm font-medium text-foreground">{broker.name}</p>
              {accounts.length ? (
                <PayoutAccountList accounts={accounts} viewer={viewer} party="broker" />
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">No payout account on file.</p>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}
