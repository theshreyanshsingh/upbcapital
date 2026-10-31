import { decideOfacReview, runRetention, saveDisclosure, saveRetention, screenName } from "@/actions/compliance";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { FLORIDA_DISCLOSURE } from "@/lib/compliance";
import { prettyDate, q } from "@/lib/format";
import { US_STATES } from "@/lib/labels";
import { ofacOpen, sanctionSource } from "@/lib/ofac";
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
  const [settings, disclosures, checks, reviews, source] = await Promise.all([
    getSettings(),
    prisma.stateDisclosure.findMany({ orderBy: { state: "asc" } }),
    prisma.ofacCheck.findMany({ orderBy: { createdAt: "desc" }, take: 8 }),
    prisma.ofacCheck.findMany({ where: { result: "REVIEW" }, orderBy: { createdAt: "desc" }, take: 300 }),
    sanctionSource(),
  ]);
  // One row per name and list entry: a decision covers them all, and an open review needs one answer.
  const seen = new Set<string>();
  const latest = reviews.filter((row) => {
    const key = `${row.name}|${row.matched ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const open = latest.filter(ofacOpen);
  const decided = latest.filter((row) => !ofacOpen(row)).slice(0, 12);
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

      <section className="glass mt-8 p-6">
        <p className="eyebrow">OFAC reviews</p>
        {source.provider === "local" ? (
          <p role="alert" className="mt-3 border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad rounded-xl">
            {source.unavailable ? source.note : `Not real screening. The desk is using a ${source.count}-name stand-in, including two test strings. Set OFAC_SDN_URL to screen against Treasury’s SDN list.`}
          </p>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            Screening {source.count.toLocaleString("en-US")} names and aliases from {source.provider === "treasury" ? "Treasury’s SDN list" : "the vendor list"}{source.fetchedAt ? `, read ${prettyDate(source.fetchedAt)}` : ""}. Vessels and aircraft are left out.{source.note ? ` ${source.note}` : ""}
          </p>
        )}
        <p className="mt-2 text-sm text-muted-foreground">
          A match stops account approval, listing approval, awards, and closing steps until someone decides it. Nothing is said to the party. A confirmed match stays blocked: stop the deal and call counsel, because OFAC reports can be due within 10 business days. This is a name match, not a legal clearance.
        </p>
        {open.length === 0 && <p className="mt-4 text-sm text-muted-foreground">No reviews waiting.</p>}
        <ul className="mt-4 space-y-4">
          {open.map((check) => (
            <li key={check.id} className="border border-border p-4 rounded-xl">
              <p className="text-sm text-foreground">{check.name}{check.matched ? ` · matched ${check.matched}` : ""}</p>
              <p className="mt-1 text-xs text-muted-foreground">{check.context || "Screened before reviews were tracked"} · {check.provider} · {prettyDate(check.createdAt)}</p>
              {check.detail && <p className="mt-1 text-xs text-muted-foreground">{check.detail}</p>}
              <form action={decideOfacReview} className="mt-3 space-y-2">
                {/* Not name="id": it shadows form.id in the DOM, and React then drops the clicked button's value. */}
                <input type="hidden" name="checkId" value={check.id} />
                <input name="note" className="desk-input" aria-label={`Reason for the decision on ${check.name}`} placeholder="What you checked: date of birth, address, country" required minLength={3} />
                <div className="flex flex-wrap gap-2">
                  <button type="submit" name="decision" value="CLEARED" className="h-9 rounded-lg border border-border px-3 text-[13px] font-medium hover:bg-hover">Clear as a false match</button>
                  <button type="submit" name="decision" value="CONFIRMED" className="h-9 rounded-lg border border-bad/40 px-3 text-[13px] font-medium text-bad hover:bg-bad/10">Confirm the match</button>
                </div>
              </form>
            </li>
          ))}
        </ul>
        {decided.length > 0 && (
          <>
            <p className="mt-6 text-[13px] text-muted-foreground">Decided</p>
            <ul className="mt-2 space-y-2 text-sm">
              {decided.map((check) => (
                <li key={check.id} className="text-muted-foreground">
                  <span className={check.status === "CONFIRMED" ? "text-bad" : "text-foreground"}>{check.name}</span> · {check.status?.toLowerCase()}{check.reviewedAt ? ` ${prettyDate(check.reviewedAt)}` : ""} · {check.reviewNote}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="border border-border p-5 rounded-xl">
          <p className="eyebrow">Name screen</p>
          <p className="mt-2 text-sm text-muted-foreground">Check any name by hand, with fuzzy spelling and either word order. The planted strings “blocked test” and “ofac sample” always go to review, so you can test the flow.</p>
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
