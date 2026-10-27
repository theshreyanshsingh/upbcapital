"use client";

import { useMemo, useState } from "react";
import { foreclosureFor } from "@/lib/foreclosure";
import { nplCases, performingCase } from "@/lib/underwriting";

function money(value: number) {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function pct(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

export function DealAnalyzer({
  listingId,
  title,
  performing,
  upb,
  annualRate,
  monthlyPi,
  termMonths,
  value,
  monthsDelinquent,
  state,
  defaultBid,
}: {
  listingId: string;
  title: string;
  performing: boolean;
  upb: number;
  annualRate: number;
  monthlyPi: number;
  termMonths: number;
  value: number;
  monthsDelinquent: number;
  state: string;
  defaultBid: number;
}) {
  const [bidText, setBidText] = useState(String(Math.round(defaultBid || 0)));
  const [balloon, setBalloon] = useState("");
  const [missed, setMissed] = useState("");
  const [armMonth, setArmMonth] = useState("");
  const [armRate, setArmRate] = useState("");
  const bid = Number(bidText.replace(/[$,\s]/g, ""));
  const valid = Number.isFinite(bid) && bid > 0;
  const balloonMonth = Number(balloon);
  const armAt = Number(armMonth);
  const armYield = Number(armRate);
  const rule = foreclosureFor(state);
  const cash = useMemo(
    () =>
      valid
        ? performingCase({
            bid,
            upb,
            annualRate,
            monthlyPi,
            termMonths,
            balloonMonth: balloonMonth > 0 ? balloonMonth : null,
            missedMonths: missed.split(/[^0-9]+/).map(Number).filter((month) => month > 0),
            armResets: armAt > 0 && armYield > 0 ? [{ month: armAt, annualRate: armYield }] : [],
          })
        : null,
    [valid, bid, upb, annualRate, monthlyPi, termMonths, balloonMonth, missed, armAt, armYield],
  );
  const scenarios = useMemo(
    () =>
      valid
        ? nplCases({
            bid,
            upb,
            value,
            monthlyPi,
            monthsDelinquent,
            foreclosureMonths: rule.months,
            foreclosureCost: rule.cost,
            process: rule.process,
          })
        : [],
    [valid, bid, upb, value, monthlyPi, monthsDelinquent, rule.months, rule.cost, rule.process],
  );

  return (
    <section className="mt-8 glass p-6">
      <p className="eyebrow">Deal analyzer</p>
      <h2 className="mt-2 font-semibold tracking-tight text-lg text-foreground">{title}</h2>
      <label className="mt-5 block max-w-xs">
        <span className="text-[13px] text-muted-foreground">Your bid</span>
        <input
          value={bidText}
          onChange={(event) => setBidText(event.target.value)}
          inputMode="decimal"
          aria-label="Bid amount"
          className="desk-input mt-2"
        />
      </label>
      {!valid && <p className="mt-3 text-sm text-bad">Enter a bid above zero.</p>}
      {performing && cash && (
        <dl className="mt-6 grid gap-px bg-muted sm:grid-cols-4">
          <Metric k="Yield" v={pct(cash.yieldPct)} />
          <Metric k="IRR" v={pct(cash.irrPct)} />
          <Metric k="Cash-on-cash" v={pct(cash.cashOnCash)} />
          <Metric k="Payback" v={cash.paybackMonths == null ? "—" : `${cash.paybackMonths.toFixed(1)} mo`} />
        </dl>
      )}
      {performing && (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            <input value={balloon} onChange={(event) => setBalloon(event.target.value)} className="desk-input" aria-label="Balloon month" placeholder="Balloon month" />
            <input value={missed} onChange={(event) => setMissed(event.target.value)} className="desk-input" aria-label="Missed months" placeholder="Missed months, 3 4" />
            <input value={armMonth} onChange={(event) => setArmMonth(event.target.value)} className="desk-input" aria-label="ARM reset month" placeholder="ARM month" />
            <input value={armRate} onChange={(event) => setArmRate(event.target.value)} className="desk-input" aria-label="ARM rate" placeholder="New rate %" />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            Unlevered. Yield is the contractual payment over the bid. IRR can include a balloon, skipped months (interest stays on the balance), and one ARM reset. The buyer premium is not in these figures.
          </p>
        </>
      )}
      {!performing && (
        <div className="mt-6 overflow-x-auto">
          <p className="text-sm text-muted-foreground">
            {rule.assumed ? "State not on the desk schedule, so this uses Florida judicial timing." : `${rule.state} · ${rule.process.toLowerCase()} · ${rule.months} months · ${money(rule.cost)} of process cost.`}
            {" "}These are desk models, not legal advice.
          </p>
          <table className="mt-4 min-w-full text-left text-sm">
            <thead className="text-xs font-medium text-muted-foreground">
              <tr>
                {["Resolution", "Months", "Cost", "Recovery", "Net", "Annualized"].map((heading) => (
                  <th key={heading} className="px-3 py-2 font-normal">{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scenarios.map((row) => (
                <tr key={row.key} className="border-t border-border">
                  <td className="px-3 py-3 text-foreground">
                    {row.label}
                    <span className="mt-1 block text-xs text-muted-foreground">{row.note}</span>
                  </td>
                  <td className="px-3 py-3">{row.months}</td>
                  <td className="px-3 py-3">{money(row.cost)}</td>
                  <td className="px-3 py-3">{money(row.recovery)}</td>
                  <td className="px-3 py-3">{money(row.net)}</td>
                  <td className="px-3 py-3">{pct(row.annualized)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {valid && (
        <a
          className="mt-5 inline-flex h-11 items-center border border-link/40 px-5 text-[13px] font-medium text-link rounded-lg"
          href={`/api/listings/${listingId}/memo?bid=${encodeURIComponent(String(bid))}`}
        >
          Download underwriting memo
        </a>
      )}
    </section>
  );
}

function Metric({ k, v }: { k: string; v: string }) {
  return (
    <div className="bg-card/80 px-4 py-3">
      <dt className="text-xs font-medium text-muted-foreground">{k}</dt>
      <dd className="mt-1 font-semibold tracking-tight text-3xl text-foreground">{v}</dd>
    </div>
  );
}
