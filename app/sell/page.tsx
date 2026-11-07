import Link from "next/link";
import { quoteLead } from "@/actions/leads";
import { Logo } from "@/components/logo";
import { SubmitButton } from "@/components/submit-button";
import { recordHit } from "@/lib/hits";
import { LIEN_POSITIONS, PAYMENT_STATUSES, US_STATES } from "@/lib/labels";
import { safeNoticeText } from "@/lib/notice-text";

export const metadata = { title: "Sell your note" };
export const dynamic = "force-dynamic";

export default async function SellPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await recordHit("/sell");
  const params = await searchParams;
  // The same rule as Notice: text from the address bar shows only as a plain sentence.
  const error = typeof params.error === "string" ? (safeNoticeText(params.error) ?? "That didn't go through. Check the form and try again.") : "";
  return (
    <main id="desk" className="mx-auto max-w-3xl px-5 py-16">
      <Logo />
      <p className="eyebrow mt-12">Sell your note</p>
      <h1 className="mt-3 font-semibold tracking-tight text-5xl text-foreground md:text-6xl">An indicative range, before the file.</h1>
      <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
        A few facts produce a desk range from the same bands and comps used on the book. It is not an offer. The listing still waits on review.
      </p>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
        Several loans, or a tape? <Link href="/sell/value" className="text-link">Value my loans</Link> prices up to ten typed loans or a whole tape, and the desk follows up with its own range.
      </p>
      {error && <p role="alert" className="mt-6 border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad rounded-xl">{error}</p>}
      <form action={quoteLead} className="glass mt-8 grid gap-4 p-6 md:grid-cols-2 md:p-8">
        <label className="block"><span className="text-[13px] text-muted-foreground">Name</span><input name="name" required className="desk-input mt-2" aria-label="Name" /></label>
        <label className="block"><span className="text-[13px] text-muted-foreground">Email</span><input name="email" type="email" required className="desk-input mt-2" aria-label="Email" /></label>
        <label className="block"><span className="text-[13px] text-muted-foreground">Phone</span><input name="phone" className="desk-input mt-2" aria-label="Phone" /></label>
        <label className="block"><span className="text-[13px] text-muted-foreground">City</span><input name="city" className="desk-input mt-2" aria-label="City" /></label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">State</span>
          <select name="state" defaultValue="FL" className="desk-input mt-2" aria-label="State">
            {US_STATES.map((state) => <option key={state}>{state}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Lien</span>
          <select name="lienPosition" className="desk-input mt-2" aria-label="Lien">
            {LIEN_POSITIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Performance</span>
          <select name="paymentStatus" className="desk-input mt-2" aria-label="Performance">
            {PAYMENT_STATUSES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label className="block"><span className="text-[13px] text-muted-foreground">Unpaid principal</span><input name="upb" inputMode="decimal" required className="desk-input mt-2" aria-label="Unpaid principal" /></label>
        <label className="block"><span className="text-[13px] text-muted-foreground">Estimated value</span><input name="estimatedValue" inputMode="decimal" required className="desk-input mt-2" aria-label="Estimated value" /></label>
        <label className="block"><span className="text-[13px] text-muted-foreground">Note rate %</span><input name="interestRate" inputMode="decimal" required className="desk-input mt-2" /></label>
        <label className="block"><span className="text-[13px] text-muted-foreground">Monthly P&I</span><input name="monthlyPi" inputMode="decimal" required className="desk-input mt-2" /></label>
        <label className="block md:col-span-2"><span className="text-[13px] text-muted-foreground">Anything else</span><textarea name="note" className="desk-input mt-2 min-h-24" /></label>
        <div className="md:col-span-2">
          <SubmitButton className="h-11 px-6 text-[13px] font-medium">See the range</SubmitButton>
        </div>
      </form>
      <p className="mt-8 text-sm text-muted-foreground">
        Already on the desk? <Link href="/login" className="text-link">Sign in</Link>
      </p>
    </main>
  );
}
