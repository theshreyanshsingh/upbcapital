import Link from "next/link";
import { lockBoardMonthAction } from "@/actions/board";
import { BoardCohorts, BoardDefinitions, BoardSection, BoardTiles } from "@/components/board-pack";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { BOARD_SECTIONS, boardView, lastWholeMonth, monthLabel, monthOf, monthOver, monthShort, monthStart, parseMonth, shiftMonth } from "@/lib/board-pack";
import { prettyDate, q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { requireDesk } from "@/lib/staff";

export const metadata = { title: "Board pack" };

export default async function BoardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // The pack carries every fee and the desk's revenue, so it is the owners' page, as fees and settings are.
  await requireDesk("admin", "/admin");
  const params = await searchParams;
  const now = new Date();
  const asked = parseMonth(q(params, "month"));
  const month = asked && monthStart(asked).getTime() <= now.getTime() ? asked : lastWholeMonth(now);
  const [view, history] = await Promise.all([
    boardView(month, now),
    prisma.auditEvent.findMany({
      where: { entityType: "board", entityId: month, action: { in: ["BOARD_LOCK", "BOARD_RELOCK"] } },
      include: { actor: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);
  const { pack, lock } = view;
  const differences = new Map(view.differences.map((row) => [row.key, row]));
  const previous = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  const hasNext = monthStart(next).getTime() <= now.getTime();
  const over = monthOver(month, now);
  return (
    <div>
      <PageIntro
        eyebrow="Board pack"
        title="The month for the board."
        lede="One calendar month from UPB's own records, against the month before and the trailing three months. Lock a month once it is over, and the board reads the same figures every time."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />

      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <form method="get" className="flex items-end gap-2">
          <label className="block">
            <span className="type-label font-medium text-foreground">Month</span>
            <input type="month" name="month" defaultValue={month} max={monthOf(now)} className="desk-input mt-1.5 w-44" required />
          </label>
          <SubmitButton variant="outline" className="h-11 text-[13px] font-medium" pendingLabel="Opening…">Show</SubmitButton>
        </form>
        <nav aria-label="Other months" className="flex gap-4 text-[13px] font-medium">
          <Link href={`/admin/board?month=${previous}`} className="text-link">← {monthShort(previous)}</Link>
          {hasNext && <Link href={`/admin/board?month=${next}`} className="text-link">{monthShort(next)} →</Link>}
        </nav>
      </div>

      <section id="lock" aria-labelledby="lock-heading" className="glass mt-6 scroll-mt-6 p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="lock-heading" className="text-lg font-semibold tracking-tight text-foreground">{monthLabel(month)}</h2>
          <p className="flex gap-4 text-[13px] font-medium">
            <a href={`/api/admin/board/${month}?format=pdf`} className="text-link">PDF</a>
            <a href={`/api/admin/board/${month}?format=csv`} className="text-link">CSV</a>
          </p>
        </div>
        {lock ? (
          <div className="mt-2 space-y-1.5 text-sm">
            <p className="text-foreground">Locked {prettyDate(lock.lockedAt)} by {lock.lockedBy}. These are the figures as locked.</p>
            {lock.note && <p className="text-muted-foreground">Note: {lock.note}</p>}
            {!lock.readable ? (
              <p className="text-warn">The locked pack is from an earlier version of this page and can&apos;t be read, so these are live figures. Lock the month again to replace it.</p>
            ) : view.differences.length ? (
              <p className="text-warn">A live recount now differs on {view.differences.length} figure{view.differences.length === 1 ? "" : "s"}. Each one shows its recount below.</p>
            ) : (
              <p className="text-muted-foreground">A live recount matches every figure.</p>
            )}
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            {over ? "Not locked. These are live figures, and they can change as records are corrected." : `${monthLabel(month)} is still running, so it counts to now. It can be locked from ${monthLabel(next)}.`}
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Prior month {pack.priorLocked ? "as locked" : "as counted now"}. Demo and test accounts are counted, as in analytics. <a href="#definitions" className="text-link">Definitions</a>
        </p>
        {over && (
          <form action={lockBoardMonthAction} className="mt-4 grid max-w-xl gap-3">
            <input type="hidden" name="month" value={month} />
            <label className="block">
              <span className="type-label font-medium text-foreground">{lock ? "Why lock it again" : "Note, optional"}</span>
              <textarea name="note" rows={2} maxLength={500} required={Boolean(lock)} minLength={lock ? 10 : undefined} className="desk-input mt-1.5" placeholder={lock ? "A late closing was recorded, so the volume changed." : "Anything the board should know about this month."} />
              <span className="mt-1.5 block type-label text-muted-foreground">{lock ? "Locking again replaces the figures above and keeps this note with them." : "Locking saves today's count. A later lock needs a note."}</span>
            </label>
            <SubmitButton className="h-11 w-fit text-[13px] font-medium" pendingLabel="Locking…">{lock ? "Lock again" : "Lock this month"}</SubmitButton>
          </form>
        )}
        {history.length > 0 && (
          <ul className="mt-5 space-y-2 border-t border-border pt-4 text-sm">
            {history.map((event) => (
              <li key={event.id}>
                <p className="text-foreground">{prettyDate(event.createdAt)} · {event.action === "BOARD_RELOCK" ? "Locked again" : "Locked"} by {event.actor?.name ?? "a removed account"}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">{event.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-8">
        <BoardTiles pack={pack} differences={differences} />
      </div>
      {BOARD_SECTIONS.map((section) => (
        <BoardSection key={section} section={section} pack={pack} differences={differences} />
      ))}
      <BoardCohorts pack={pack} differences={differences} />
      <BoardDefinitions demoAccounts={pack.demoAccounts} />
    </div>
  );
}
