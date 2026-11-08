import type { Metadata } from "next";
import Link from "next/link";
import { PublicPage } from "@/components/public-page";
import { getCurrentUser } from "@/lib/auth";
import { prettyDate } from "@/lib/format";
import { STANDARD_GROUPS, STANDARD_SET_ON, STANDARD_VERSION, TAPE_STANDARD, type MismoMatch } from "@/lib/mismo";

export const metadata: Metadata = {
  title: "Tape standard",
  description: "UPB Capital's loan tape: every field, its type, the values it takes, whether it's required, and where it sits in MISMO 3.x.",
};
export const dynamic = "force-dynamic";

const MATCH: Record<MismoMatch, string> = {
  exact: "MISMO",
  approximate: "Approximate",
  extension: "UPB extension",
};

const MATCH_TONE: Record<MismoMatch, string> = {
  exact: "bg-good/10 text-good",
  approximate: "bg-warn/12 text-warn",
  extension: "bg-muted text-muted-foreground",
};

// Public, so a bank seller can map its tape once, before it has an account.
export default async function TapeStandardPage() {
  const user = await getCurrentUser();
  const counts = {
    exact: TAPE_STANDARD.filter((field) => field.mismo.match === "exact").length,
    approximate: TAPE_STANDARD.filter((field) => field.mismo.match === "approximate").length,
    extension: TAPE_STANDARD.filter((field) => field.mismo.match === "extension").length,
  };
  return (
    <PublicPage
      title="The tape standard."
      lede="Every column UPB reads from a loan tape, what it takes, and the closest name for it in MISMO 3.x, the mortgage industry's data dictionary. Map your tape to it once."
      authed={Boolean(user)}
    >
      <section aria-label="About this standard" className="space-y-3">
        <p>
          {STANDARD_VERSION}, set {prettyDate(STANDARD_SET_ON)}. {TAPE_STANDARD.length} fields: {TAPE_STANDARD.filter((field) => field.required).length} required, the rest optional. A tape with other headers still
          works: the upload suggests a mapping from common servicer headings, and you confirm it.
        </p>
        <p>
          {counts.exact} fields map to a MISMO data point with the same meaning, {counts.approximate} map approximately, and {counts.extension} have no MISMO
          data point and travel as UPB extensions. This is UPB&apos;s own reading of MISMO 3.4 and the GSE loan delivery dataset. It isn&apos;t MISMO-certified, and
          MISMO hasn&apos;t reviewed it.
        </p>
        <div className="flex flex-wrap gap-4 text-[13px] font-medium">
          <a className="text-link" href="/api/tapes/template?format=csv">Download the CSV template</a>
          <a className="text-link" href="/api/tapes/template?format=xlsx">Download the Excel template</a>
        </div>
        <p className="text-sm text-muted-foreground">
          The template carries these headers in this order, with three fictional loans to try the mapper on. Buyers with Pro can download a listing&apos;s tape as
          CSV, Excel, or JSON keyed by these MISMO paths.
        </p>
      </section>

      {STANDARD_GROUPS.map((group) => {
        const fields = TAPE_STANDARD.filter((field) => field.group === group.group);
        return (
          <section key={group.group} aria-labelledby={`group-${group.group}`} className="space-y-3">
            <h2 id={`group-${group.group}`} className="font-semibold tracking-tight text-2xl text-foreground">{group.title}</h2>
            <p className="text-sm text-muted-foreground">{group.lede}</p>
            <dl className="divide-y divide-border border-y border-border">
              {fields.map((field) => (
                <div key={field.key} className="grid gap-2 py-4 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:gap-4">
                  <dt className="min-w-0">
                    <code className="break-all text-[13px] font-medium text-foreground">{field.header}</code>
                    <p className="mt-1 text-xs text-muted-foreground">{field.required ? "Required" : "Optional"} · {field.type}</p>
                  </dt>
                  <dd className="min-w-0 space-y-1.5 text-sm">
                    <p className="text-foreground">{field.label}</p>
                    {field.allowed && <p className="text-muted-foreground">Takes: {field.allowed}.</p>}
                    <p className="flex flex-wrap items-center gap-2">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${MATCH_TONE[field.mismo.match]}`}>{MATCH[field.mismo.match]}</span>
                      <code className="text-[13px] text-foreground">{field.mismo.name}</code>
                    </p>
                    <p className="break-all text-xs text-muted-foreground"><code>{field.mismo.path}</code></p>
                    {field.mismo.note && <p className="text-xs leading-relaxed text-muted-foreground">{field.mismo.note}</p>}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}

      <section aria-label="Reading the paths" className="space-y-3">
        <h2 className="font-semibold tracking-tight text-2xl text-foreground">Reading the paths</h2>
        <p>
          A path runs from MISMO&apos;s DEAL container to the data point. A bracket picks one row of a repeating container, such as the party whose role is
          Borrower. A UPB extension sits under the loan&apos;s EXTENSION container, the place MISMO leaves for data it doesn&apos;t define.
        </p>
        <p>
          Values keep UPB&apos;s own codes, listed above, rather than MISMO&apos;s enumerations. Approximate rows say how the meaning differs, or that the name
          hasn&apos;t been checked against the reference model yet. Check any row against your own MISMO implementation before you rely on it.
        </p>
      </section>

      <p className="text-sm text-muted-foreground">
        Questions about mapping a tape go to the desk. See also the <Link href="/fees" className="text-link">fee schedule</Link> and{" "}
        <Link href="/security" className="text-link">security</Link>.
      </p>
    </PublicPage>
  );
}
