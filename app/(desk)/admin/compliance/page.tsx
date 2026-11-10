import { decideOfacReview, reopenOfacReview, runRetention, saveDisclosure, saveRetention, screenName } from "@/actions/compliance";
import { DeletionQueue } from "@/components/deletion-queue";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { FLORIDA_DISCLOSURE } from "@/lib/compliance";
import { prettyDate, q } from "@/lib/format";
import { US_STATES } from "@/lib/labels";
import { SANCTIONS_RECORD_YEARS, sanctionSource } from "@/lib/ofac";
import { prisma } from "@/lib/prisma";
import { openReviewWhere, reviewKey } from "@/lib/screening";
import { getSettings } from "@/lib/settings";
import { deskCan } from "@/lib/staff";

export const metadata = { title: "Compliance" };

export default async function CompliancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Every desk role reads the page. Decisions, screens and settings here are compliance work; the actions check the same.
  const vets = deskCan(await requireRole(["ADMIN"]), "compliance");
  const params = await searchParams;
  // Open reviews and confirmed matches are holds, so every one shows. Only the cleared history is cut short.
  const [settings, disclosures, checks, openRows, confirmedRows, clearedRows, source] = await Promise.all([
    getSettings(),
    prisma.stateDisclosure.findMany({ orderBy: { state: "asc" } }),
    prisma.ofacCheck.findMany({ orderBy: { createdAt: "desc" }, take: 8 }),
    prisma.ofacCheck.findMany({ where: openReviewWhere, orderBy: { createdAt: "desc" } }),
    prisma.ofacCheck.findMany({ where: { result: "REVIEW", status: "CONFIRMED" }, orderBy: { createdAt: "desc" } }),
    prisma.ofacCheck.findMany({ where: { result: "REVIEW", status: "CLEARED" }, orderBy: { createdAt: "desc" }, take: 300 }),
    sanctionSource(),
  ]);
  // One row per party, name and list entry: a decision covers them all, and an open review needs one answer.
  const seen = new Set<string>();
  const latest = <T extends Parameters<typeof reviewKey>[0]>(rows: T[]) =>
    rows.filter((row) => {
      const key = reviewKey(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const open = latest(openRows);
  const decided = [...latest(confirmedRows), ...latest(clearedRows).slice(0, 12)];
  const florida = disclosures.find((row) => row.state === "FL");
  return (
    <div>
      <PageIntro
        eyebrow="Compliance"
        title="What has to be on the file."
        lede="State notes show on the listing and the closing checklist. Seller-financed paper also carries the Dodd-Frank and SAFE Act reminders. None of this is a legal opinion."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      {!vets && <p className="mt-4 text-sm text-muted-foreground">Your desk role reads this page. Changes are for compliance.</p>}

      <section className="glass mt-8 p-6">
        <p className="eyebrow">State disclosure</p>
        {vets && <form action={saveDisclosure} className="mt-4 grid gap-3">
          <div className="grid gap-3 sm:grid-cols-[120px_minmax(0,1fr)]">
            <select name="state" defaultValue={florida?.state || "FL"} className="desk-input" aria-label="State">
              {US_STATES.map((state) => <option key={state} value={state}>{state}</option>)}
            </select>
            <input name="license" defaultValue={florida?.license || FLORIDA_DISCLOSURE.license} className="desk-input" aria-label="License note" placeholder="License note" />
          </div>
          <textarea name="body" defaultValue={florida?.body || FLORIDA_DISCLOSURE.body} className="desk-input min-h-32" aria-label="Disclosure" required />
          <SubmitButton className="h-11 w-fit text-[13px] font-medium">Save disclosure</SubmitButton>
        </form>}
        <ul className="mt-6 space-y-3">
          {!vets && disclosures.length === 0 && <li className="text-sm text-muted-foreground">No state notes saved yet.</li>}
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
          A match stops account approval, listing approval, awards, and closing steps until someone decides it. Nothing is said to the party. A confirmed match stays blocked: stop the deal and call counsel, because OFAC reports can be due within 10 business days. Reopen a decision only to correct it. The audit log keeps the decision it replaced. This is a name match, not a legal clearance.
        </p>
        {open.length === 0 && <p className="mt-4 text-sm text-muted-foreground">No reviews waiting.</p>}
        <ul className="mt-4 space-y-4">
          {open.map((check) => (
            <li key={check.id} className="border border-border p-4 rounded-xl">
              <p className="text-sm text-foreground">{check.name}{check.matched ? ` · matched ${check.matched}` : ""}</p>
              <p className="mt-1 text-xs text-muted-foreground">{check.context || "Screened before reviews were tracked"} · {check.listVersion ?? check.provider} · {prettyDate(check.createdAt)}</p>
              {check.detail && <p className="mt-1 text-xs text-muted-foreground">{check.detail}</p>}
              {vets && <form action={decideOfacReview} className="mt-3 space-y-2">
                {/* Not name="id": it shadows form.id in the DOM, and React then drops the clicked button's value. */}
                <input type="hidden" name="checkId" value={check.id} />
                <input name="note" className="desk-input" aria-label={`Reason for the decision on ${check.name}`} placeholder="What you checked: date of birth, address, country" required minLength={3} />
                <div className="flex flex-wrap gap-2">
                  <button type="submit" name="decision" value="CLEARED" className="h-9 rounded-lg border border-border px-3 text-[13px] font-medium hover:bg-hover">Clear as a false match</button>
                  <button type="submit" name="decision" value="CONFIRMED" className="h-9 rounded-lg border border-bad/40 px-3 text-[13px] font-medium text-bad hover:bg-bad/10">Confirm the match</button>
                </div>
              </form>}
            </li>
          ))}
        </ul>
        {decided.length > 0 && (
          <>
            <p className="mt-6 text-[13px] text-muted-foreground">Decided</p>
            <ul className="mt-2 space-y-2 text-sm">
              {decided.map((check) => (
                <li key={check.id} className="text-muted-foreground">
                  <span className={check.status === "CONFIRMED" ? "text-bad" : "text-foreground"}>{check.name}</span>{check.matched ? ` · matched ${check.matched}` : ""} · {check.status?.toLowerCase()}{check.reviewedAt ? ` ${prettyDate(check.reviewedAt)}` : ""} · {check.reviewNote}
                  {vets && <details className="mt-1">
                    <summary className="w-fit cursor-pointer text-[13px] text-link">Reopen</summary>
                    <form action={reopenOfacReview} className="mt-2 flex flex-wrap gap-2">
                      <input type="hidden" name="checkId" value={check.id} />
                      <input name="note" className="desk-input min-w-56 flex-1" aria-label={`Reason to reopen the decision on ${check.name}`} placeholder="Why it needs another look" required minLength={3} />
                      <button type="submit" className="h-11 rounded-lg border border-border px-3 text-[13px] font-medium hover:bg-hover">Reopen the review</button>
                    </form>
                  </details>}
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
          {vets && (
            <form action={screenName} className="mt-4 flex flex-wrap gap-3">
              <input name="name" className="desk-input min-w-56" aria-label="Name to screen" placeholder="Borrower or entity" required />
              <SubmitButton className="h-11 text-[13px] font-medium">Screen</SubmitButton>
            </form>
          )}
          <ul className="mt-4 space-y-2 text-sm">
            {checks.length === 0 && <li className="text-muted-foreground">No screens yet.</li>}
            {checks.map((check) => (
              <li key={check.id} className="text-muted-foreground"><span className="text-foreground">{check.name}</span> · {check.result} · {check.listVersion ?? check.provider}</li>
            ))}
          </ul>
        </div>
        <div className="border border-border p-5 rounded-xl">
          <p className="eyebrow">Retention</p>
          <p className="mt-2 text-sm text-muted-foreground">Page visits and read notices older than this window can be removed. Loan files, closings, and the ledger stay.</p>
          <p className="mt-2 text-sm text-muted-foreground">Sanctions screening records keep a floor of {SANCTIONS_RECORD_YEARS} years whatever this says, and the retention run never removes them. That is UPB&apos;s reading of OFAC&apos;s recordkeeping rule (31 CFR 501.601). Counsel confirms the periods.</p>
          {vets ? (
            <>
              <form action={saveRetention} className="mt-4 flex flex-wrap items-center gap-3">
                <input name="retentionYears" defaultValue={settings.retentionYears} className="desk-input w-28" aria-label="Retention years" />
                <SubmitButton variant="outline" className="h-11 text-[13px] font-medium">Save years</SubmitButton>
              </form>
              <form action={runRetention} className="mt-4">
                <SubmitButton className="h-11 text-[13px] font-medium">Run retention</SubmitButton>
              </form>
            </>
          ) : (
            <p className="mt-4 text-sm text-foreground">{settings.retentionYears} years</p>
          )}
        </div>
      </section>

      <DeletionQueue readOnly={!vets} />
    </div>
  );
}
