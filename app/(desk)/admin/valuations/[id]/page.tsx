import Link from "next/link";
import { notFound } from "next/navigation";
import { closeValuationRequest, inviteValuationSeller, linkValuation, sendValuationQuote } from "@/actions/valuations";
import { ConfirmRows, ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { money, pct, prettyDate, q } from "@/lib/format";
import { labelOf } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { requireDesk } from "@/lib/staff";
import { statusLabel, storedLoans } from "@/lib/valuations";

export const metadata = { title: "Valuation request" };

const SHOWN_LOANS = 200;

export default async function ValuationRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireDesk("sales", "/admin");
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const request = await prisma.valuationRequest.findUnique({ where: { id } });
  if (!request) notFound();
  const loans = storedLoans(request.rows);
  const account = await prisma.user.findFirst({
    where: request.userId ? { id: request.userId } : { email: request.email },
    select: { id: true, name: true, role: true, accountStatus: true },
  });
  const listings = account
    ? await prisma.listing.findMany({ where: { sellerId: account.id, status: { notIn: ["WITHDRAWN", "REJECTED"] } }, select: { id: true, title: true, status: true }, orderBy: { createdAt: "desc" }, take: 20 })
    : [];
  const linked = request.listingId ? await prisma.listing.findUnique({ where: { id: request.listingId }, select: { id: true, title: true } }) : null;
  const closed = request.status === "CLOSED";
  const ltv = (loan: (typeof loans)[number]) => (loan.estimatedValue > 0 ? (loan.upb / loan.estimatedValue) * 100 : null);
  return (
    <div className="max-w-5xl">
      <p className="text-sm text-muted-foreground"><Link href="/admin/valuations" className="text-link">Valuation requests</Link></p>
      <PageIntro
        eyebrow={`Valuation · ${statusLabel(request.status)}`}
        title={request.company && request.company !== request.name ? `${request.name}, ${request.company}` : request.name}
        lede={`${request.loans === 1 ? "1 loan" : `${request.loans} loans`}, ${money(request.upb)} UPB, sent ${prettyDate(request.createdAt)}.`}
      />
      <Notice notice={q(query, "notice")} error={q(query, "error")} />
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <div><dt className="text-[13px] text-muted-foreground">Email</dt><dd className="mt-1 break-all text-foreground"><a href={`mailto:${request.email}`} className="text-link">{request.email}</a></dd></div>
        <div><dt className="text-[13px] text-muted-foreground">Phone</dt><dd className="mt-1 text-foreground">{request.phone || "Not given"}</dd></div>
        <div>
          <dt className="text-[13px] text-muted-foreground">Tape</dt>
          <dd className="mt-1 text-foreground">{request.tapeKey ? <a href={`/admin/valuations/${request.id}/tape`} className="text-link">{request.tapeName || "Download"}</a> : "Typed in the form"}</dd>
        </div>
        <div>
          <dt className="text-[13px] text-muted-foreground">Range now</dt>
          <dd className="mt-1 text-foreground tabular-nums">{request.lowPrice != null && request.highPrice != null ? `${money(request.lowPrice)} – ${money(request.highPrice)}` : "None"}</dd>
        </div>
        <div className="sm:col-span-2"><dt className="text-[13px] text-muted-foreground">Instant range basis</dt><dd className="mt-1 text-muted-foreground">{request.basis}</dd></div>
      </dl>
      {request.deskNote && (
        <p className="mt-4 whitespace-pre-wrap rounded-xl border border-border px-4 py-3 text-sm text-foreground">
          <span className="block text-[13px] text-muted-foreground">Note sent with the desk&apos;s range</span>
          {request.deskNote}
        </p>
      )}

      <section className="mt-8" aria-labelledby="loans-heading">
        <h2 id="loans-heading" className="eyebrow">The loans</h2>
        <div className="mt-3 overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[44rem] text-sm tabular-nums">
            <thead>
              <tr className="border-b border-border text-left text-[13px] text-muted-foreground">
                {["Where", "Lien", "Status", "Behind", "Rate", "P&I", "UPB", "Value", "LTV"].map((heading) => (
                  <th key={heading} scope="col" className={`px-3 py-2 font-medium ${heading === "Where" || heading === "Lien" || heading === "Status" ? "" : "text-right"}`}>{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loans.slice(0, SHOWN_LOANS).map((loan, index) => (
                <tr key={index}>
                  <td className="px-3 py-2 text-foreground">{loan.city ? `${loan.city}, ` : ""}{loan.state}</td>
                  <td className="px-3 py-2 text-muted-foreground">{labelOf("lien", loan.lienPosition)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{labelOf("payment", loan.paymentStatus)}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground">{loan.monthsDelinquent || "—"}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground">{pct(loan.interestRate, 2)}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground">{money(loan.monthlyPi)}</td>
                  <td className="px-3 py-2 text-right text-foreground">{money(loan.upb)}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground">{money(loan.estimatedValue)}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground">{pct(ltv(loan), 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loans.length > SHOWN_LOANS && <p className="mt-2 text-xs text-muted-foreground">The first {SHOWN_LOANS} of {loans.length} loans. The tape has the rest.</p>}
      </section>

      {!closed && (
        <form action={sendValuationQuote} className="mt-8 space-y-4 glass p-6" aria-labelledby="quote-heading">
          <input type="hidden" name="id" value={request.id} />
          <h2 id="quote-heading" className="eyebrow">Send the desk&apos;s range</h2>
          <p className="text-sm text-muted-foreground">Adjust the range and say what it rests on. The seller gets both by email, and the request is marked quoted.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block"><span className="text-[13px] text-muted-foreground">Low (USD)</span><input name="low" inputMode="decimal" required defaultValue={request.lowPrice != null ? Math.round(request.lowPrice) : ""} className="desk-input mt-2 tabular-nums" /></label>
            <label className="block"><span className="text-[13px] text-muted-foreground">High (USD)</span><input name="high" inputMode="decimal" required defaultValue={request.highPrice != null ? Math.round(request.highPrice) : ""} className="desk-input mt-2 tabular-nums" /></label>
          </div>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Note to the seller</span>
            <textarea name="note" required minLength={3} defaultValue={request.deskNote} className="desk-input mt-2 min-h-28" />
          </label>
          <ConfirmSubmit
            title="Send this range to the seller?"
            consequence={`${request.email} gets an email with the range and your note. It says the range is an estimate, not an offer.`}
            typed={[["Low", "low", "money"], ["High", "high", "money"]]}
            details={<ConfirmRows rows={[["To", request.email], ["Loans", `${request.loans}, ${money(request.upb)} UPB`]]} />}
            confirmLabel="Send the range"
            pendingLabel="Sending…"
            className="h-11 text-[13px] font-medium"
          >
            Send range
          </ConfirmSubmit>
        </form>
      )}

      {!closed && (
        <section className="mt-8 space-y-4 glass p-6" aria-labelledby="list-heading">
          <h2 id="list-heading" className="eyebrow">Invite to list</h2>
          {account ? (
            <p className="text-sm text-muted-foreground">
              {account.name} has {account.role === "INSTITUTIONAL_SELLER" ? "an institutional seller" : account.role === "INDIVIDUAL_SELLER" ? "an individual seller" : "a non-seller"} account, {account.accountStatus.toLowerCase()}.{" "}
              <Link href={`/admin/users?q=${encodeURIComponent(request.email)}`} className="text-link">Open it in Accounts</Link>.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">No account uses this email. An invite sets one up in their name and emails a link to choose a password.</p>
          )}
          <form action={inviteValuationSeller} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="id" value={request.id} />
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Account</span>
              <select name="role" defaultValue={account?.role === "INDIVIDUAL_SELLER" || (!account && request.loans === 1) ? "INDIVIDUAL_SELLER" : "INSTITUTIONAL_SELLER"} className="desk-input mt-2" aria-label="Seller account type">
                <option value="INSTITUTIONAL_SELLER">Institutional seller, reviewed before tapes open</option>
                <option value="INDIVIDUAL_SELLER">Individual seller</option>
              </select>
            </label>
            <SubmitButton variant="outline" className="h-11 text-[13px] font-medium" pendingLabel="Sending…">{account ? "Ask them to list" : "Send the account invite"}</SubmitButton>
          </form>
          {listings.length > 0 && (
            <form action={linkValuation} className="flex flex-wrap items-end gap-3 border-t border-border pt-4">
              <input type="hidden" name="id" value={request.id} />
              <label className="block min-w-0 flex-1">
                <span className="text-[13px] text-muted-foreground">Their listing for these loans</span>
                <select name="listingId" defaultValue={request.listingId ?? listings[0].id} className="desk-input mt-2" aria-label="Listing for these loans">
                  {listings.map((listing) => <option key={listing.id} value={listing.id}>{listing.title} · {listing.status.replaceAll("_", " ").toLowerCase()}</option>)}
                </select>
              </label>
              <SubmitButton variant="outline" className="h-11 text-[13px] font-medium" pendingLabel="Saving…">Mark listed</SubmitButton>
            </form>
          )}
          {linked && <p className="text-sm text-foreground">Listed as <Link href={`/admin/listings/${linked.id}`} className="text-link">{linked.title}</Link>.</p>}
        </section>
      )}

      {!closed ? (
        <form action={closeValuationRequest} className="mt-8 flex flex-wrap items-end gap-3 border-t border-border pt-6">
          <input type="hidden" name="id" value={request.id} />
          <label className="block min-w-0 flex-1">
            <span className="text-[13px] text-muted-foreground">Close the request. Why, for the desk only</span>
            <input name="note" required minLength={3} className="desk-input mt-2" placeholder="Not a fit, no reply, or listed elsewhere" />
          </label>
          <SubmitButton variant="outline" className="h-11 text-[13px] font-medium" pendingLabel="Closing…">Close request</SubmitButton>
        </form>
      ) : (
        <p className="mt-8 text-sm text-muted-foreground">This request is closed. The audit log has the reason.</p>
      )}
    </div>
  );
}
