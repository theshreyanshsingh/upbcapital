import { tieOutClosingTape } from "@/actions/tie-out";
import { SubmitButton } from "@/components/submit-button";
import { money, prettyDate } from "@/lib/format";
import { SERVICER_SOURCES } from "@/lib/servicer-import";
import { readTieOut, TIE_OUT_SELLER, tieOutFieldLabel, tieOutValue, type TieOutStatus } from "@/lib/tie-out";

// On the closing page: the bid tape checked against the tape as of closing. Both sides read the result; the closings
// side of the desk runs it. lib/tie-out.ts does the matching.

const STATUS_TEXT: Record<TieOutStatus, string> = {
  AGREES: "Agrees",
  CHANGED: "Changed",
  PAID_OFF: "Paid off",
  MISSING: "Not on the closing tape",
};

export function TieOutPanel({ closing, canRun }: { closing: { id: string; status: string; tieOut?: unknown; tieOutAt?: Date | null }; canRun: boolean }) {
  const tieOut = readTieOut(closing.tieOut);
  const open = closing.status === "OPEN";
  if (!tieOut && !(canRun && open)) return null;
  const flagged = tieOut ? tieOut.loans.filter((loan) => loan.status !== "AGREES") : [];
  return (
    <section id="tie-out" aria-labelledby="tie-out-heading" className="mt-6 scroll-mt-6 glass p-6">
      <h2 id="tie-out-heading" className="eyebrow">Tape tie-out</h2>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        The tape the price was bid on, checked against the tape as of closing. Loans match by loan number, then by street and ZIP. A balance paid down, a loan paid off or one missing at closing can move the price.
      </p>
      {tieOut && (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-foreground">{tieOut.source} · {tieOut.filename} · {prettyDate(closing.tieOutAt ?? tieOut.at)}</p>
          <dl className="grid grid-cols-2 gap-px bg-muted sm:grid-cols-5">
            {[
              ["Agree", String(tieOut.totals.agree)],
              ["Changed", String(tieOut.totals.changed)],
              ["Paid off", String(tieOut.totals.paidOff)],
              ["Missing", String(tieOut.totals.missing)],
              ["UPB change", money(tieOut.totals.upbChange, 2)],
            ].map(([k, v]) => (
              <div key={k} className="bg-card/80 px-3 py-2">
                <dt className="text-xs text-muted-foreground">{k}</dt>
                <dd className="mt-0.5 text-sm font-medium tabular-nums text-foreground">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground tabular-nums">
            UPB on the bid tape {money(tieOut.totals.bidUpb, 2)} · at closing {money(tieOut.totals.closingUpb, 2)}, over the loans the closing tape lists.
          </p>
          {flagged.length === 0 ? (
            <p className="text-sm text-foreground">Every loan agrees with the bid tape.</p>
          ) : (
            <div className="relative overflow-x-auto border border-border rounded-lg">
              <table className="min-w-full text-left text-sm">
                <thead className="text-xs font-medium text-muted-foreground">
                  <tr>{["Loan", "Result", "Field", "Bid tape", "At closing"].map((heading) => <th key={heading} className="px-3 py-2 font-normal">{heading}</th>)}</tr>
                </thead>
                <tbody>
                  {flagged.flatMap((loan) => {
                    const rows = loan.differences.length ? loan.differences : [null];
                    return rows.map((difference, index) => (
                      <tr key={`${loan.noteId}-${difference?.field ?? "none"}`} className={index === 0 ? "border-t border-border align-top" : "align-top"}>
                        <td className="px-3 py-2 text-foreground">{index === 0 ? loan.label : ""}</td>
                        <td className={`px-3 py-2 ${loan.status === "CHANGED" ? "text-foreground" : "text-warn"}`}>{index === 0 ? STATUS_TEXT[loan.status] : ""}</td>
                        <td className="px-3 py-2 text-muted-foreground">{difference ? tieOutFieldLabel(difference.field) : "—"}</td>
                        <td className="px-3 py-2 tabular-nums text-muted-foreground">{difference ? tieOutValue(difference.field, difference.bid) : "—"}</td>
                        <td className="px-3 py-2 tabular-nums text-foreground">{difference ? tieOutValue(difference.field, difference.closing) : "—"}</td>
                      </tr>
                    ));
                  })}
                </tbody>
              </table>
            </div>
          )}
          {tieOut.extra.length > 0 && (
            <div>
              <h3 className="text-[13px] font-medium text-foreground">Rows that match no loan in this closing</h3>
              <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
                {tieOut.extra.slice(0, 25).map((row) => <li key={row.row}>Row {row.row} · {row.label} · {row.reason}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
      {canRun && open && (
        <form action={tieOutClosingTape} className="mt-4 grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2">
          <input type="hidden" name="closingId" value={closing.id} />
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Where the tape comes from</span>
            <select name="source" required defaultValue="" className="desk-input mt-2">
              <option value="" disabled>Choose</option>
              <optgroup label="Servicer">
                {SERVICER_SOURCES.filter((row) => row.kind === "servicer").map((row) => <option key={row.value} value={row.value}>{row.label}</option>)}
              </optgroup>
              <optgroup label="The holder">
                {SERVICER_SOURCES.filter((row) => row.kind === "holder").map((row) => <option key={row.value} value={row.value}>{row.label}</option>)}
                <option value={TIE_OUT_SELLER}>The seller&apos;s tape as of closing</option>
              </optgroup>
            </select>
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Name, if it isn&apos;t listed</span>
            <input name="sourceName" className="desk-input mt-2" maxLength={28} autoComplete="off" />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-[13px] text-muted-foreground">Tape as of closing</span>
            <input type="file" name="file" required accept=".csv,.xlsx,.xls" className="mt-2 block w-full text-sm" />
          </label>
          <p className="text-xs text-muted-foreground sm:col-span-2">The file goes with the payment step. A new tie-out replaces the last one, and the seller and buyer are told.</p>
          <div className="sm:col-span-2"><SubmitButton className="h-9 text-[13px] font-medium" pendingLabel="Checking…">{tieOut ? "Run the tie-out again" : "Run the tie-out"}</SubmitButton></div>
        </form>
      )}
    </section>
  );
}
