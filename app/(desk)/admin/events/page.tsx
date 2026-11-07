import Link from "next/link";
import { createSaleEvent } from "@/actions/sale-events";
import { EventCalendarFields } from "@/components/event-calendar-fields";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import {
  advanceSaleEvents,
  EVENT_STATUS_LABEL,
  FINAL_DEFAULT_DAYS,
  FINAL_MAX_DAYS,
  FINAL_MIN_DAYS,
  FINAL_USUAL_DAYS,
  inputValue,
  roundText,
  when,
} from "@/lib/sale-events";
import { deskCan } from "@/lib/staff";

export const metadata = { title: "Sale events" };

const DAY = 24 * 60 * 60 * 1000;

export default async function AdminEventsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Every desk role reads the calendar. Creating an event is sales work, and the action checks the same.
  const sells = deskCan(await requireRole(["ADMIN"]), "sales");
  const params = await searchParams;
  // A round whose date passed moves before the page shows it. A failure here leaves it for the daily job.
  await advanceSaleEvents().catch(() => null);
  const events = await prisma.saleEvent.findMany({ orderBy: { indicationsAt: "desc" }, take: 60 });
  const members = events.length
    ? await prisma.listing.findMany({ where: { saleEventId: { in: events.map((event) => event.id) } }, select: { saleEventId: true, sellerId: true } })
    : [];
  const open = events.filter((event) => ["PLANNED", "INDICATIONS", "BEST_AND_FINAL"].includes(event.status));
  const past = events.filter((event) => !open.includes(event));
  // A suggested calendar: indications two weeks out at 17:00 UTC, best and final at the short end of the usual gap.
  const start = new Date(Date.now() + 14 * DAY);
  start.setUTCHours(17, 0, 0, 0);
  const finish = new Date(start.getTime() + FINAL_DEFAULT_DAYS * DAY);

  const row = (event: (typeof events)[number]) => {
    const listed = members.filter((member) => member.saleEventId === event.id);
    const sellers = new Set(listed.map((member) => member.sellerId)).size;
    return (
      <li key={event.id} className="grid gap-2 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">{EVENT_STATUS_LABEL[event.status] ?? event.status}</p>
          <Link href={`/admin/events/${event.id}`} className="mt-1 block font-semibold tracking-tight text-lg text-foreground hover:text-link">{event.name}</Link>
          <p className="mt-1 text-sm text-muted-foreground tabular-nums">
            Indications {when(event.indicationsAt)} · Best and final {when(event.bestFinalAt)}
          </p>
          <p className="mt-1 text-sm text-foreground">{roundText(event)}</p>
        </div>
        <p className="text-sm text-muted-foreground tabular-nums md:text-right">
          {listed.length} listing{listed.length === 1 ? "" : "s"} · {sellers} seller{sellers === 1 ? "" : "s"}
        </p>
      </li>
    );
  };

  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0">
        <PageIntro
          eyebrow="Desk"
          title="Sale events."
          lede="Several sellers' listings trade on the same two dates: sealed indications, then one best-and-final bid each. Buyers can plan around the dates."
        />
        <Notice notice={q(params, "notice")} error={q(params, "error")} />
        <section aria-labelledby="open-events" className="mt-6">
          <h2 id="open-events" className="eyebrow">Upcoming and live</h2>
          <ul className="mt-3 divide-y divide-border border border-border rounded-xl">
            {open.length === 0 && <li className="px-5 py-8 text-sm text-muted-foreground">No events on the calendar.{sells ? " Create one to set its dates." : ""}</li>}
            {open.map(row)}
          </ul>
        </section>
        {past.length > 0 && (
          <section aria-labelledby="past-events" className="mt-8">
            <h2 id="past-events" className="eyebrow">Closed and canceled</h2>
            <ul className="mt-3 divide-y divide-border border border-border rounded-xl">{past.map(row)}</ul>
          </section>
        )}
      </div>

      <aside>
        {!sells && <p className="text-sm text-muted-foreground">Sale events are run by the sales side of the desk.</p>}
        {sells && <form action={createSaleEvent} className="space-y-4 border border-border p-5 rounded-xl">
          <h2 className="eyebrow">New event</h2>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Name</span>
            <input name="name" required minLength={3} maxLength={120} className="desk-input mt-2" placeholder="December NPL sale" />
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Summary for buyers</span>
            <textarea name="summary" maxLength={1000} className="desk-input mt-2 min-h-24" />
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Indications due (UTC)</span>
            <input name="indicationsAt" type="datetime-local" required defaultValue={inputValue(start)} className="desk-input mt-2" />
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Best and final due (UTC)</span>
            <input name="bestFinalAt" type="datetime-local" defaultValue={inputValue(finish)} className="desk-input mt-2" aria-describedby="final-hint" />
          </label>
          <p id="final-hint" className="text-xs leading-relaxed text-muted-foreground">
            {FINAL_MIN_DAYS} to {FINAL_MAX_DAYS} days after indications. {FINAL_USUAL_DAYS[0]} to {FINAL_USUAL_DAYS[1]} days is usual. Left blank, it is set {FINAL_DEFAULT_DAYS} days after.
          </p>
          <EventCalendarFields />
          <SubmitButton className="h-10 w-full text-[13px] font-medium" pendingLabel="Creating…">Create the event</SubmitButton>
        </form>}
      </aside>
    </div>
  );
}
