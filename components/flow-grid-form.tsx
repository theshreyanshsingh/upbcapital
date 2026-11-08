"use client";

import { useState, useTransition } from "react";
import { saveFlowGrid } from "@/actions/flow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LIEN_POSITIONS, PAYMENT_STATUSES } from "@/lib/labels";

type Row = { paymentStatus: string; lienPosition: string; maxLtv: number | null; pct: number };

const ANY = "ANY";

// The buyer's price grid: percent of unpaid balance by payment status, lien and maximum LTV, and a cap per tranche.
// It pre-fills each tranche's bid form. Only the buyer and the desk read it.
export function FlowGridForm({ commitmentId, rows, cap, blanks }: { commitmentId: string; rows: Row[]; cap: number | null; blanks: number }) {
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const shown: (Row | null)[] = [...rows, ...Array.from({ length: blanks }, () => null)];

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError("");
    start(async () => {
      const result = await saveFlowGrid(data);
      if (result?.error) setError(result.error);
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <input type="hidden" name="commitmentId" value={commitmentId} />
      <div className="relative overflow-x-auto rounded-xl border border-border">
        <table className="min-w-full text-left text-sm">
          <caption className="sr-only">Price grid</caption>
          <thead className="text-xs font-medium text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-normal">Payment status</th>
              <th scope="col" className="px-3 py-2 font-normal">Lien</th>
              <th scope="col" className="px-3 py-2 font-normal">Max LTV %</th>
              <th scope="col" className="px-3 py-2 font-normal">% of UPB</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <tr key={index} className="border-t border-border">
                <td className="px-3 py-2">
                  <select name="gridStatus" defaultValue={row?.paymentStatus ?? ANY} aria-label={`Row ${index + 1} payment status`} className="desk-input">
                    <option value={ANY}>Any</option>
                    {PAYMENT_STATUSES.map((status) => (
                      <option key={status.value} value={status.value}>{status.label}</option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <select name="gridLien" defaultValue={row?.lienPosition ?? ANY} aria-label={`Row ${index + 1} lien`} className="desk-input">
                    <option value={ANY}>Any</option>
                    {LIEN_POSITIONS.map((lien) => (
                      <option key={lien.value} value={lien.value}>{lien.label}</option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <Input name="gridLtv" inputMode="decimal" defaultValue={row?.maxLtv ?? ""} placeholder="No limit" aria-label={`Row ${index + 1} maximum LTV`} className="h-10 w-28 bg-card tabular-nums" />
                </td>
                <td className="px-3 py-2">
                  <Input name="gridPct" inputMode="decimal" defaultValue={row?.pct ?? ""} aria-label={`Row ${index + 1} percent of UPB`} className="h-10 w-24 bg-card tabular-nums" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        A row naming a status and lien beats an Any row, and the tightest LTV band a loan fits wins. A loan no row fits adds nothing to the suggestion.
        Clear a row&apos;s percent to drop it.
      </p>
      <label className="block max-w-xs">
        <span className="text-[13px] text-muted-foreground">Cap per tranche (optional)</span>
        <Input name="cap" inputMode="decimal" defaultValue={cap ?? ""} placeholder="No cap" className="mt-1 h-11 bg-card tabular-nums" />
      </label>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending} className="h-10 px-4 text-[13px] font-medium">{pending ? "Saving…" : "Save the grid"}</Button>
        {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      </div>
    </form>
  );
}
