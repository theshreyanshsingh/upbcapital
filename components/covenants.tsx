import Link from "next/link";
import { acknowledgeCovenants } from "@/actions/covenants";
import { CovenantAck } from "@/components/covenant-ack";
import { Tag } from "@/components/loan-file-view";
import { SubmitButton } from "@/components/submit-button";
import { COVENANT_SCHEDULE_TITLE } from "@/lib/closing-docs";
import { closingCovenants, COVENANTS_HEADING, summarizeCovenant, type BidCovenants, type CovenantView } from "@/lib/covenants";
import { prettyDate } from "@/lib/format";

const SHOWN = 6;

type Row = CovenantView["rows"][number];

function CovenantRow({ row, fileHref }: { row: Row; fileHref?: (noteId: string) => string }) {
  const long = row.text != null && summarizeCovenant(row.text) !== row.text.replace(/\s+/g, " ").trim();
  return (
    <li className="min-w-0 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 break-words text-[13px] font-medium text-foreground">{row.label}</p>
        <Tag tone={row.verified ? "good" : "plain"}>{row.verified ? "Desk-verified" : "Seller-stated"}</Tag>
      </div>
      <p className="mt-1 break-words text-sm leading-relaxed text-muted-foreground">
        {row.text == null ? "This text names the borrower, so it shows once the loan opens to you, like the street." : summarizeCovenant(row.text)}
      </p>
      {long && fileHref && <Link href={fileHref(row.noteId)} className="mt-1 inline-flex min-h-10 items-center text-xs font-medium text-link md:min-h-0">Read it in full in the loan file</Link>}
    </li>
  );
}

// The listing's covenants that pass with the loans: a summary of each, since the full text is read where it is
// acknowledged, in the bid form, and in each loan's facts. A buyer whose live bids or seats here wait on the text as
// it stands now acknowledges it again below. `one` scopes it to a pool loan's own file. lib/covenants.ts.
export function CovenantsSection({
  listingId,
  summary,
  rows,
  fileHref,
  owed = null,
  one = false,
}: {
  listingId: string;
  summary: string | null;
  rows: Row[];
  // A pool loan's file, for a text cut short here.
  fileHref?: (noteId: string) => string;
  // The buyer's bids and seats that wait on an acknowledgement, and the covenants it covers.
  owed?: { count: number; covenants: BidCovenants | null } | null;
  one?: boolean;
}) {
  if (!rows.length || !summary) return null;
  const rest = rows.slice(SHOWN);
  return (
    <section id={one ? undefined : "covenants"} aria-labelledby={one ? "loan-covenants-heading" : "covenants-heading"} className="mt-8 scroll-mt-6 rounded-xl border border-border p-5">
      <h2 id={one ? "loan-covenants-heading" : "covenants-heading"} className="eyebrow">{one ? "Covenants that pass with this loan" : COVENANTS_HEADING}</h2>
      {!one && <p className="mt-2 text-sm leading-relaxed text-foreground">{summary}</p>}
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Servicing duties from an earlier sale that travel with the loans, such as an agency servicing standard or loss mitigation owed before foreclosure.
        UPB reads them as binding the buyer and any later holder; counsel to confirm. A bid on these loans acknowledges them, and the purchase agreement carries them as a schedule.
        {one && rows[0]?.text ? " The full text is in this loan's facts below." : ""}
      </p>
      <ul className="mt-3 divide-y divide-border">
        {rows.slice(0, SHOWN).map((row) => <CovenantRow key={row.noteId} row={row} fileHref={fileHref} />)}
      </ul>
      {rest.length > 0 && (
        <details className="border-t border-border pt-3">
          <summary className="cursor-pointer text-[13px] font-medium text-link pointer-coarse:min-h-10">Show {rest.length} more</summary>
          <ul className="divide-y divide-border">
            {rest.map((row) => <CovenantRow key={row.noteId} row={row} fileHref={fileHref} />)}
          </ul>
        </details>
      )}
      {owed && owed.count > 0 && (
        <form action={acknowledgeCovenants} className="mt-4 space-y-3 border-t border-border pt-4">
          <input type="hidden" name="listingId" value={listingId} />
          <p className="text-sm leading-relaxed text-foreground">
            {owed.count === 1 ? "One of your live bids or seats here waits" : `${owed.count} of your live bids and seats here wait`} on the covenants as they stand now: they changed after you
            acknowledged them, or came after you bid. Read them in full and acknowledge them again.
          </p>
          <CovenantAck covenants={owed.covenants} />
          {owed.covenants?.hash && <SubmitButton className="h-11 w-full text-[13px] font-medium sm:w-auto" pendingLabel="Saving…">Acknowledge the covenants</SubmitButton>}
        </form>
      )}
    </section>
  );
}

// The closing page's line: the purchase agreement carries the schedule, and where the buyer's acknowledgement stands.
// Nothing shows when no loan on the closing carries covenants.
export async function ClosingCovenants({ closing }: { closing: { id: string; listingId: string; inquiryId: string | null; deskBidId: string | null; noteId: string | null; noteIds: string[] } }) {
  const found = await closingCovenants(closing);
  if (!found) return null;
  const { standing } = found;
  const line = found.deskPurchase
    ? "The desk buys for its own book and takes the loans subject to them."
    : standing?.acknowledgedAt && standing.current
      ? `The buyer acknowledged them on ${prettyDate(standing.acknowledgedAt)}, before bidding.`
      : standing?.acknowledgedAt
        ? `They changed after the buyer acknowledged them on ${prettyDate(standing.acknowledgedAt)}. The buyer acknowledges them again on the listing before signing.`
        : "The buyer hasn't acknowledged them yet, and does so on the listing before signing.";
  return (
    <p className="mt-4 rounded-lg border border-border px-3 py-2 text-sm leading-relaxed text-foreground">
      <span className="font-medium">{COVENANT_SCHEDULE_TITLE}.</span> The purchase agreement carries it, as part of the desk&apos;s draft pending counsel review.{" "}
      {found.covenants.summary} {line}
    </p>
  );
}
