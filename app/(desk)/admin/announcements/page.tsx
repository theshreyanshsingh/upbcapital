import Link from "next/link";
import { sendDealAnnouncement } from "@/actions/announcements";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { announcementHistory, cardLine, MAX_ANNOUNCE_LISTINGS, newAnnouncementId, recipientCount } from "@/lib/announcements";
import { requireRole } from "@/lib/auth";
import { prettyDate, q } from "@/lib/format";
import { liveCards } from "@/lib/public-index";
import { deskCan } from "@/lib/staff";

export const metadata = { title: "Deal announcements" };

function rate(part: number, whole: number) {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

export default async function AnnouncementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Every desk role reads the history. Sending is sales work, and the action checks the same.
  const sells = deskCan(await requireRole(["ADMIN"]), "sales");
  const params = await searchParams;
  const [count, cards, history] = await Promise.all([recipientCount(), liveCards(null), announcementHistory()]);
  const readers = `${count.total} reader${count.total === 1 ? "" : "s"}`;
  return (
    <div>
      <PageIntro
        eyebrow="Growth"
        title="Deal announcements."
        lede="Send live public listings to everyone on the list: members who turned it on, and confirmed subscribers from the public sign-up. Private and coming-soon listings never show here."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <section className="glass mt-6 p-6">
        <p className="eyebrow">The list</p>
        <p className="mt-2 font-semibold tracking-tight text-3xl text-foreground">{readers}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {count.members} member{count.members === 1 ? "" : "s"} and {count.subscribers} subscriber{count.subscribers === 1 ? "" : "s"}. The public sign-up is at{" "}
          <Link href="/announcements" className="text-link">Deal announcements</Link>.
        </p>
      </section>

      {sells ? (
        <form action={sendDealAnnouncement} className="glass mt-6 space-y-5 p-6">
          <input type="hidden" name="draftId" value={newAnnouncementId()} />
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Subject</span>
            <input name="subject" required minLength={4} maxLength={140} className="desk-input mt-2" />
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Note above the listings</span>
            <textarea name="body" required maxLength={5000} className="desk-input mt-2 min-h-28" />
            <span className="mt-1 block text-xs text-muted-foreground">Plain text. Leave a blank line between paragraphs. Each listing follows with a link to its public page.</span>
          </label>
          <fieldset>
            <legend className="text-[13px] text-muted-foreground">Listings, up to {MAX_ANNOUNCE_LISTINGS}</legend>
            {cards.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No live public listing to announce.</p>
            ) : (
              <ul className="mt-2 max-h-80 divide-y divide-border overflow-y-auto rounded-xl border border-border">
                {cards.map((card) => (
                  <li key={card.id}>
                    <label className="flex items-start gap-3 px-4 py-3 text-sm text-foreground">
                      <input type="checkbox" name="listingIds" value={card.id} className="mt-1" />
                      <span>{cardLine(card)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
          <label className="flex items-center gap-3 text-sm text-foreground">
            <input type="checkbox" name="linkEvents" value="on" />
            Add a link to sale events
          </label>
          <ConfirmSubmit
            title={`Send to ${readers}?`}
            consequence={`The announcement goes out now to ${readers}. It can't be called back.`}
            confirmLabel="Send"
            pendingLabel="Sending…"
            className="h-11 text-[13px] font-medium"
          >
            Send to {readers}
          </ConfirmSubmit>
        </form>
      ) : (
        <p className="mt-6 text-sm text-muted-foreground">Sending announcements is sales work.</p>
      )}

      <section className="mt-10">
        <p className="eyebrow">Sent</p>
        <div className="mt-3 overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Announcement</th>
                <th className="px-4 py-3 text-right font-medium">Sent</th>
                <th className="px-4 py-3 text-right font-medium">Failed</th>
                <th className="px-4 py-3 text-right font-medium">Unique opens</th>
                <th className="px-4 py-3 text-right font-medium">Unique clicks</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {history.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-muted-foreground">Nothing sent yet.</td>
                </tr>
              )}
              {history.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <p className="text-foreground">{row.subject}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {prettyDate(row.sentAt)} · {row.sender} · {row.listingIds.length} listing{row.listingIds.length === 1 ? "" : "s"}
                    </p>
                  </td>
                  <td className="figure px-4 py-3 text-right tabular-nums">{row.recipients}</td>
                  <td className={`figure px-4 py-3 text-right tabular-nums ${row.failed ? "text-bad" : "text-muted-foreground"}`}>{row.failed}</td>
                  <td className="figure px-4 py-3 text-right tabular-nums">{row.opens} <span className="text-muted-foreground">· {rate(row.opens, row.recipients)}</span></td>
                  <td className="figure px-4 py-3 text-right tabular-nums">{row.clicks} <span className="text-muted-foreground">· {rate(row.clicks, row.recipients)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Sent counts only the emails that went out. Failed ones are in the server log. Opens count readers whose mail app loaded the images, so the real figure is higher. Each reader counts once.
        </p>
      </section>
    </div>
  );
}
