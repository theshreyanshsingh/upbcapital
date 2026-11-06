import Link from "next/link";
import { money, prettyDate } from "@/lib/format";
import { BID_MODES } from "@/lib/filters";

type Event = { at: Date | string | null; label: string; detail?: string };
type OwnInquiry = { id: string; type: string; status: string; amount: number | null; createdAt: Date; expiresAt: Date | null; noteName: string | null };

const STATUS: Record<string, string> = {
  OPEN: "Open",
  REVIEWED: "With the desk",
  ACCEPTED: "Accepted",
  DECLINED: "Declined",
  WITHDRAWN: "Withdrawn",
  EXPIRED: "Expired",
};

const TYPE: Record<string, string> = { OFFER: "Bid", INFO_REQUEST: "Question", DATA_ROOM: "Data room request" };

// The listing's dates, and this buyer's own bids and requests on it. Other buyers' interest stays with the desk.
export function ListingTimeline({
  events,
  mine,
  ownerHref,
}: {
  events: Event[];
  mine: OwnInquiry[] | null;
  // For the seller or the desk: where the interest counts live.
  ownerHref: string | null;
}) {
  return (
    <div className="mt-8 grid gap-6 lg:grid-cols-2">
      <section aria-labelledby="dates-heading">
        <h2 id="dates-heading" className="eyebrow">Dates</h2>
        <ol className="mt-4 space-y-3 border-l border-border pl-4">
          {events.filter((event) => event.at).map((event) => (
            <li key={event.label}>
              <p className="text-sm text-foreground">{event.label}</p>
              <p className="text-xs text-muted-foreground tabular-nums">{prettyDate(event.at)}{event.detail ? ` · ${event.detail}` : ""}</p>
            </li>
          ))}
        </ol>
      </section>
      {mine && (
        <section aria-labelledby="mine-heading">
          <h2 id="mine-heading" className="eyebrow">Your bids and requests</h2>
          {mine.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">Nothing from you on this listing yet.</p>
          ) : (
            <ul className="mt-4 divide-y divide-border border border-border rounded-xl">
              {mine.map((inquiry) => (
                <li key={inquiry.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
                  <div>
                    <p className="text-sm text-foreground tabular-nums">
                      {TYPE[inquiry.type] ?? inquiry.type}{inquiry.amount != null ? ` ${money(inquiry.amount)}` : ""}
                      {inquiry.noteName ? <span className="text-muted-foreground"> · {inquiry.noteName}</span> : null}
                    </p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {prettyDate(inquiry.createdAt)}{inquiry.expiresAt ? ` · good until ${prettyDate(inquiry.expiresAt)}` : ""}
                    </p>
                  </div>
                  <span className="text-[13px] font-medium text-muted-foreground">{STATUS[inquiry.status] ?? inquiry.status}</span>
                </li>
              ))}
            </ul>
          )}
          <Link href="/buyer/offers" className="mt-3 inline-block text-[13px] font-medium text-link">All your bids</Link>
        </section>
      )}
      {ownerHref && (
        <section aria-labelledby="interest-heading">
          <h2 id="interest-heading" className="eyebrow">Buyer interest</h2>
          <p className="mt-4 text-sm text-muted-foreground">Opens, NDAs, saves and bidders are counted on the listing&apos;s own page.</p>
          <Link href={ownerHref} className="mt-3 inline-block text-[13px] font-medium text-link">Open the counts</Link>
        </section>
      )}
    </div>
  );
}

export function bidModeLabel(mode: string) {
  return BID_MODES.find((option) => option.value === mode)?.label ?? mode;
}
