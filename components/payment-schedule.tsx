import {
  noteSchedule,
  paymentForecast,
  SCHEDULE_CAVEAT,
  scheduleByYear,
  type DownloadLoan,
  type Forecast,
  type ForecastHolding,
  type ScheduleRow,
} from "@/lib/amortization";
import { groupBy, readIn } from "@/lib/bulk-read";
import { closingLoans } from "@/lib/closing";
import { money, prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";

// The remaining payments on a listing's loan (lib/amortization.ts), for viewers who see the listing's figures. A pool
// shows one loan at a time, picked from the loans still for sale; the CSV carries the full monthly schedule.

const NEXT = 12;
const cell = "whitespace-nowrap px-2 py-2 sm:px-3";

export function PaymentSchedule({
  listingId,
  notes,
  forSale,
  selected,
  now = new Date(),
}: {
  listingId: string;
  // Every loan on the listing in the page's order, so "Loan 3" here is "Loan 3" in the download and the tape.
  notes: DownloadLoan[];
  // The loans the pool still offers. A single note's one loan.
  forSale: string[];
  selected: string | null;
  now?: Date;
}) {
  const offered = notes.filter((note) => forSale.includes(note.id));
  const choices = offered.length ? offered : notes;
  if (!choices.length) return null;
  const pool = notes.length > 1;
  const chosen = choices.find((note) => note.id === selected) ?? choices.find((note) => note.paymentStatus !== "NON_PERFORMING") ?? choices[0];
  const position = notes.findIndex((note) => note.id === chosen.id) + 1;
  const schedule = noteSchedule(chosen, { now });
  const label = (note: DownloadLoan) => `Loan ${notes.indexOf(note) + 1} · ${note.city}, ${note.state}`;
  return (
    <section id="payment-schedule" aria-labelledby="payment-schedule-heading" className="mt-8 scroll-mt-6 glass p-5 sm:p-6">
      <h2 id="payment-schedule-heading" className="eyebrow">Payment schedule</h2>
      {pool && (
        <form method="get" action={`/marketplace/${listingId}#payment-schedule`} className="mt-3 flex flex-wrap items-end gap-2">
          <input type="hidden" name="tab" value="analysis" />
          <label className="block w-full min-w-0 sm:w-auto sm:flex-1">
            <span className="text-[13px] text-muted-foreground">A pool shows one loan at a time</span>
            <select name="schedule" defaultValue={chosen.id} className="desk-input mt-2 w-full">
              {choices.map((note) => <option key={note.id} value={note.id}>{label(note)}</option>)}
            </select>
          </label>
          <button type="submit" className="inline-flex h-11 w-full items-center justify-center rounded-lg border border-border px-4 text-[13px] font-medium text-foreground sm:w-auto">Show schedule</button>
        </form>
      )}
      {pool && <p className="mt-3 text-[13px] font-medium text-foreground">{label(chosen)}</p>}
      {!schedule.ok ? (
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{schedule.reason}</p>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-4 tabular-nums sm:grid-cols-4">
            {([
              ["Payments left", String(schedule.totals.payments)],
              ["Total interest", money(schedule.totals.interest)],
              ["Total principal", money(schedule.totals.principal)],
              schedule.balloon
                ? ["Balloon", `${money(schedule.balloon.amount)} · ${prettyDate(schedule.balloon.date)}`]
                : schedule.totals.payoffDate
                  ? ["Last payment", prettyDate(schedule.totals.payoffDate)]
                  : ["Owed after the last shown", money(schedule.totals.balanceLeft)],
            ] as [string, string][]).map(([term, value]) => (
              <div key={term} className="min-w-0">
                <dt className="text-[13px] text-muted-foreground">{term}</dt>
                <dd className="mt-1 break-words text-lg font-semibold tracking-tight text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
          <ul className="mt-3 space-y-1 text-xs leading-relaxed text-muted-foreground">
            {schedule.lines.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <Rows
            caption={
              schedule.rows.length && schedule.rows[0].date.getTime() < Date.now()
                ? `The first ${Math.min(NEXT, schedule.rows.length)} payments on the schedule, from ${prettyDate(schedule.rows[0].date)}`
                : `The next ${Math.min(NEXT, schedule.rows.length)} payments`
            }
            rows={schedule.rows.slice(0, NEXT)}
          />
          <Years rows={schedule.rows} />
          <a href={`/api/listings/${listingId}/schedule?loan=${chosen.id}`} className="mt-4 inline-flex min-h-10 items-center text-[13px] font-medium text-link">
            Download the full monthly schedule (CSV){pool ? <span className="sr-only"> for loan {position}</span> : null}
          </a>
        </>
      )}
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{SCHEDULE_CAVEAT}</p>
    </section>
  );
}

function Rows({ caption, rows }: { caption: string; rows: ScheduleRow[] }) {
  return (
    <div className="mt-4 relative overflow-x-auto">
      <table className="min-w-full text-left text-sm tabular-nums">
        <caption className="pb-2 text-left text-[13px] font-medium text-foreground">{caption}</caption>
        <thead className="text-xs font-medium text-muted-foreground">
          <tr>
            <th scope="col" className={`${cell} font-normal`}>Date</th>
            <th scope="col" className={`${cell} text-right font-normal`}>Payment</th>
            <th scope="col" className={`${cell} text-right font-normal`}>Interest</th>
            <th scope="col" className={`${cell} text-right font-normal`}>Principal</th>
            <th scope="col" className={`${cell} text-right font-normal`}>Balance after</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.number} className="border-t border-border">
              <td className={`${cell} text-foreground`}>{prettyDate(row.date)}</td>
              <td className={`${cell} text-right`}>{money(row.payment, 2)}</td>
              <td className={`${cell} text-right`}>{money(row.interest, 2)}</td>
              <td className={`${cell} text-right`}>{money(row.principal, 2)}</td>
              <td className={`${cell} text-right`}>{money(row.balance, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The rest of the schedule by calendar year, folded away: a thirty-year loan has thirty rows.
function Years({ rows }: { rows: ScheduleRow[] }) {
  const years = scheduleByYear(rows);
  if (!years.length) return null;
  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-[13px] font-medium text-foreground">
        Year by year, {years[0].year}{years.length > 1 ? ` to ${years[years.length - 1].year}` : ""}
      </summary>
      <div className="mt-2 relative overflow-x-auto">
        <table className="min-w-full text-left text-sm tabular-nums">
          <caption className="sr-only">Interest, principal and the balance at each year end</caption>
          <thead className="text-xs font-medium text-muted-foreground">
            <tr>
              <th scope="col" className={`${cell} font-normal`}>Year</th>
              <th scope="col" className={`${cell} text-right font-normal`}>Interest</th>
              <th scope="col" className={`${cell} text-right font-normal`}>Principal</th>
              <th scope="col" className={`${cell} text-right font-normal`}>Balance at year end</th>
            </tr>
          </thead>
          <tbody>
            {years.map((year) => (
              <tr key={year.year} className="border-t border-border">
                <td className={`${cell} text-foreground`}>{year.year}</td>
                <td className={`${cell} text-right`}>{money(year.interest)}</td>
                <td className={`${cell} text-right`}>{money(year.principal)}</td>
                <td className={`${cell} text-right`}>{money(year.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The portfolio's next twelve months.

type HeldNote = { id: string; status: string; sharePercent: number | null; proceeds: unknown[] };

const NOTE_PICK = ["id", "listingId", "upb", "interestRate", "monthlyPi", "maturityDate", "nextDueDate", "lastPaidDate", "balloonDate", "paymentType", "paymentStatus"] as const;

// Each holding's loans as the forecast reads them. A sold or resolved note is inactive and reads nothing. A closing's
// own loans when it names them (lib/closing.ts closingLoans), else every loan on the listing, as lib/portfolio.ts
// reads them for accretion. A note added by hand has no listing, so no loans.
export async function forecastHoldings(userId: string, holdings: HeldNote[]): Promise<ForecastHolding[]> {
  const active = (holding: HeldNote) => holding.status !== "RESOLVED" && holding.proceeds.length === 0;
  const live = holdings.filter(active);
  const links = live.length ? await prisma.buyerHolding.findMany({ where: { userId }, select: { id: true, listingId: true, closingId: true } }) : [];
  const linkOf = new Map(links.map((row) => [row.id, row]));
  const listingIds = live.map((holding) => linkOf.get(holding.id)?.listingId).filter((id): id is string => Boolean(id));
  const closingIds = live.map((holding) => linkOf.get(holding.id)?.closingId).filter((id): id is string => Boolean(id));
  const [notes, closings] = await Promise.all([
    readIn("Note", "listingId", listingIds, { pick: NOTE_PICK }),
    readIn("Closing", "id", closingIds, { pick: ["id", "noteId", "noteIds"] as const }),
  ]);
  const byListing = groupBy(notes, "listingId");
  const closingOf = new Map(closings.map((closing) => [closing.id, closing]));
  return holdings.map((holding) => {
    if (!active(holding)) return { id: holding.id, active: false, share: 0, loans: [] };
    const link = linkOf.get(holding.id);
    const onListing = link?.listingId ? byListing.get(link.listingId) ?? [] : [];
    const closing = link?.closingId ? closingOf.get(link.closingId) : null;
    const loans = closing ? closingLoans({ noteId: closing.noteId, noteIds: closing.noteIds ?? [] }, onListing) : onListing;
    return {
      id: holding.id,
      active: true,
      share: (holding.sharePercent ?? 100) / 100,
      loans: loans.map((note) => ({
        upb: Number(note.upb),
        interestRate: note.interestRate == null ? null : Number(note.interestRate),
        monthlyPi: note.monthlyPi == null ? null : Number(note.monthlyPi),
        maturityDate: note.maturityDate,
        nextDueDate: note.nextDueDate,
        lastPaidDate: note.lastPaidDate,
        balloonDate: note.balloonDate,
        paymentType: note.paymentType,
        paymentStatus: note.paymentStatus,
      })),
    };
  });
}

const monthName = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

// Why some of the book isn't in the sums, in a line. Null when everything held is.
export function leftOutLine(forecast: Pick<Forecast, "leftOut" | "nonPerforming" | "loansLeftOut">) {
  const parts: string[] = [];
  if (forecast.leftOut) parts.push(`${plural(forecast.leftOut, "holding")} without the loan terms a schedule needs: a note added by hand has none on file, and a loan can lack its rate, P&I or maturity`);
  if (forecast.nonPerforming) parts.push(`${plural(forecast.nonPerforming, "holding")} non-performing on the tape`);
  if (forecast.loansLeftOut) parts.push(`${plural(forecast.loansLeftOut, "loan")} inside a pool you hold, for the same reasons`);
  return parts.length ? `Left out: ${parts.join("; ")}.` : null;
}

export async function ExpectedPayments({ userId, holdings, now = new Date() }: { userId: string; holdings: HeldNote[]; now?: Date }) {
  const forecast = paymentForecast(await forecastHoldings(userId, holdings), now);
  if (!forecast.included && !forecast.leftOut && !forecast.nonPerforming) return null;
  const first = forecast.months[0];
  const last = forecast.months[forecast.months.length - 1];
  const leftOut = leftOutLine(forecast);
  return (
    <section aria-labelledby="forecast-heading" className="mt-6 border border-border p-5 rounded-xl">
      <h2 id="forecast-heading" className="eyebrow">Expected payments, next 12 months</h2>
      {forecast.included ? (
        <>
          <p className="mt-3 text-lg font-semibold tracking-tight tabular-nums text-foreground">{money(forecast.total)}</p>
          <p className="text-[13px] text-muted-foreground">
            Scheduled P&amp;I from {monthName.format(first.start)} to {monthName.format(last.start)} on {plural(forecast.included, "holding")}, at your share, from each loan&apos;s balance, rate, payment and maturity on the tape.
            {forecast.inactive ? " Notes sold or resolved aren't counted." : ""}
          </p>
          <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] tabular-nums sm:grid-cols-3 lg:grid-cols-4">
            {forecast.months.map((month) => (
              <li key={month.start.toISOString()} className="flex min-w-0 justify-between gap-3 border-b border-border pb-1">
                <span className="text-muted-foreground">{monthName.format(month.start)}</span>
                <span className="text-foreground">{money(month.amount)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">None of the notes you hold has the loan terms a schedule needs.</p>
      )}
      {leftOut && <p className="mt-3 text-[13px] text-muted-foreground">{leftOut}</p>}
      <p className="mt-2 text-xs text-muted-foreground">{SCHEDULE_CAVEAT}</p>
    </section>
  );
}
