import Link from "next/link";
import { removeAgencySale, saveAgencySale } from "@/actions/market";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { AGENCY_PROGRAMS, COVER_BID_HEADER, COVER_BID_NOTE, agencyLines, coverBidLabel, monthTitle, safeSourceUrl, saleLabel, type AgencySaleRow } from "@/lib/dispatch";
import { isoDate, moneyCompact, prettyDate, q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "Agency sales" };

export default async function AgencySalesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole(["ADMIN"]);
  const params = await searchParams;
  const now = new Date();
  const [rows, settings, readers] = await Promise.all([
    prisma.agencySale.findMany({ orderBy: [{ bidDate: "desc" }, { createdAt: "desc" }], take: 300 }),
    getSettings(),
    prisma.user.count({ where: { marketDispatch: true, accountStatus: "APPROVED" } }),
  ]);
  const { calendar, results } = agencyLines(rows, now);
  const shown = new Set([...calendar, ...results].map((line) => line.id));
  return (
    <div className="max-w-4xl">
      <PageIntro
        eyebrow="Market data"
        title="Agency and HUD sales."
        lede="Enter each published sale and, once it is out, its result. These rows lead the monthly dispatch. The agencies publish the cover bid, the second-highest bid, so every result here is labelled as a cover bid and never as a clearing price."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <section className="glass mt-6 p-5" aria-labelledby="dispatch-heading">
        <h2 id="dispatch-heading" className="eyebrow">The dispatch</h2>
        <p className="mt-2 text-sm text-foreground tabular-nums">
          {settings.lastDispatchMonth ? `The ${monthTitle(settings.lastDispatchMonth)} issue went out.` : "No issue has gone out yet."}{" "}
          {readers} approved account{readers === 1 ? " takes" : "s take"} it by email.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          The monthly job sends each issue once, in the first run of the month. <Link href="/market" className="text-link">See this month&apos;s issue as members do</Link>.
        </p>
      </section>

      <form id="add-sale" action={saveAgencySale} className="glass mt-8 scroll-mt-6 space-y-5 p-6" aria-labelledby="add-sale-heading">
        <div>
          <h2 id="add-sale-heading" className="eyebrow">Add a sale</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{COVER_BID_NOTE}</p>
        </div>
        <SaleFields prefix="new" />
        <SubmitButton className="h-11 text-[13px] font-medium">Add the sale</SubmitButton>
      </form>

      <section className="mt-10" aria-labelledby="sales-heading">
        <h2 id="sales-heading" className="eyebrow">On file</h2>
        {rows.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">No sales yet. Add the next agency or HUD sale above.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
            {rows.map((row) => {
              const source = safeSourceUrl(row.sourceUrl);
              return (
                <li key={row.id} className="px-4 py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <p className="font-medium text-foreground">{saleLabel(row)}</p>
                    <p className="text-[13px] text-muted-foreground tabular-nums">
                      Bids {row.bidDate ? prettyDate(row.bidDate) : "date to come"}
                      {row.settleBy ? ` · settles by ${prettyDate(row.settleBy)}` : ""}
                      {shown.has(row.id) ? "" : " · outside the dispatch window"}
                    </p>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground tabular-nums">
                    {row.loans != null ? `${row.loans.toLocaleString("en-US")} loans · ` : ""}
                    {row.upb != null ? `${moneyCompact(row.upb)} UPB · ` : ""}
                    <span className="text-foreground">{coverBidLabel(row, now)}</span>
                    {row.winner ? ` · winner, as published: ${row.winner}` : ""}
                    {source ? (
                      <>
                        {" · "}
                        <a href={source} target="_blank" rel="noopener noreferrer" className="text-link">Source</a>
                      </>
                    ) : null}
                  </p>
                  <details className="mt-3">
                    <summary className="cursor-pointer text-[13px] font-medium text-link">Edit or remove</summary>
                    <form action={saveAgencySale} className="mt-4 space-y-5">
                      <input type="hidden" name="id" value={row.id} />
                      <SaleFields prefix={row.id} sale={row} />
                      <SubmitButton variant="outline" className="h-10 text-[13px] font-medium">Save changes</SubmitButton>
                    </form>
                    <form action={removeAgencySale} className="mt-3">
                      <input type="hidden" name="id" value={row.id} />
                      <ConfirmSubmit
                        title="Remove this sale?"
                        consequence="It leaves the desk's calendar and the next dispatch. Issues already sent keep it. The audit log records the removal."
                        confirmLabel="Remove the sale"
                        pendingLabel="Removing…"
                        tone="danger"
                        variant="ghost"
                        className="h-9 text-[13px] font-medium text-bad"
                      >
                        Remove
                      </ConfirmSubmit>
                    </form>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function SaleFields({ prefix, sale }: { prefix: string; sale?: AgencySaleRow }) {
  const id = (name: string) => `${prefix}-${name}`;
  const figure = (value: number | null | undefined) => (value == null ? "" : String(value));
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="block" htmlFor={id("program")}>
        <span className="text-[13px] text-muted-foreground">Agency</span>
        <select id={id("program")} name="program" defaultValue={sale?.program ?? "FANNIE_MAE"} className="desk-input mt-2">
          {AGENCY_PROGRAMS.map((program) => (
            <option key={program.value} value={program.value}>{program.label}</option>
          ))}
        </select>
      </label>
      <label className="block" htmlFor={id("name")}>
        <span className="text-[13px] text-muted-foreground">Sale name</span>
        <input id={id("name")} name="name" required minLength={2} maxLength={120} defaultValue={sale?.name ?? ""} placeholder="29th NPL sale" className="desk-input mt-2" />
      </label>
      <label className="block" htmlFor={id("bidDate")}>
        <span className="text-[13px] text-muted-foreground">Bid date</span>
        <input id={id("bidDate")} name="bidDate" type="date" defaultValue={isoDate(sale?.bidDate ?? null) ?? ""} className="desk-input mt-2 tabular-nums" />
      </label>
      <label className="block" htmlFor={id("settleBy")}>
        <span className="text-[13px] text-muted-foreground">Settles by (optional)</span>
        <input id={id("settleBy")} name="settleBy" type="date" defaultValue={isoDate(sale?.settleBy ?? null) ?? ""} className="desk-input mt-2 tabular-nums" />
      </label>
      <label className="block" htmlFor={id("loans")}>
        <span className="text-[13px] text-muted-foreground">Loans</span>
        <input id={id("loans")} name="loans" inputMode="numeric" defaultValue={figure(sale?.loans)} placeholder="1,179" className="desk-input mt-2 tabular-nums" />
      </label>
      <label className="block" htmlFor={id("upb")}>
        <span className="text-[13px] text-muted-foreground">UPB (USD)</span>
        <input id={id("upb")} name="upb" inputMode="decimal" defaultValue={figure(sale?.upb)} placeholder="252.4M" className="desk-input mt-2 tabular-nums" />
      </label>
      <fieldset className="grid gap-4 sm:col-span-2 sm:grid-cols-3">
        <legend className="text-[13px] font-medium text-foreground">{COVER_BID_HEADER}, once published</legend>
        <label className="block" htmlFor={id("coverPctUpb")}>
          <span className="text-[13px] text-muted-foreground">Cover bid, % of UPB</span>
          <input id={id("coverPctUpb")} name="coverPctUpb" inputMode="decimal" defaultValue={figure(sale?.coverPctUpb)} placeholder="97.08" className="desk-input mt-2 tabular-nums" />
        </label>
        <label className="block" htmlFor={id("coverPctBpo")}>
          <span className="text-[13px] text-muted-foreground">Cover bid, % of BPO</span>
          <input id={id("coverPctBpo")} name="coverPctBpo" inputMode="decimal" defaultValue={figure(sale?.coverPctBpo)} placeholder="48.44" className="desk-input mt-2 tabular-nums" />
        </label>
        <label className="block" htmlFor={id("bpoLtv")}>
          <span className="text-[13px] text-muted-foreground">BPO LTV (%)</span>
          <input id={id("bpoLtv")} name="bpoLtv" inputMode="decimal" defaultValue={figure(sale?.bpoLtv)} placeholder="50" className="desk-input mt-2 tabular-nums" />
        </label>
        <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-3">
          Enter the figures the agency published for the second-highest bid. Leave them blank until results are out.
        </p>
      </fieldset>
      <label className="block" htmlFor={id("winner")}>
        <span className="text-[13px] text-muted-foreground">Winner, as published (optional)</span>
        <input id={id("winner")} name="winner" maxLength={160} defaultValue={sale?.winner ?? ""} className="desk-input mt-2" />
      </label>
      <label className="block" htmlFor={id("sourceUrl")}>
        <span className="text-[13px] text-muted-foreground">Source link (optional)</span>
        <input id={id("sourceUrl")} name="sourceUrl" type="url" maxLength={500} defaultValue={sale?.sourceUrl ?? ""} placeholder="https://" className="desk-input mt-2" />
      </label>
    </div>
  );
}
