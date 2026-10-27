import { runRetention, saveDisclosure, saveRetention, screenName } from "@/actions/compliance";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { FLORIDA_DISCLOSURE } from "@/lib/compliance";
import { q } from "@/lib/format";
import { US_STATES } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "Compliance" };

export default async function CompliancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole(["ADMIN"]);
  const params = await searchParams;
  const [settings, disclosures, checks] = await Promise.all([
    getSettings(),
    prisma.stateDisclosure.findMany({ orderBy: { state: "asc" } }),
    prisma.ofacCheck.findMany({ orderBy: { createdAt: "desc" }, take: 8 }),
  ]);
  const florida = disclosures.find((row) => row.state === "FL");
  return (
    <div>
      <PageIntro
        eyebrow="Compliance"
        title="What has to be on the file."
        lede="State notes show on the listing and the closing checklist. Seller-financed paper also carries the Dodd-Frank and SAFE Act reminders. None of this is a legal opinion."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />

      <section className="glass mt-8 p-6">
        <p className="eyebrow">State disclosure</p>
        <form action={saveDisclosure} className="mt-4 grid gap-3">
          <div className="grid gap-3 sm:grid-cols-[120px_minmax(0,1fr)]">
            <select name="state" defaultValue={florida?.state || "FL"} className="desk-input" aria-label="State">
              {US_STATES.map((state) => <option key={state} value={state}>{state}</option>)}
            </select>
            <input name="license" defaultValue={florida?.license || FLORIDA_DISCLOSURE.license} className="desk-input" aria-label="License note" placeholder="License note" />
          </div>
          <textarea name="body" defaultValue={florida?.body || FLORIDA_DISCLOSURE.body} className="desk-input min-h-32" aria-label="Disclosure" required />
          <SubmitButton className="h-11 w-fit text-[13px] font-medium">Save disclosure</SubmitButton>
        </form>
        <ul className="mt-6 space-y-3">
          {disclosures.map((row) => (
            <li key={row.state} className="text-sm">
              <p className="text-foreground">{row.state}</p>
              <p className="text-muted-foreground">{row.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="border border-border p-5 rounded-xl">
          <p className="eyebrow">Name screen</p>
          <p className="mt-2 text-sm text-muted-foreground">Names are matched against a local SDN list, including the planted strings “blocked test” and “ofac sample”, with fuzzy spelling. If OFAC_API_URL and OFAC_API_KEY are set, the desk parses the vendor body and screens against those names too.</p>
          <form action={screenName} className="mt-4 flex flex-wrap gap-3">
            <input name="name" className="desk-input min-w-56" aria-label="Name to screen" placeholder="Borrower or entity" required />
            <SubmitButton className="h-11 text-[13px] font-medium">Screen</SubmitButton>
          </form>
          <ul className="mt-4 space-y-2 text-sm">
            {checks.length === 0 && <li className="text-muted-foreground">No screens yet.</li>}
            {checks.map((check) => (
              <li key={check.id} className="text-muted-foreground"><span className="text-foreground">{check.name}</span> · {check.result} · {check.provider}</li>
            ))}
          </ul>
        </div>
        <div className="border border-border p-5 rounded-xl">
          <p className="eyebrow">Retention</p>
          <p className="mt-2 text-sm text-muted-foreground">Page visits and read notices older than this window can be removed. Loan files, closings, and the ledger stay.</p>
          <form action={saveRetention} className="mt-4 flex flex-wrap items-center gap-3">
            <input name="retentionYears" defaultValue={settings.retentionYears} className="desk-input w-28" aria-label="Retention years" />
            <SubmitButton variant="outline" className="h-11 text-[13px] font-medium">Save years</SubmitButton>
          </form>
          <form action={runRetention} className="mt-4">
            <SubmitButton className="h-11 text-[13px] font-medium">Run retention</SubmitButton>
          </form>
        </div>
      </section>
    </div>
  );
}
