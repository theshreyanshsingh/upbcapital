import Link from "next/link";
import { answerBackupAsk } from "@/actions/backups";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/submit-button";
import { backupAsksFor } from "@/lib/backup-bids";
import { money, prettyDate } from "@/lib/format";

// On the buyer's inquiries page: bids the desk asked to stand as backup after another bid won, and those standing.
export async function BackupAsks({ userId }: { userId: string }) {
  const rows = await backupAsksFor(userId);
  if (!rows.length) return null;
  return (
    <section id="backup" aria-labelledby="backup-heading" className="mt-8 scroll-mt-6 border border-border p-5 rounded-xl">
      <p id="backup-heading" className="eyebrow">Backup bids</p>
      <p className="mt-2 text-sm text-muted-foreground">
        Another bid won these listings. If the winning closing doesn&apos;t complete, the desk can award a backup bid without a new round.
      </p>
      <ul className="mt-3 space-y-2">
        {rows.map((row) => (
          <li key={row.id} className={`flex flex-wrap items-center justify-between gap-3 p-4 rounded-xl ${row.state === "asked" ? "border border-link/30 bg-link/5" : "border border-border"}`}>
            <div className="min-w-0">
              <Link href={`/marketplace/${row.listingId}`} className="text-sm text-foreground">{row.title}</Link>
              <p className="text-xs text-muted-foreground">
                {row.state === "asked"
                  ? `Your bid of ${money(row.price)}. Stand as backup until ${prettyDate(row.until)}? Answer by ${prettyDate(row.answerBy)}, or the bid closes.`
                  : `Standing as backup at ${money(row.price)} until ${prettyDate(row.until)}.`}
              </p>
            </div>
            {row.state === "asked" && (
              <div className="flex flex-wrap gap-2">
                <form action={answerBackupAsk}>
                  <input type="hidden" name="inquiryId" value={row.id} />
                  <input type="hidden" name="answer" value="ACCEPT" />
                  <ConfirmSubmit
                    title={`Stand as backup at ${money(row.price)}?`}
                    consequence={`Your bid stays live and good until ${prettyDate(row.until)}. If the winning closing fails, the desk can award it to you at this price without a new round. If it doesn't, the bid closes then.`}
                    confirmLabel="Stand as backup"
                    pendingLabel="Saving…"
                    className="h-9 text-[13px] font-medium"
                  >
                    Stand as backup
                  </ConfirmSubmit>
                </form>
                <form action={answerBackupAsk}>
                  <input type="hidden" name="inquiryId" value={row.id} />
                  <input type="hidden" name="answer" value="DECLINE" />
                  <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Closing…">No, close my bid</SubmitButton>
                </form>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
