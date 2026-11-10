import {
  addPayoutAccountAction,
  clearProrationAction,
  creditInvoiceAction,
  decidePayoutAccountAction,
  issueClosingInvoicesAction,
  logPayoutCallbackAction,
  removePayoutAccountAction,
  saveProrationAction,
} from "@/actions/finance";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { deskCan, type Staff } from "@/lib/desk-roles";
import { isoDate, money, prettyDate } from "@/lib/format";
import { INVOICE_KIND_LABELS, closingCharges, creditLeft, invoicesFor } from "@/lib/invoices";
import { CALLBACK_SOURCES, MAX_ACTIVE_ACCOUNTS, PAYOUT_NUMBER_NOTE, PAYOUT_STATUS_LABELS, activePayoutAccounts, callbackSourceLabel, payoutAccountsFor, payoutLabel } from "@/lib/payout-accounts";
import { prisma } from "@/lib/prisma";
import { BASIS_TEXT, prorationCovers, prorationDirection, readProration } from "@/lib/proration";
import { tiedBalances } from "@/lib/proration-service";

// The closing page's proration, payout account and invoice panels, and the account page's payout accounts and
// invoices. Each loads what it shows, so a shared page needs one line for it.

const cents = (value: number) => money(value / 100, 2);
const signed = (value: number) => (value > 0 ? `+${cents(value)}` : cents(value));

type Viewer = Staff & { id: string };

// ---------------------------------------------------------------------------------------------------------------
// Proration.

type ProrationClosing = {
  id: string;
  status: string;
  openedAt: Date;
  targetCloseAt: Date | null;
  cutoffDate: Date | null;
  prorationCents: number | null;
  prorationDetail: unknown;
  proceedsSentCents: number | null;
  funders: unknown[];
  tieOut?: unknown;
};

type ProrationNote = { id: string; streetAddress: string; city: string; state: string; upb: number; interestRate: number; paymentStatus: string };

export function ProrationPanel({ closing, loans, runs }: { closing: ProrationClosing; loans: ProrationNote[]; runs: boolean }) {
  const detail = readProration(closing.prorationDetail);
  const editable = runs && closing.status === "OPEN" && !closing.funders.length && closing.proceedsSentCents == null;
  if (!editable && closing.prorationCents == null) return null;
  const stale = detail != null && !prorationCovers(detail, loans.map((loan) => loan.id));
  const cutoff = isoDate(closing.cutoffDate ?? closing.openedAt) ?? "";
  const closingDay = detail?.closingDate ?? isoDate(closing.targetCloseAt) ?? isoDate(new Date()) ?? "";
  const stored = new Map((detail?.loans ?? []).map((loan) => [loan.noteId, loan]));
  const tied = tiedBalances(closing.tieOut);
  return (
    <section id="proration" aria-labelledby="proration-heading" className="glass scroll-mt-6 p-6">
      <p id="proration-heading" className="eyebrow">Proration</p>
      {closing.prorationCents != null ? (
        <>
          <p className="mt-3 text-sm text-foreground">{prorationDirection(closing.prorationCents)}</p>
          {detail && (
            <>
              <p className="mt-1 text-xs text-muted-foreground">
                Cut-off {prettyDate(detail.cutoffDate)} to closing {prettyDate(detail.closingDate)}.{detail.loans.length > 1 ? ` Price split ${BASIS_TEXT[detail.basis]}.` : ""}
              </p>
              <ul className="mt-3 space-y-2 text-xs text-muted-foreground">
                {detail.loans.map((loan) => (
                  <li key={loan.noteId}>
                    <span className="text-foreground">{loan.label}</span>
                    <span className="block">
                      UPB {cents(loan.tapeUpbCents)} to {cents(loan.closingUpbCents)} · principal {signed(loan.principalCents)}
                    </span>
                    <span className="block">
                      {loan.interestPaidTo ? `Interest paid to ${prettyDate(loan.interestPaidTo)}, ${loan.interestDays} day${Math.abs(loan.interestDays) === 1 ? "" : "s"} at ${cents(loan.perDiemCents)} a day · ${signed(loan.interestCents)}` : "No interest adjustment"}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {stale && runs && <p className="mt-2 text-xs text-bad">The loans on this closing changed since the proration was set. Set it again.</p>}
        </>
      ) : (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          The price is set from the tape&apos;s balance at the cut-off. If the borrower paid principal down before closing, or interest is owed either way, set it here. It shows as its own lines on both statements, and the price and fees stay as they are.
        </p>
      )}
      {editable && (
        <details className="mt-4">
          <summary className="cursor-pointer text-[13px] font-medium text-link">{closing.prorationCents == null ? "Set the proration" : "Change the proration"}</summary>
          <form action={saveProrationAction} className="mt-3 space-y-3">
            <input type="hidden" name="closingId" value={closing.id} />
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-[13px] text-muted-foreground">
                Cut-off
                <input name="cutoffDate" type="date" defaultValue={cutoff} required className="desk-input mt-1" />
              </label>
              <label className="block text-[13px] text-muted-foreground">
                Closing
                <input name="closingDate" type="date" defaultValue={closingDay} required className="desk-input mt-1" />
              </label>
            </div>
            <p className="text-xs text-muted-foreground">The cut-off starts as the day the price was agreed.</p>
            {loans.map((loan) => {
              const saved = stored.get(loan.id);
              const tie = tied.get(loan.id);
              const paidTo = saved ? saved.interestPaidTo ?? "" : loan.paymentStatus === "PERFORMING" ? cutoff : "";
              const upbAtClose = saved?.closingUpbCents ?? tie?.closingUpbCents ?? Math.round(loan.upb * 100);
              return (
                <fieldset key={loan.id} className="space-y-2 border-t border-border pt-3">
                  <legend className="text-[13px] text-foreground">
                    {loan.streetAddress ? `${loan.streetAddress}, ` : ""}{loan.city}, {loan.state}
                  </legend>
                  <p className="text-xs text-muted-foreground">
                    Bid tape UPB {cents(tie?.bidUpbCents ?? Math.round(loan.upb * 100))} at {loan.interestRate}%{tie ? ` · closing tape ${cents(tie.closingUpbCents)} from the tie-out` : ""}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block text-[13px] text-muted-foreground">
                      UPB at closing
                      <input name={`upb_${loan.id}`} inputMode="decimal" defaultValue={(upbAtClose / 100).toFixed(2)} className="desk-input mt-1" />
                    </label>
                    <label className="block text-[13px] text-muted-foreground">
                      Interest paid to
                      <input name={`paidTo_${loan.id}`} type="date" defaultValue={paidTo} className="desk-input mt-1" />
                    </label>
                  </div>
                </fieldset>
              );
            })}
            <p className="text-xs text-muted-foreground">Leave the paid-to date blank to leave interest out, as for a loan sold without its arrears. A date before closing owes the seller the days between; a date after it owes the buyer.</p>
            <ConfirmSubmit
              title="Set this proration?"
              consequence="It changes what the buyer wires and what the seller nets by the same amount. The price and fees stay as they are. Both sides are emailed their new figure, and money already recorded is checked against it."
              confirmLabel="Set and tell both sides"
              pendingLabel="Saving…"
              className="h-9 text-[13px] font-medium"
            >
              Save proration
            </ConfirmSubmit>
          </form>
          {closing.prorationCents != null && (
            <form action={clearProrationAction} className="mt-3">
              <input type="hidden" name="closingId" value={closing.id} />
              <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Saving…">Take it off</SubmitButton>
            </form>
          )}
        </details>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Payout accounts on the closing page.

export async function PayoutPanel({ closing, sellerId, viewer, isSeller }: { closing: { id: string; status: string; payoutAccountId: string | null }; sellerId: string; viewer: Viewer; isSeller: boolean }) {
  const desk = viewer.role === "ADMIN";
  if (!desk && !isSeller) return null;
  const [accounts, paid] = await Promise.all([
    payoutAccountsFor(sellerId),
    closing.payoutAccountId ? prisma.payoutAccount.findUnique({ where: { id: closing.payoutAccountId } }) : Promise.resolve(null),
  ]);
  const verified = accounts.filter((account) => account.status === "VERIFIED");
  return (
    <section id="payout" aria-labelledby="payout-heading" className="glass scroll-mt-6 p-6">
      <p id="payout-heading" className="eyebrow">Payout account</p>
      {paid && <p className="mt-3 text-sm text-foreground">Proceeds recorded to {payoutLabel(paid)}</p>}
      {isSeller && !desk && (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Your proceeds go only to a payout account the desk verified by calling you on a number it found itself.{" "}
          {verified.length ? `${verified.length} of yours ${verified.length === 1 ? "is" : "are"} verified.` : "None of yours is verified yet."}{" "}
          <a href="/account/finance#payout-accounts" className="font-medium text-link">Your payout accounts</a>
        </p>
      )}
      {desk && (
        <>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            Seller proceeds are recorded only to a verified account. Call the seller on a number you find yourself, never one from the request or an email. Another desk member who approves wires then verifies it.
          </p>
          {!accounts.length && <p className="mt-3 text-sm text-foreground">The seller has no payout account on file.</p>}
          <PayoutAccountList accounts={accounts} viewer={viewer} closingId={closing.id} party="seller" />
        </>
      )}
    </section>
  );
}

type DeskAccount = Awaited<ReturnType<typeof payoutAccountsFor>>[number];

// Each account with its call-back, the four-eyes verify and the reject, for the desk. It says when a sanctions match
// holds the account, and when the name on it isn't the vetted one, which needs the verifier's reason. On a closing
// page the forms come back to the closing; on the payouts page, for a broker's account, they come back there.
export function PayoutAccountList({ accounts, viewer, closingId, party }: { accounts: DeskAccount[]; viewer: Viewer; closingId?: string; party: "seller" | "broker" }) {
  const approves = deskCan(viewer, "approveWires");
  const where = closingId ? <input type="hidden" name="closingId" value={closingId} /> : <input type="hidden" name="back" value="/admin/payouts" />;
  return (
    <>
      <ul className="mt-3 space-y-4">
        {accounts.map((account) => (
          <li key={account.id} className="space-y-2 border-t border-border pt-3 text-sm">
            <p className="text-foreground">{payoutLabel(account)}</p>
            <p className="text-xs text-muted-foreground">
              {account.accountName} · routing {account.routingNumber} · {PAYOUT_STATUS_LABELS[account.status] ?? account.status} · added {prettyDate(account.createdAt)}
              {account.screenedAt ? ` · name screened ${prettyDate(account.screenedAt)}` : ""}
            </p>
            {account.held && (
              <p className="text-xs text-bad">Held: an OFAC match on the name on this account is open or confirmed. Compliance decides it, and nothing is said to the {party}. Verifying screens the name again.</p>
            )}
            {!account.nameMatches && (
              <p className="text-xs text-bad">
                The name on the account isn&apos;t {account.vetted.length ? account.vetted.join(" or ") : "a name the desk vetted"}, the {party}&apos;s vetted name. Verifying it needs your reason, which goes in the audit log.
              </p>
            )}
            {account.callbackAt && (
              <p className="text-xs text-muted-foreground">
                {account.callbackBy} called {account.callbackPhone} on {prettyDate(account.callbackAt)} · {callbackSourceLabel(account.callbackSource)}{account.callbackNote ? ` · ${account.callbackNote}` : ""}
              </p>
            )}
            {account.verifiedAt && <p className="text-xs text-muted-foreground">Verified by {account.verifiedBy} on {prettyDate(account.verifiedAt)}</p>}
            {approves && account.status === "PENDING" && account.callbackAt && account.callbackById !== viewer.id && (
              <form action={decidePayoutAccountAction} className="space-y-2">
                {where}
                <input type="hidden" name="accountId" value={account.id} />
                <input type="hidden" name="decision" value="VERIFIED" />
                {!account.nameMatches && (
                  <input name="reason" required minLength={10} maxLength={300} placeholder="Why the desk accepts this name on the account" aria-label="Why the desk accepts this name on the account" className="desk-input" />
                )}
                <ConfirmSubmit
                  title={`Verify ${payoutLabel(account)}?`}
                  consequence={`${party === "broker" ? "Broker fees can then be approved to it." : "Seller proceeds can then be recorded to it."} Verify only if the call-back above was made on a number the desk found itself, and the ${party} confirmed these details on it. The name on it is screened again first.`}
                  typed={account.nameMatches ? undefined : [["Why the name is accepted", "reason", "text"]]}
                  confirmLabel="Verify the account"
                  pendingLabel="Saving…"
                  className="h-9 text-[13px] font-medium"
                >
                  Verify
                </ConfirmSubmit>
              </form>
            )}
            {approves && account.status === "PENDING" && account.callbackById === viewer.id && <p className="text-xs text-muted-foreground">You logged the call-back, so someone else verifies it.</p>}
            {approves && account.status === "PENDING" && (
              <details>
                <summary className="cursor-pointer text-[13px] font-medium text-link">{account.callbackAt ? "Log the call-back again" : "Log the call-back"}</summary>
                <form action={logPayoutCallbackAction} className="mt-2 space-y-2">
                  {where}
                  <input type="hidden" name="accountId" value={account.id} />
                  <input name="phone" inputMode="tel" required placeholder="Number you dialled" aria-label="Number you dialled" className="desk-input" />
                  <select name="source" required defaultValue="" aria-label="Where you found the number" className="desk-input">
                    <option value="" disabled>Where you found the number</option>
                    {CALLBACK_SOURCES.map((source) => <option key={source.value} value={source.value}>{source.label}</option>)}
                  </select>
                  <input name="note" required minLength={10} maxLength={500} placeholder="Who answered and what they confirmed" aria-label="Who answered and what they confirmed" className="desk-input" />
                  <label className="flex items-start gap-2 text-xs text-foreground">
                    <input type="checkbox" name="independent" value="yes" required className="mt-0.5" />
                    <span>The number didn&apos;t come from the {party}&apos;s request or an email about it.</span>
                  </label>
                  <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Saving…">Log call-back</SubmitButton>
                </form>
              </details>
            )}
            {approves && account.status !== "REJECTED" && (
              <details>
                <summary className="cursor-pointer text-[13px] font-medium text-muted-foreground">Reject</summary>
                <form action={decidePayoutAccountAction} className="mt-2 space-y-2">
                  {where}
                  <input type="hidden" name="accountId" value={account.id} />
                  <input type="hidden" name="decision" value="REJECTED" />
                  <input name="note" required minLength={3} maxLength={300} placeholder="Why, for the desk's record" aria-label="Why it is rejected" className="desk-input" />
                  <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Saving…">Reject account</SubmitButton>
                </form>
              </details>
            )}
          </li>
        ))}
      </ul>
      {!approves && accounts.some((account) => account.status === "PENDING") && <p className="mt-3 text-xs text-muted-foreground">A desk member who approves wires logs the call-back and verifies it.</p>}
    </>
  );
}

// The seller's verified accounts, for the proceeds form's choice.
export async function verifiedPayoutChoices(sellerId: string) {
  const accounts = await activePayoutAccounts(sellerId);
  return accounts.filter((account) => account.status === "VERIFIED").map((account) => ({ id: account.id, label: payoutLabel(account) }));
}

// ---------------------------------------------------------------------------------------------------------------
// Invoices.

type InvoiceClosing = { id: string; status: string; deskBidId: string | null; buyerPremiumCents: number; sellerCommissionCents: number; funders: { userId: string; premiumCents: number }[] };

export async function InvoicePanel({ closing, viewer, sellerId, buyerId }: { closing: InvoiceClosing; viewer: Viewer; sellerId: string; buyerId: string | null }) {
  const desk = viewer.role === "ADMIN";
  const all = await invoicesFor({ closingId: closing.id });
  const rows = desk ? all : all.filter((invoice) => invoice.userId === viewer.id);
  const expected = closingCharges({ ...closing, sellerId, buyerId }).length;
  const missing = desk && closing.status === "COMPLETE" && all.filter((invoice) => invoice.kind !== "CREDIT_NOTE").length < expected;
  if (!rows.length && closing.status !== "COMPLETE" && !desk) return null;
  const credits = all.filter((invoice) => invoice.kind === "CREDIT_NOTE");
  const fees = desk ? deskCan(viewer, "admin") : false;
  const names = desk && rows.length
    ? new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.userId))] } }, select: { id: true, name: true } })).map((person) => [person.id, person.name]))
    : new Map<string, string>();
  return (
    <section id="invoices" aria-labelledby="invoices-heading" className="glass scroll-mt-6 p-6">
      <p id="invoices-heading" className="eyebrow">Invoices</p>
      {!rows.length && <p className="mt-3 text-xs text-muted-foreground">{closing.status === "COMPLETE" ? "No fee invoices on this closing." : "Fee invoices are issued when the closing completes."}</p>}
      <ul className="mt-3 space-y-3 text-sm">
        {rows.map((invoice) => {
          const against = credits.filter((credit) => credit.creditOfId === invoice.id);
          const left = creditLeft(invoice, against);
          return (
            <li key={invoice.id} className="space-y-1">
              <div className="flex justify-between gap-4">
                <a href={`/api/invoices/${invoice.id}`} className="text-link">{invoice.number}</a>
                <span className="text-foreground">{cents(invoice.amountCents)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {INVOICE_KIND_LABELS[invoice.kind] ?? invoice.kind}{desk ? ` · ${names.get(invoice.userId) ?? "Party"}` : ""} · {prettyDate(invoice.issuedAt)}
                {invoice.voidedAt ? " · canceled" : against.length ? ` · ${cents(-against.reduce((sum, credit) => sum + credit.amountCents, 0))} credited` : ""}
              </p>
              {fees && invoice.kind !== "CREDIT_NOTE" && !invoice.voidedAt && left > 0 && (
                <details>
                  <summary className="cursor-pointer text-[13px] font-medium text-muted-foreground">Cancel or refund</summary>
                  <form action={creditInvoiceAction} className="mt-2 space-y-2">
                    <input type="hidden" name="closingId" value={closing.id} />
                    <input type="hidden" name="invoiceId" value={invoice.id} />
                    <input name="amount" inputMode="decimal" placeholder={`Blank cancels all ${cents(left)}`} aria-label="Amount to credit" className="desk-input" />
                    <input name="reason" required minLength={10} maxLength={300} placeholder="Why, in a sentence. The party reads it." aria-label="Why the fee is canceled or refunded" className="desk-input" />
                    <ConfirmSubmit
                      title={`Issue a credit note against ${invoice.number}?`}
                      consequence="A numbered credit note is issued, the ledger takes the amount back, and the party is emailed. The refund itself goes by wire outside the app."
                      typed={[["Amount", "amount", "money"], ["Reason the party reads", "reason", "text"]]}
                      confirmLabel="Issue the credit note"
                      pendingLabel="Issuing…"
                      tone="danger"
                      className="h-9 text-[13px] font-medium"
                    >
                      Issue credit note
                    </ConfirmSubmit>
                  </form>
                </details>
              )}
            </li>
          );
        })}
      </ul>
      {missing && deskCan(viewer, "closings") && (
        <form action={issueClosingInvoicesAction} className="mt-4">
          <input type="hidden" name="closingId" value={closing.id} />
          <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Issuing…">Issue the missing invoices</SubmitButton>
        </form>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The account page.

export async function PayoutAccountsSection({ userId, broker = false }: { userId: string; broker?: boolean }) {
  const accounts = await activePayoutAccounts(userId);
  const full = accounts.length >= MAX_ACTIVE_ACCOUNTS;
  return (
    <section id="payout-accounts" aria-labelledby="payout-accounts-heading" className="mt-8 scroll-mt-6 glass p-6">
      <p id="payout-accounts-heading" className="eyebrow">Payout accounts</p>
      <p className="mt-2 text-sm text-muted-foreground">Where your {broker ? "sale proceeds and broker fees go. The desk pays a fee only to a verified account, whatever your payout note says." : "sale proceeds go."} {PAYOUT_NUMBER_NOTE}</p>
      <p className="mt-2 text-sm text-muted-foreground">Every change is emailed to you. If you get one you didn&apos;t make, call the desk.</p>
      {accounts.length > 0 && (
        <ul className="mt-5 space-y-4">
          {accounts.map((account) => (
            <li key={account.id} className="border-t border-border pt-4 text-sm">
              <p className="text-foreground">{payoutLabel(account)}</p>
              <p className="text-xs text-muted-foreground">
                {account.accountName} · routing {account.routingNumber} · {PAYOUT_STATUS_LABELS[account.status] ?? account.status}
                {account.verifiedAt ? ` ${prettyDate(account.verifiedAt)}` : ""}
              </p>
              <div className="mt-2 flex flex-wrap gap-3">
                <details>
                  <summary className="cursor-pointer text-[13px] font-medium text-link">Change</summary>
                  <PayoutForm replaces={account.id} label="Save the new account" />
                </details>
                <form action={removePayoutAccountAction}>
                  <input type="hidden" name="accountId" value={account.id} />
                  <ConfirmSubmit
                    title={`Remove ${payoutLabel(account)}?`}
                    consequence="Proceeds can't go to it after this. To use it again, add it again and the desk calls you back."
                    confirmLabel="Remove the account"
                    pendingLabel="Removing…"
                    variant="outline"
                    className="h-8 text-[13px] font-medium"
                  >
                    Remove
                  </ConfirmSubmit>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
      {full ? (
        <p className="mt-5 text-xs text-muted-foreground">You can keep {MAX_ACTIVE_ACCOUNTS} payout accounts. Change or remove one to add another.</p>
      ) : (
        <div className="mt-5 border-t border-border pt-4">
          <p className="text-[13px] font-medium text-foreground">{accounts.length ? "Add another account" : "Add an account"}</p>
          <PayoutForm label="Save account" />
        </div>
      )}
    </section>
  );
}

function PayoutForm({ replaces, label }: { replaces?: string; label: string }) {
  return (
    <form action={addPayoutAccountAction} className="mt-3 space-y-3">
      {replaces && <input type="hidden" name="replaces" value={replaces} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Bank</span>
          <Input name="bankName" required maxLength={120} className="mt-1 h-10 bg-card" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Name on the account</span>
          <Input name="accountName" required maxLength={160} className="mt-1 h-10 bg-card" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Routing number</span>
          <Input name="routingNumber" required inputMode="numeric" pattern="[0-9]{9}" minLength={9} maxLength={9} autoComplete="off" className="mt-1 h-10 bg-card tabular-nums" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Last four digits of the account number</span>
          <Input name="accountLast4" required inputMode="numeric" pattern="[0-9]{4}" minLength={4} maxLength={4} autoComplete="off" placeholder="1234" className="mt-1 h-10 w-32 bg-card tabular-nums" />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">Only the last four. UPB never stores the whole number.{replaces ? " The account you're changing stops taking proceeds now, and the new one waits for the desk's call-back." : ""}</p>
      <SubmitButton className="h-10 text-[13px] font-medium" pendingLabel="Saving…">{label}</SubmitButton>
    </form>
  );
}

export async function MyInvoices({ userId }: { userId: string }) {
  const rows = await invoicesFor({ userId });
  const closingIds = [...new Set(rows.map((row) => row.closingId).filter((id): id is string => Boolean(id)))];
  const titles = closingIds.length
    ? new Map((await prisma.closing.findMany({ where: { id: { in: closingIds } }, select: { id: true, listing: { select: { title: true } } } })).map((row) => [row.id, row.listing.title]))
    : new Map<string, string>();
  return (
    <section id="invoices" aria-labelledby="my-invoices-heading" className="mt-8 scroll-mt-6 glass p-6">
      <p id="my-invoices-heading" className="eyebrow">Invoices</p>
      {rows.length ? (
        <ul className="mt-4 divide-y divide-border text-sm">
          {rows.map((invoice) => (
            <li key={invoice.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
              <div className="min-w-0">
                <a href={`/api/invoices/${invoice.id}`} className="text-link">{invoice.number}</a>
                <p className="text-xs text-muted-foreground">
                  {INVOICE_KIND_LABELS[invoice.kind] ?? invoice.kind}
                  {invoice.closingId ? (
                    <>
                      {" · "}
                      <a href={`/closings/${invoice.closingId}`} className="text-link">{titles.get(invoice.closingId) ?? "Closing"}</a>
                    </>
                  ) : null}
                  {" · "}{prettyDate(invoice.issuedAt)}{invoice.voidedAt ? " · canceled" : ""}
                </p>
              </div>
              <span className="text-foreground">{cents(invoice.amountCents)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">Fee invoices appear here when a closing completes. Each one is a PDF you can download.</p>
      )}
    </section>
  );
}

// The desk's finance exports, for the desk book and the admin.
export function FinanceExports({ viewer }: { viewer: Staff }) {
  if (!deskCan(viewer, "deskBook") && !deskCan(viewer, "admin")) return null;
  const links = [
    ["closings", "Closings"],
    ["payouts", "Seller payouts"],
    ["invoices", "Invoices"],
    ["credit-notes", "Credit notes"],
    ["revenue", "Revenue by month"],
  ];
  return (
    <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] font-medium">
      <span className="text-muted-foreground">CSV:</span>
      {links.map(([kind, label]) => (
        <a key={kind} href={`/api/admin/export?kind=${kind}`} className="text-link">{label}</a>
      ))}
    </p>
  );
}
