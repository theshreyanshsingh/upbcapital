import { importFilings, setFilingStatus } from "@/actions/filings";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { FILING_COUNTIES } from "@/lib/filings";
import { prettyDate, q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { deskCan } from "@/lib/staff";

export const metadata = { title: "Filings" };

const FILING_STATUS: Record<string, string> = { NEW: "New", CONTACTED: "Contacted", LISTING: "Becoming a listing", PASSED: "Passed" };

export default async function FilingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Every desk role reads the filings. Importing and working them is sales work, and the actions check the same.
  const sells = deskCan(await requireRole(["ADMIN"]), "sales");
  const query = await searchParams;
  const filings = await prisma.courtFiling.findMany({ include: { note: true }, orderBy: { createdAt: "desc" }, take: 80 });
  return (
    <div>
      <PageIntro
        eyebrow="Pre-foreclosure"
        title="Lis pendens and filings."
        lede="Paste a clerk export from Miami-Dade, Broward, or Palm Beach. Columns the desk reads: case number, filing date, defendant, plaintiff, address, city, zip. A row that matches a note’s street and city is linked."
      />
      <Notice notice={q(query, "notice")} error={q(query, "error")} />
      {sells ? (
        <form action={importFilings} className="mt-8 grid max-w-xl gap-3">
          <select name="county" className="desk-input" aria-label="County" defaultValue="Miami-Dade">
            {FILING_COUNTIES.map((county) => <option key={county}>{county}</option>)}
          </select>
          <textarea name="csv" className="desk-input min-h-32" aria-label="Filing CSV" placeholder={"case_number,filing_date,defendant,plaintiff,address,city,zip\n2026-001,2026-10-01,Sample Borrower,Sample Bank,100 Sample St,Miami,33130"} />
          <input name="file" type="file" accept=".csv,text/csv" className="text-xs text-muted-foreground" aria-label="Filing file" />
          <SubmitButton className="h-11 text-[13px] font-medium">Import</SubmitButton>
        </form>
      ) : (
        <p className="mt-8 text-sm text-muted-foreground">Imports and outreach are for the sales side of the desk.</p>
      )}
      <ul className="mt-10 space-y-4">
        {filings.length === 0 && <li className="text-sm text-muted-foreground">No filings yet.</li>}
        {filings.map((filing) => (
          <li key={filing.id} className="border border-border p-5 rounded-xl">
            <p className="font-semibold tracking-tight text-2xl text-foreground">{filing.caseNumber}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {filing.county} · {filing.filedOn ? prettyDate(filing.filedOn) : "date not parsed"} · {filing.defendant || "Defendant not named"}
              {filing.street ? ` · ${filing.street}, ${filing.city}` : ""}
            </p>
            <p className="mt-2 text-sm text-link">{filing.note ? `Matched ${filing.note.city} note` : "No note on the book matches this address."}</p>
            {sells ? (
              <form action={setFilingStatus} className="mt-4 grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)_auto]">
                <input type="hidden" name="id" value={filing.id} />
                <select name="status" defaultValue={filing.status} className="desk-input" aria-label={`Status for ${filing.caseNumber}`}>
                  {Object.entries(FILING_STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <input name="outreach" defaultValue={filing.outreach} className="desk-input" aria-label="Outreach note" placeholder="Who was called" />
                <SubmitButton variant="outline" className="h-11 text-[13px] font-medium">Save</SubmitButton>
              </form>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">{FILING_STATUS[filing.status] ?? filing.status.toLowerCase()}{filing.outreach ? ` · ${filing.outreach}` : ""}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
