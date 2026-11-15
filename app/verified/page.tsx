import type { Metadata } from "next";
import Link from "next/link";
import { PublicPage } from "@/components/public-page";
import { modelReadingAllowed, readingModeOf, type ReadingMode } from "@/lib/ai-reading";
import { getCurrentUser } from "@/lib/auth";
import { DILIGENCE_ITEMS } from "@/lib/diligence-checklist";
import { DISCREPANCY_LABELS } from "@/lib/discrepancies";
import { DUPLICATE_REASONS } from "@/lib/duplicates";
import { LOAN_FIELDS, VERIFY_SOURCES } from "@/lib/loan-file";
import { getSettings } from "@/lib/settings";

export const metadata: Metadata = {
  title: "Desk-verified",
  description: "What a desk-verified field on UPB Capital means: what the desk checks, against which document, and what it does not check.",
};
export const dynamic = "force-dynamic";

// Plain statements of what the code does, read from the same lists the desk works from: the field badges and their
// documents (lib/loan-file.ts), the diligence set (lib/diligence-checklist.ts), the discrepancy gate
// (lib/discrepancies.ts), the duplicate hold (lib/duplicates.ts) and the document reader's mode (lib/ai-reading.ts).
// Anything the desk doesn't do is said not to be done.

const BADGES: [string, string][] = [
  [
    "Desk-verified against a document",
    "A desk member read the field in the named document and found the tape matches it. The badge names the document and the day: “Desk-verified against pay history · Oct 2, 2026”.",
  ],
  [
    "Servicer report",
    "Read from a third-party servicer's report, named in the badge. The desk didn't check it. Where the desk has checked the field too, its own check shows instead.",
  ],
  [
    "Holder's servicing software",
    "Read from software the seller runs to service its own loans. It is the seller's own record, so it carries the seller-stated colour.",
  ],
  [
    "Differs from the document",
    "The desk, or a servicer's report, read something other than the tape. The tape still shows the seller's figure, and the seller must fix it or explain it before the listing goes live.",
  ],
  [
    "Seller-stated",
    "Nothing has checked the field. It is as the seller gave it. A field the seller changed after a check also reads seller-stated, with the date of the check it no longer matches.",
  ],
];

const MODE_WORDS: Record<ReadingMode, string> = { OFF: "off", SHADOW: "shadow", ON: "on" };

export default async function VerifiedPage() {
  const [settings, user] = await Promise.all([getSettings(), getCurrentUser()]);
  const mode = readingModeOf(settings.aiReading);
  const pdfs = modelReadingAllowed();
  const keyFields = LOAN_FIELDS.filter((spec) => spec.key);
  const documents = VERIFY_SOURCES.filter((source) => source !== "Other");
  const outcomes = Object.entries(DISCREPANCY_LABELS).filter(([status]) => status !== "OPEN").map(([, label]) => label.toLowerCase());
  const reasons = Object.values(DUPLICATE_REASONS);
  const sections: [string, string[]][] = [
    [
      "The rule",
      [
        "A field counts as desk-verified only when a person on the UPB desk checked it against a named document in the loan file and recorded which one. Nothing else makes a field verified: not the seller's word, not a servicer's report, and not the document reader on its own.",
        "A check holds for the value it was made against. If the seller changes the field or sends a new tape, the badge goes back to seller-stated until the desk checks again.",
        "Desk-verified means the tape matches the document the desk read. It doesn't mean the document is genuine, complete or enforceable, and it says nothing about what the loan is worth.",
      ],
    ],
    [
      "Before a listing goes live",
      [
        "Every loan needs its diligence set on file, listed below. An item that is missing holds the approval until it is added, or until compliance waives it with a reason. Buyers see which items were waived and why. On file means the document is in the loan file or the desk marked it present; the desk can also mark a document missing or defective.",
        `When a document the desk reads says something other than the tape, the seller has to fix the tape or explain the difference before the listing goes live. The desk may instead apply the document's value or waive the question, each with a reason. Each difference ends as one of these: ${outcomes.join(", ")}. Buyers see every answer, dated.`,
        `A loan can't be on the book twice. A loan that matches one on another listing in review, live or in contract (${reasons.join("; ")}) holds the approval until the desk compares the two and clears the match with a note of what it compared. A relist can be legitimate, so the seller isn't blocked from filing.`,
      ],
    ],
    [
      "The document reader",
      [
        "The desk's reader reads the files in a listing's room and loan file and sets what it finds beside the tape, with the words it read. The reader reads; the desk confirms. A finding never verifies a field. Only when a desk member confirms it is the field marked desk-verified, against that file's document.",
        `It runs in one of three modes. Off, it doesn't run. Shadow, the default, sends what it finds to the desk only, marked unconfirmed. On, a difference it finds also goes to the seller to fix or explain, as a difference the desk found would. Today it is ${mode === "OFF" ? "off" : `in ${MODE_WORDS[mode]} mode`}.`,
        pdfs
          ? "It reads text files, spreadsheets and PDFs, and skips images."
          : "Today it reads text files and spreadsheets, and skips PDFs and images, which the desk reads by hand.",
      ],
    ],
    [
      "What the desk does not check",
      [
        "UPB doesn't issue or buy title insurance. A title policy or O&E report in the file is a document the seller or the desk obtained, and the desk reads what it says. It doesn't insure what it says.",
        "UPB doesn't guarantee a value. A BPO, appraisal or AVM in the file is someone's dated opinion, and a desk-verified value only matches that opinion.",
        "UPB doesn't give a legal opinion: not on whether a note is enforceable, whether a lien is perfected or first, or whether an endorsement or assignment chain would hold up in court. The desk reads the chain and flags a break it can see. That is UPB's reading, not legal advice; the buyer's own counsel confirms it.",
        "UPB doesn't promise that a borrower will pay. And a field marked seller-stated has not been checked at all.",
      ],
    ],
  ];
  return (
    <PublicPage
      title="What desk-verified means."
      lede="A field reads desk-verified only when the desk checked it against a named document. Here is what the desk checks, against what, and what it doesn't check."
      authed={Boolean(user)}
    >
      {sections.slice(0, 1).map(([heading, lines]) => (
        <section key={heading} aria-label={heading} className="space-y-3">
          <h2 className="font-semibold tracking-tight text-2xl text-foreground">{heading}</h2>
          {lines.map((line) => <p key={line}>{line}</p>)}
        </section>
      ))}

      <section className="glass p-5 md:p-6" aria-labelledby="badges-heading">
        <h2 id="badges-heading" className="eyebrow">The badges on a loan file</h2>
        <dl className="mt-4 divide-y divide-border">
          {BADGES.map(([label, text]) => (
            <div key={label} className="grid gap-1 py-3 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-4">
              <dt className="text-sm font-medium text-foreground">{label}</dt>
              <dd className="text-sm leading-relaxed text-muted-foreground">{text}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="glass p-5 md:p-6" aria-labelledby="fields-heading">
        <h2 id="fields-heading" className="eyebrow">Which document each key field is checked against</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The document the desk usually reads for each of the {keyFields.length} key fields a loan file counts. The desk names the document it actually read on each check, which may be another from the list below. The desk doesn&apos;t check every field on every loan; the file says how many it has.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[20rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[13px] text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-medium">Field</th>
                <th scope="col" className="py-2 font-medium">Usually checked against</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {keyFields.map((spec) => (
                <tr key={spec.field}>
                  <th scope="row" className="py-2 pr-3 text-left font-normal text-foreground">{spec.label}</th>
                  <td className="py-2 text-muted-foreground">{spec.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">The documents the desk may name: {documents.join(", ")}, or another document it names.</p>
      </section>

      <section className="glass p-5 md:p-6" aria-labelledby="diligence-heading">
        <h2 id="diligence-heading" className="eyebrow">The diligence set</h2>
        <p className="mt-2 text-sm text-muted-foreground">What each loan needs on file before its listing goes live.</p>
        <dl className="mt-4 divide-y divide-border">
          {DILIGENCE_ITEMS.map((item) => (
            <div key={item.key} className="grid gap-1 py-3 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-4">
              <dt className="text-sm font-medium text-foreground">{item.label}</dt>
              <dd className="text-sm leading-relaxed text-muted-foreground">{item.hint}{item.scope === "listing" ? " Once per pool." : ""}</dd>
            </div>
          ))}
        </dl>
      </section>

      {sections.slice(1).map(([heading, lines]) => (
        <section key={heading} aria-label={heading} className="space-y-3">
          <h2 className="font-semibold tracking-tight text-2xl text-foreground">{heading}</h2>
          {lines.map((line) => <p key={line}>{line}</p>)}
        </section>
      ))}

      <p className="text-sm text-muted-foreground">
        Fields and their meanings are in the <Link href="/tape-standard" className="text-link">tape standard</Link>. What a trade costs is on the <Link href="/fees" className="text-link">fee schedule</Link>, and how the desk guards the data is on the <Link href="/security" className="text-link">security page</Link>.
      </p>
    </PublicPage>
  );
}
