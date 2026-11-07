import Link from "next/link";
import { awardBackupBid } from "@/actions/backups";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { backupsFor } from "@/lib/backup-bids";
import { deskCan, type Staff } from "@/lib/desk-roles";
import { money, prettyDate } from "@/lib/format";

// The bids standing behind this closing's winner, for the desk. Once the closing is canceled, the desk awards one
// from here, through the usual award and its checks.
export async function BackupPanel({ closing, viewer }: { closing: { id: string; listingId: string; noteId: string | null; noteIds: string[]; status: string }; viewer: Staff }) {
  const backups = await backupsFor(closing);
  if (!backups.standing.length && !backups.waiting.length && !backups.awardedTo) return null;
  const canAward = closing.status === "CANCELED" && !backups.awardedTo && deskCan(viewer, "sales");
  return (
    <section id="backups" aria-labelledby="backups-heading" className="glass scroll-mt-6 p-6">
      <p id="backups-heading" className="eyebrow">Backup bids</p>
      <p className="mt-2 text-sm text-muted-foreground">
        {closing.status === "OPEN"
          ? "These bids stand behind this deal. If it fails, the desk can award one from here."
          : closing.status === "CANCELED"
            ? "This deal failed. A backup can be awarded without a new round."
            : "These bids stood behind this deal."}
      </p>
      {backups.awardedTo && (
        <p className="mt-3 text-sm text-foreground">
          These loans are in contract again. <Link href={`/closings/${backups.awardedTo}`} className="text-link">Open closing</Link>
        </p>
      )}
      {backups.standing.length > 0 && (
        <ul className="mt-4 divide-y divide-border">
          {backups.standing.map((bid) => (
            <li key={bid.id} className="space-y-2 py-3">
              <div className="flex flex-wrap justify-between gap-2 text-sm">
                <span className="text-foreground">{bid.buyer}</span>
                <span className="text-foreground">{money(bid.price)}</span>
              </div>
              <p className="text-xs text-muted-foreground">Standing until {prettyDate(bid.until)}</p>
              {canAward && (
                <form action={awardBackupBid}>
                  <input type="hidden" name="closingId" value={closing.id} />
                  <input type="hidden" name="inquiryId" value={bid.id} />
                  <ConfirmSubmit
                    title={`Award ${bid.buyer}'s backup bid of ${money(bid.price)}?`}
                    consequence="This is the usual award. The buyer's account, strikes, entity, sanctions check and good-until date are checked again. If the seller's approval or reserve doesn't cover the price, the seller is asked first. Otherwise a new closing opens."
                    confirmLabel="Award the backup"
                    pendingLabel="Awarding…"
                    className="h-9 text-[13px] font-medium"
                  >
                    Award the backup
                  </ConfirmSubmit>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {backups.waiting.length > 0 && (
        <ul className="mt-3 space-y-1">
          {backups.waiting.map((bid) => (
            <li key={bid.id} className="text-xs text-muted-foreground">
              {bid.buyer} at {money(bid.price)} · asked {prettyDate(bid.askedAt)}, no answer yet
            </li>
          ))}
        </ul>
      )}
      {closing.status === "CANCELED" && !backups.awardedTo && !deskCan(viewer, "sales") && backups.standing.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">A desk member who runs sales awards a backup.</p>
      )}
    </section>
  );
}
