import Link from "next/link";
import { bulkReview } from "@/actions/desk-tools";
import { SubmitButton } from "@/components/submit-button";
import { BULK_LIMIT, parseBulkDetail, runPrefix } from "@/lib/desk-bulk";
import { prisma } from "@/lib/prisma";

const FORM_ID = "bulk-review";

// The queue's bulk decision. The boxes sit on each row, outside this form, and join it by its id. Each picked
// listing then goes through the single-listing decision and its gates (actions/desk-tools.ts bulkReview).
export function BulkReviewForm() {
  return (
    <form id={FORM_ID} action={bulkReview} className="mt-6 space-y-3 rounded-xl border border-border p-4" aria-labelledby="bulk-heading">
      <p id="bulk-heading" className="eyebrow">Decide several</p>
      <p className="text-sm text-muted-foreground">
        Tick the listings below, up to {BULK_LIMIT}. Each one runs every check its own Approve runs. Any a check stops stays as it is, and the reason shows here. Approved listings go live now; set a launch time from the listing page.
      </p>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Note to each seller</span>
        <textarea name="comment" maxLength={2000} className="desk-input mt-2 min-h-20" aria-describedby="bulk-note-hint" />
        <span id="bulk-note-hint" className="mt-1 block text-xs text-muted-foreground">Needed to request changes. Optional to approve.</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <SubmitButton name="action" value="APPROVE" className="h-10 text-[13px] font-medium" pendingLabel="Deciding…">Approve the ticked listings</SubmitButton>
        <SubmitButton name="action" value="REQUEST_CHANGES" variant="outline" className="h-10 text-[13px] font-medium" pendingLabel="Deciding…">Request changes on them</SubmitButton>
      </div>
    </form>
  );
}

export function BulkPick({ id, title }: { id: string; title: string }) {
  return (
    <label className="flex shrink-0 items-center pl-5 pointer-coarse:pl-4">
      <input type="checkbox" name="listingId" value={id} form={FORM_ID} aria-label={`Pick ${title}`} className="size-4" />
    </label>
  );
}

// What one run did to each listing, read back from the audit log it wrote. Only the desk member who ran it sees it.
export async function BulkResults({ run, viewerId }: { run: string; viewerId: string }) {
  const events = await prisma.auditEvent.findMany({
    where: { action: "BULK_REVIEW", actorId: viewerId, detail: { startsWith: runPrefix(run) } },
    orderBy: { createdAt: "asc" },
    take: BULK_LIMIT,
  });
  if (!events.length) return null;
  const titles = new Map(
    (await prisma.listing.findMany({ where: { id: { in: events.map((event) => event.entityId) } }, select: { id: true, title: true } })).map((row) => [row.id, row.title]),
  );
  const rows = events.map((event) => ({ id: event.entityId, title: titles.get(event.entityId) ?? "A listing no longer on the desk", ...parseBulkDetail(event.detail) }));
  const stopped = rows.filter((row) => !row.ok);
  return (
    <section id="bulk-results" aria-labelledby="bulk-results-heading" className="mt-6 scroll-mt-6 rounded-xl border border-border p-4">
      <p id="bulk-results-heading" className="eyebrow">Last bulk decision</p>
      <ul className="mt-2 divide-y divide-border text-sm">
        {[...stopped, ...rows.filter((row) => row.ok)].map((row) => (
          <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
            <Link href={`/admin/listings/${row.id}`} className="font-medium text-link">{row.title}</Link>
            <span className={row.ok ? "text-muted-foreground" : "text-bad"}>{row.ok ? row.message : `Not done. ${row.message}`}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
