import Link from "next/link";
import { submitValuation } from "@/actions/valuations";
import { PublicPage } from "@/components/public-page";
import { SubmitButton } from "@/components/submit-button";
import { getCurrentUser } from "@/lib/auth";
import { recordHit } from "@/lib/hits";
import { LIEN_POSITIONS, PAYMENT_STATUSES, US_STATES } from "@/lib/labels";
import { safeNoticeText } from "@/lib/notice-text";
import { MAX_TYPED_LOANS } from "@/lib/valuations";

export const metadata = {
  title: "Value my loans",
  description: "Send a tape or a few loans and see an indicative range from the UPB Capital desk's model and closed trades.",
};
export const dynamic = "force-dynamic";

const SHOWN_ROWS = 3;

function LoanRow({ index }: { index: number }) {
  const n = index + 1;
  return (
    <fieldset className="grid grid-cols-2 gap-3 border-t border-border pt-4 sm:grid-cols-4">
      <legend className="col-span-full text-[13px] font-medium text-foreground">Loan {n}</legend>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">State</span>
        <select name="state" defaultValue="" className="desk-input mt-2" aria-label={`Loan ${n} state`}>
          <option value="">Choose</option>
          {US_STATES.map((state) => <option key={state}>{state}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Lien</span>
        <select name="lienPosition" defaultValue="FIRST" className="desk-input mt-2" aria-label={`Loan ${n} lien`}>
          {LIEN_POSITIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      <label className="col-span-2 block">
        <span className="text-[13px] text-muted-foreground">Performance</span>
        <select name="paymentStatus" defaultValue="PERFORMING" className="desk-input mt-2" aria-label={`Loan ${n} performance`}>
          {PAYMENT_STATUSES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      <label className="block"><span className="text-[13px] text-muted-foreground">Unpaid balance</span><input name="upb" inputMode="decimal" className="desk-input mt-2 tabular-nums" aria-label={`Loan ${n} unpaid balance`} /></label>
      <label className="block"><span className="text-[13px] text-muted-foreground">Note rate %</span><input name="interestRate" inputMode="decimal" className="desk-input mt-2 tabular-nums" aria-label={`Loan ${n} note rate`} /></label>
      <label className="block"><span className="text-[13px] text-muted-foreground">Monthly P&amp;I</span><input name="monthlyPi" inputMode="decimal" className="desk-input mt-2 tabular-nums" aria-label={`Loan ${n} monthly payment`} /></label>
      <label className="block"><span className="text-[13px] text-muted-foreground">Property value</span><input name="estimatedValue" inputMode="decimal" className="desk-input mt-2 tabular-nums" aria-label={`Loan ${n} property value`} /></label>
      <label className="col-span-2 block sm:col-span-1"><span className="text-[13px] text-muted-foreground">Months behind</span><input name="monthsDelinquent" inputMode="numeric" placeholder="0" className="desk-input mt-2 tabular-nums" aria-label={`Loan ${n} months behind`} /></label>
    </fieldset>
  );
}

export default async function ValueMyLoansPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await recordHit("/sell/value");
  const [params, user] = await Promise.all([searchParams, getCurrentUser().catch(() => null)]);
  // The same rule as Notice: text from the address bar shows only as a plain sentence.
  const error = typeof params.error === "string" ? (safeNoticeText(params.error) ?? "That didn't go through. Check the form and try again.") : "";
  const rows = Array.from({ length: MAX_TYPED_LOANS }, (_, index) => index);
  return (
    <PublicPage
      title="Value my loans."
      lede="Send a tape, or type up to ten loans, and see an indicative range at once. The desk then reads what you sent and comes back with its own range."
      authed={Boolean(user)}
    >
      <p className="text-sm leading-relaxed text-muted-foreground">
        The range comes from the desk&apos;s pricing model at its target yield and from closed trades on UPB for loans like yours. It is not an offer, an appraisal or advice. You don&apos;t need an account.
      </p>
      {error && <p role="alert" className="rounded-xl border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">{error}</p>}
      <form action={submitValuation} className="glass space-y-8 p-5 md:p-8">
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="eyebrow mb-4">Who is asking</legend>
          <label className="block"><span className="text-[13px] text-muted-foreground">Name</span><input name="name" required autoComplete="name" defaultValue={user?.name ?? ""} className="desk-input mt-2" /></label>
          <label className="block"><span className="text-[13px] text-muted-foreground">Email</span><input name="email" type="email" required autoComplete="email" defaultValue={user?.email ?? ""} className="desk-input mt-2" /></label>
          <label className="block"><span className="text-[13px] text-muted-foreground">Company</span><input name="company" required autoComplete="organization" defaultValue={user?.companyName ?? ""} className="desk-input mt-2" /></label>
          <label className="block"><span className="text-[13px] text-muted-foreground">Phone, if you&apos;d like a call</span><input name="phone" type="tel" autoComplete="tel" className="desk-input mt-2" /></label>
        </fieldset>
        <fieldset className="space-y-3">
          <legend className="eyebrow mb-4">A tape</legend>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">CSV or Excel, one loan per row, up to 2,000 rows</span>
            <input name="tape" type="file" accept=".csv,.xlsx,.xls" className="desk-input mt-2" />
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Columns are matched by their headings: balance, note rate, monthly payment, property value, state, lien and payment status. The <a href="/api/tapes/template" className="text-link">tape template</a> has them all. Borrower names are not kept. A tape takes the place of any loans typed below.
          </p>
        </fieldset>
        <fieldset className="space-y-4">
          <legend className="eyebrow mb-4">Or type the loans</legend>
          {rows.slice(0, SHOWN_ROWS).map((index) => <LoanRow key={index} index={index} />)}
          <details className="space-y-4">
            <summary className="cursor-pointer text-sm text-link">Add up to {MAX_TYPED_LOANS - SHOWN_ROWS} more</summary>
            <div className="mt-4 space-y-4">{rows.slice(SHOWN_ROWS).map((index) => <LoanRow key={index} index={index} />)}</div>
          </details>
          <p className="text-xs text-muted-foreground">Leave a row blank to skip it.</p>
        </fieldset>
        <label className="flex items-start gap-3 text-sm text-foreground">
          <input type="checkbox" name="terms" value="yes" required className="mt-1" />
          <span>I agree to the <Link href="/terms" className="text-link">terms of use</Link>, and that the desk may contact me about these loans.</span>
        </label>
        <SubmitButton className="h-11 px-6 text-[13px] font-medium" pendingLabel="Pricing…">See the range</SubmitButton>
      </form>
      <p className="text-sm text-muted-foreground">
        One note and no tape? The <Link href="/sell" className="text-link">quick quote</Link> takes a minute.
      </p>
    </PublicPage>
  );
}
