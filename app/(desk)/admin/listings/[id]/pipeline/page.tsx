import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { ACTIVE_DAYS, LOOKING_DAYS, RETURN_DAYS, STAGES, STAGE_LABELS, bidderPipeline, type EngagementLevel } from "@/lib/engagement";
import { money, prettyDate } from "@/lib/format";
import { DESK_DENIED, deskCan } from "@/lib/staff";

export const metadata = { title: "Bidder pipeline" };

const LEVEL_TONE: Record<EngagementLevel, string> = {
  Active: "bg-good/10 text-good",
  Looking: "bg-link/10 text-link",
  Quiet: "bg-muted text-muted-foreground",
};

// One sale's bidders on one page: who the listing reached, how far each came, what they did and when, and the desk's
// next step with each. The sales side runs it, as it reviews and awards the listing. lib/engagement.ts holds the rules.
export default async function BidderPipelinePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireRole(["ADMIN"]);
  const { id } = await params;
  if (!deskCan(user, "sales")) redirect(`/admin/listings/${id}?error=${encodeURIComponent(DESK_DENIED)}`);
  const now = new Date();
  const pipeline = await bidderPipeline(id, user, now);
  if (!pipeline) notFound();
  const { listing, rows, walled } = pipeline;
  const counts = STAGES.map((stage) => ({ stage, count: rows.filter((row) => row.stage === stage).length })).filter((row) => row.count > 0);
  const deadline = listing.bidMode !== "NONE" && listing.bidDeadline ? listing.bidDeadline : null;
  return (
    <div>
      <p className="text-sm">
        <Link href={`/admin/listings/${listing.id}`} className="text-link">Back to the listing</Link>
      </p>
      <PageIntro
        eyebrow="Bidder pipeline"
        title={listing.title}
        lede="Every buyer this sale reached, furthest stage first, then the most recent. The level is what each one did on this listing, read from the desk's own logs. It is for the desk only: the seller sees counts, never a level, and it is not a grade or a forecast."
      />
      <p className="text-sm text-muted-foreground tabular-nums">
        {rows.length} prospective bidder{rows.length === 1 ? "" : "s"}
        {counts.length ? ` · ${counts.map((row) => `${row.count} ${STAGE_LABELS[row.stage].toLowerCase()}`).join(" · ")}` : ""}
        {deadline ? ` · bids due ${prettyDate(deadline)}` : " · open offers"}
      </p>
      {walled && <p className="mt-2 text-sm text-muted-foreground">Your desk role doesn&apos;t read sealed bids, so bid amounts stay hidden until the deadline.</p>}

      {rows.length === 0 ? (
        <p className="mt-6 border border-dashed border-border px-4 py-6 text-sm text-muted-foreground rounded-xl">
          No buyer has been matched, invited, sent this listing or opened it yet.
        </p>
      ) : (
        <div className="mt-6 relative overflow-x-auto border border-border rounded-xl">
          <table className="min-w-full text-left text-sm">
            <caption className="sr-only">Prospective bidders on this listing, furthest stage first</caption>
            <thead className="text-xs font-medium text-muted-foreground">
              <tr>
                {["Bidder", "Stage", "Last activity", "Engagement", "Next step"].map((heading) => (
                  <th key={heading} scope="col" className="px-3 py-2 font-normal">{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-border align-top">
                  <td className="px-3 py-3">
                    {row.userId ? (
                      <Link href={`/admin/buyers/${row.userId}`} className="font-medium text-link">{row.name}</Link>
                    ) : (
                      <span className="font-medium text-foreground">{row.name}</span>
                    )}
                    {row.userId && <p className="text-xs text-muted-foreground">{row.email}</p>}
                  </td>
                  <td className="px-3 py-3">
                    <p className="text-foreground">{STAGE_LABELS[row.stage]}</p>
                    {row.bid && (
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {row.bid.sealed ? "Amount sealed until the deadline" : row.bid.amount != null ? money(row.bid.amount) : ""}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">
                    {row.last ? (
                      <>
                        <p className="text-foreground">{row.last.what}</p>
                        <p className="text-xs tabular-nums">{prettyDate(row.last.at)}</p>
                      </>
                    ) : (
                      "Matched only"
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${LEVEL_TONE[row.engagement.level]}`}>{row.engagement.level}</span>
                    <p className="mt-1 text-xs text-foreground">{row.engagement.why}</p>
                    <p className="mt-1 text-xs text-muted-foreground tabular-nums">{row.engagement.facts.join(" · ")}</p>
                  </td>
                  <td className="px-3 py-3">
                    {row.next.href ? (
                      <Link href={row.next.href} className="text-[13px] font-medium text-link">{row.next.text}</Link>
                    ) : (
                      <span className="text-[13px] text-muted-foreground">{row.next.text}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="mt-8 max-w-3xl border border-border p-5 rounded-xl" aria-labelledby="levels-heading">
        <p id="levels-heading" className="eyebrow">How the level is read</p>
        <ul className="mt-3 space-y-2 text-sm leading-relaxed text-foreground">
          <li>
            <span className="font-medium">Active:</span> in the last {ACTIVE_DAYS} days the bidder bid, asked a question or opened a file in the data room, or came back to the listing on {RETURN_DAYS} different days.
          </li>
          <li>
            <span className="font-medium">Looking:</span> they did something on the listing in the last {LOOKING_DAYS} days: opened it, signed the NDA, saved it, or one of the active things more than a week ago.
          </li>
          <li>
            <span className="font-medium">Quiet:</span> nothing in the last {LOOKING_DAYS} days.
          </li>
        </ul>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Counted from the listing&apos;s logs: opens of the listing (once an hour at most), NDAs, room downloads, questions, saves and bids. Recent activity counts more than old. It says what a bidder did, not what they will do.
        </p>
      </section>
    </div>
  );
}
