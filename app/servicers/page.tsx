import type { Metadata } from "next";
import Link from "next/link";
import { PublicPage } from "@/components/public-page";
import { recordHit } from "@/lib/hits";
import { activeServicers, importFormatLabel } from "@/lib/servicers";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Servicer directory",
  description: "Loan servicers buyers on UPB Capital board purchased notes with: the states they list, their fees as the desk entered them, and whether UPB reads their export.",
};

// Public, so a buyer can see who boards loans before an award. Every figure is what the desk entered on
// /admin/servicers. Nothing here is a recommendation or a quote.
export default async function ServicersPage() {
  await recordHit("/servicers");
  const servicers = await activeServicers();
  return (
    <PublicPage
      title="Servicer directory."
      lede="A bought note moves to a servicer, who collects the payments and keeps the record. These are servicers buyers here can pick when they board a loan. Fees are as the desk entered them. Confirm them with the servicer."
    >
      {servicers.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-5 py-6 text-muted-foreground">
          The desk is adding servicers. Until then, a buyer names their own servicer when they board a loan.
        </p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {servicers.map((servicer) => (
            <li key={servicer.id} className="bg-card px-4 py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h2 className="text-[17px] font-semibold tracking-tight text-foreground">
                  {servicer.website ? <a href={servicer.website} rel="noopener noreferrer nofollow" target="_blank" className="hover:text-link">{servicer.name}</a> : servicer.name}
                </h2>
                <span className={`text-[13px] font-medium ${importFormatLabel(servicer.importFormat) ? "text-link" : "text-muted-foreground"}`}>
                  {importFormatLabel(servicer.importFormat) ? "UPB reads their export" : "UPB doesn't read their export yet"}
                </span>
              </div>
              <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">States</dt>
                  <dd className="text-foreground">{servicer.states.length ? servicer.states.join(", ") : "Not listed"}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Boarding fee</dt>
                  <dd className="text-foreground">{servicer.boardingFee || "Not listed"}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Monthly fee</dt>
                  <dd className="text-foreground">{servicer.monthlyFee || "Not listed"}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm text-muted-foreground">
        Reading an export means a seller or the desk can upload that servicer&apos;s report and check the tape against it. A servicer
        that isn&apos;t listed can still board your loan. <Link href="/fees" className="text-link">UPB&apos;s own fees</Link>
      </p>
    </PublicPage>
  );
}
