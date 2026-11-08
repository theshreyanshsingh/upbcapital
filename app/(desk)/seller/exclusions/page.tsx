import { addSellerExclusion, removeSellerExclusion } from "@/actions/private-listings";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { requireRole } from "@/lib/auth";
import { prettyDate, q } from "@/lib/format";
import { REASON_MAX, sellerExclusions } from "@/lib/private-listings";

export const metadata = { title: "Excluded buyers" };

// The seller's standing list of buyers they never sell to: a competitor, or someone tied to a borrower. None of the
// seller's listings shows to them, public or private, and nothing tells them so.
export default async function SellerExclusionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER"]);
  const params = await searchParams;
  const rows = await sellerExclusions(user.id);
  return (
    <div className="max-w-2xl">
      <PageIntro
        eyebrow="Excluded buyers"
        title="Buyers you never sell to."
        lede="None of your listings shows to a buyer on this list, public or private. They can't open it, ask about it, bid on it or be invited to it. They aren't told: the listing just isn't there for them."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <form action={addSellerExclusion} className="mt-6 space-y-4 border border-border p-5 rounded-xl">
        <fieldset>
          <legend className="text-[13px] font-semibold text-foreground">Match by</legend>
          <div className="mt-2 flex flex-wrap gap-4 text-sm text-foreground">
            <label className="flex items-center gap-2">
              <input type="radio" name="kind" value="EMAIL" defaultChecked />
              Email address
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="kind" value="COMPANY" />
              Company name
            </label>
          </div>
        </fieldset>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Email or company</span>
          <Input name="value" required maxLength={200} placeholder="name@firm.com, or Acme Capital LLC" className="mt-2 h-11 bg-card" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Why, for your own record (optional)</span>
          <Input name="reason" maxLength={REASON_MAX} placeholder="Competitor" className="mt-2 h-11 bg-card" />
        </label>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Case doesn&apos;t matter. An email holds the buyer&apos;s account too, so a new address doesn&apos;t get them back in. A company name matches the
          company on their account and every entity they buy through. The desk can read this list.
        </p>
        <SubmitButton pendingLabel="Adding…" className="h-10 px-4 text-[13px] font-medium">Add to the list</SubmitButton>
      </form>
      <section aria-labelledby="excluded-heading" className="mt-8">
        <h2 id="excluded-heading" className="eyebrow">On the list</h2>
        {rows.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No one yet. Every approved buyer can see your public listings.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border border-y border-border">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="break-all text-sm text-foreground">{row.company ? row.company : row.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {row.company ? "Company" : "Email"} · added {prettyDate(row.createdAt)}
                    {row.reason ? ` · ${row.reason}` : ""}
                  </p>
                </div>
                <form action={removeSellerExclusion}>
                  <input type="hidden" name="exclusionId" value={row.id} />
                  <SubmitButton variant="ghost" pendingLabel="Removing…" className="h-9 px-3 text-[13px] font-medium text-link">Remove</SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
