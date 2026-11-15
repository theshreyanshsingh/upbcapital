import { confirmAvailable, giveOwnershipStatement } from "@/actions/provenance";
import { OwnershipStatement } from "@/components/ownership-statement";
import { SubmitButton } from "@/components/submit-button";
import { deskCan, type Staff } from "@/lib/desk-roles";
import { prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { PAUSE_AFTER_DAYS, REMIND_AFTER_DAYS, provenanceHold } from "@/lib/provenance";
import { availabilityLine, availableSince, remindedSince, stalePaused, statementKind, statementText } from "@/lib/provenance-rules";

// The ownership statement and freshness on each page that shows a listing: the seller's, broker's and buyer-seller's
// own pages, the desk's review page and queue, and the buyer's listing page. Each loads what it shows, so a shared
// page needs one line for it.

const DAY = 24 * 60 * 60 * 1000;
const IN_REVIEW = ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED"];

type ProvenanceListing = {
  id: string;
  status: string;
  sellerId: string;
  brokerId?: string | null;
  approvedAt?: Date | null;
  filedByDeskId?: string | null;
  sellerConfirmedAt?: Date | null;
  ownershipAttestedAt?: Date | null;
  ownershipAttestedById?: string | null;
  ownershipAttestation?: string | null;
  availableConfirmedAt?: Date | null;
  availabilityRemindedAt?: Date | null;
  stalePausedAt?: Date | null;
};

// When the listing pauses if the seller stays quiet, for a reminder of the current stretch.
function pauseOn(listing: ProvenanceListing) {
  const reminded = remindedSince(listing);
  return reminded ? new Date(reminded.getTime() + PAUSE_AFTER_DAYS * DAY) : null;
}

// On the seller's, broker's or buyer-seller's own listing page. `from` names the page, so the answer lands back on it.
export function AvailabilityPanel({ listing, viewerId, from }: { listing: ProvenanceListing & { seller?: { role: string } | null }; viewerId: string; from: "seller" | "broker" | "resale" }) {
  const owner = listing.sellerId === viewerId || (Boolean(listing.brokerId) && listing.brokerId === viewerId);
  const kind = statementKind(listing);
  const hidden = (
    <>
      <input type="hidden" name="listingId" value={listing.id} />
      <input type="hidden" name="from" value={from} />
    </>
  );

  if (IN_REVIEW.includes(listing.status)) {
    // The desk's own paper isn't asked.
    if (listing.seller?.role === "ADMIN") return null;
    if (listing.ownershipAttestedAt) {
      return <p id="availability" className="mt-4 scroll-mt-6 text-sm text-muted-foreground">Ownership statement given {prettyDate(listing.ownershipAttestedAt)}.</p>;
    }
    // A tape the desk filed takes the statement with the seller's confirmation, above.
    if (listing.filedByDeskId && !listing.sellerConfirmedAt) return null;
    return (
      <section id="availability" aria-labelledby="availability-heading" className="mt-6 scroll-mt-6 border border-warn/40 bg-warn/10 p-5 rounded-xl">
        <h2 id="availability-heading" className="eyebrow">Ownership statement</h2>
        <p className="mt-2 max-w-2xl text-sm text-foreground">
          {/* A listing approved before the statement was asked isn't held for it (lib/provenance.ts provenanceHold). */}
          {listing.approvedAt ? "The desk now asks for this statement on every listing. Give it here or with your next edit." : "The desk needs this statement before it can approve the listing."}
        </p>
        {owner ? (
          <form action={giveOwnershipStatement} className="mt-4 space-y-4">
            {hidden}
            <OwnershipStatement kind={kind} />
            <SubmitButton className="h-10 text-[13px] font-medium" pendingLabel="Sending…">Give the statement</SubmitButton>
          </form>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">Waiting for the seller of record to give it.</p>
        )}
      </section>
    );
  }

  if (listing.status !== "APPROVED") return null;
  const paused = stalePaused(listing);
  const due = pauseOn(listing);
  const since = availableSince(listing);
  // A listing filed before the statement was asked gives it with its next confirmation. The desk's own paper isn't asked.
  const takesStatement = !listing.ownershipAttestedAt && listing.seller?.role !== "ADMIN";
  const form = owner ? (
    <form action={confirmAvailable} className="mt-4 space-y-4">
      {hidden}
      {takesStatement && <OwnershipStatement kind={kind} />}
      <SubmitButton className="h-10 text-[13px] font-medium" pendingLabel="Confirming…">{paused ? "Still available, put it back" : "Still available"}</SubmitButton>
    </form>
  ) : null;

  if (paused || due) {
    return (
      <section id="availability" aria-labelledby="availability-heading" role="status" className="mt-6 scroll-mt-6 border border-warn/40 bg-warn/10 p-5 rounded-xl">
        <h2 id="availability-heading" className="eyebrow">{paused ? `Paused ${prettyDate(listing.stalePausedAt)}` : "Still for sale?"}</h2>
        <p className="mt-2 max-w-2xl text-sm text-foreground">
          {paused
            ? "Buyers don't see this listing and it takes no new bids, because the desk didn't hear that the loans are still available. Bids already in stay open. Confirm below to put it back on the book."
            : `Confirm by ${prettyDate(due)} that these loans are still yours to sell, and not sold, pledged or under contract anywhere else. Otherwise the listing pauses: buyers stop seeing it and it takes no new bids.`}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">If they are no longer for sale, withdraw the listing instead.</p>
        {form}
      </section>
    );
  }

  return (
    <section id="availability" aria-labelledby="availability-heading" className="mt-6 scroll-mt-6 border border-border p-5 rounded-xl">
      <h2 id="availability-heading" className="eyebrow">Confirmed available {prettyDate(since)}</h2>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Buyers see this date. The desk asks you to confirm again {REMIND_AFTER_DAYS} days after it, and pauses the listing if it doesn&apos;t hear within {PAUSE_AFTER_DAYS} days of asking. You can confirm at any time.
      </p>
      {form}
    </section>
  );
}

// On the desk's review page: the statement on file, and how fresh the listing is. Sales can confirm for the seller,
// with a note saying how it heard.
export async function ProvenanceDesk({ listing, viewer }: { listing: ProvenanceListing & { seller: { role: string } }; viewer: Staff }) {
  const by = listing.ownershipAttestedById ? await prisma.user.findUnique({ where: { id: listing.ownershipAttestedById }, select: { name: true } }) : null;
  const words = listing.ownershipAttestedAt ? statementText(statementKind(listing), listing.ownershipAttestation) : null;
  const hold = provenanceHold(listing);
  const statement = listing.ownershipAttestedAt
    ? `given ${prettyDate(listing.ownershipAttestedAt)}${by ? ` by ${by.name}` : ""} · wording ${listing.ownershipAttestation || "unknown"}`
    : listing.seller.role === "ADMIN"
      ? "not asked. The desk lists its own paper."
      : hold
        ? "not given · approval waits on it"
        : "not given. The listing was approved before the statement was asked, so the seller gives it at their next edit or confirmation.";
  const live = listing.status === "APPROVED";
  const paused = stalePaused(listing);
  const due = pauseOn(listing);
  const since = availableSince(listing);
  return (
    <div id="availability" className="scroll-mt-6">
      <p className={`mt-1 text-sm ${hold ? "text-warn" : "text-foreground"}`}>Ownership statement: {statement}</p>
      {words && (
        <details className="mt-1 max-w-2xl text-sm text-muted-foreground">
          <summary className="cursor-pointer text-[13px] font-medium text-link">The words they agreed to</summary>
          <p className="mt-1">{words}</p>
        </details>
      )}
      {live && (
        <p className={`mt-1 text-sm ${paused || due ? "text-warn" : "text-foreground"}`}>
          {paused
            ? `Paused ${prettyDate(listing.stalePausedAt)}: the seller didn't confirm within ${PAUSE_AFTER_DAYS} days of the reminder. Off the book and taking no new bids. Bids already in stay open.`
            : due
              ? `Confirmed available ${prettyDate(since)} · reminder sent ${prettyDate(listing.availabilityRemindedAt)}, pauses ${prettyDate(due)} unless the seller confirms.`
              : `Confirmed available ${prettyDate(since)} · the seller is asked again after ${REMIND_AFTER_DAYS} days.`}
        </p>
      )}
      {live && deskCan(viewer, "sales") && listing.seller.role !== "ADMIN" && (
        <form action={confirmAvailable} className="mt-2 flex flex-wrap items-end gap-2">
          <input type="hidden" name="listingId" value={listing.id} />
          <input type="hidden" name="from" value="desk" />
          <label className="block min-w-56 flex-1">
            <span className="text-[13px] text-muted-foreground">Confirm for the seller</span>
            <input name="note" required minLength={3} maxLength={300} className="desk-input mt-1" placeholder="How the seller confirmed, such as their email of Nov 14" />
          </label>
          <SubmitButton variant="outline" className="h-10 text-[13px] font-medium" pendingLabel="Confirming…">{paused ? "Confirm and unpause" : "Confirm available"}</SubmitButton>
        </form>
      )}
    </div>
  );
}

// On the buyer's listing page, under the summary.
export function AvailabilityLine({ listing }: { listing: ProvenanceListing }) {
  const line = availabilityLine(listing);
  if (!line) return null;
  return line.paused ? (
    <p role="status" className="mt-3 max-w-3xl border border-warn/40 bg-warn/10 px-3 py-2 text-sm leading-relaxed text-foreground rounded-lg tabular-nums">{line.text}</p>
  ) : (
    <p className="mt-2 text-[13px] text-muted-foreground tabular-nums">{line.text}</p>
  );
}

// On a row of the desk's queue.
export function PausedTag({ listing }: { listing: ProvenanceListing }) {
  if (!stalePaused(listing)) return null;
  return <span className="inline-flex items-center rounded-full bg-warn/12 px-2 py-0.5 text-xs font-semibold text-warn">Paused, not reconfirmed</span>;
}
