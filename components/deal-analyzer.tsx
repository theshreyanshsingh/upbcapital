"use client";

import { useId, useMemo, useState } from "react";
import { timelineLine } from "@/lib/foreclosure";
import { money, pct } from "@/lib/format";
import {
  NPL_ASSUMPTIONS,
  PREPAYMENT,
  cashIn,
  performingCase,
  performingWeights,
  priceForYield,
  pricingValue,
  yieldAtPrice,
  type PricingNote,
} from "@/lib/underwriting";

type Mode = "yield" | "price";

function parseAmount(text: string) {
  return Number(text.replace(/[$,%\s]/g, ""));
}

function share(weight: number) {
  return `${Math.round(weight * 100)}%`;
}

// The page that renders this passes the original props; everything after defaultBid is optional, so older pages
// keep working and a rebuilt page can add occupancy, lien, fees and the value's basis.
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
  occupancy,
  lienPosition,
  seniorBalance,
  foreclosureFiledAt,
  premiumBps,
  closingCost,
  valueLabel,
  valueEstimate,
  defaultTargetYield = 12,
  initialMode = "yield",
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
  // OWNER_OCCUPIED, TENANT, VACANT or UNKNOWN. Sets the resolution weights.
  occupancy?: string | null;
  // FIRST, SECOND, THIRD or OTHER. A junior lien is priced behind its senior.
  lienPosition?: string | null;
  // The senior lien's balance, for a junior. Without it the buyer can enter one, or 70% of value is assumed.
  seniorBalance?: number | null;
  // ISO date. Shortens the remaining foreclosure timeline.
  foreclosureFiledAt?: string | null;
  // When given, every figure is after the buyer premium and these closing costs.
  premiumBps?: number | null;
  closingCost?: number | null;
  // What the seller's value is, such as "BPO, June 2026". Labels the percent-of-value figure.
  valueLabel?: string | null;
  // A current value estimate, already cleared by showableAvm on the server. When given, the model prices on current
  // LTV from it instead of the seller's value, and says so.
  valueEstimate?: { value: number; provider?: string | null; asOf?: string | null } | null;
  defaultTargetYield?: number;
  initialMode?: Mode;
}) {
  const ids = useId();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [bidText, setBidText] = useState(String(Math.round(defaultBid || 0)));
  const [targetText, setTargetText] = useState(String(defaultTargetYield));
  const [balloon, setBalloon] = useState("");
  const [missed, setMissed] = useState("");
  const [armMonth, setArmMonth] = useState("");
  const [armRate, setArmRate] = useState("");
  const [seniorText, setSeniorText] = useState("");
  const [cprText, setCprText] = useState("");
  const bid = parseAmount(bidText);
  const target = parseAmount(targetText);
  const bidValid = Number.isFinite(bid) && bid > 0;
  const targetValid = Number.isFinite(target) && target > 0 && target < 100;
  const balloonMonth = Number(balloon);
  const armAt = Number(armMonth);
  const armYield = Number(armRate);
  const junior = lienPosition === "SECOND" || lienPosition === "THIRD" || lienPosition === "OTHER";
  const seniorEntered = parseAmount(seniorText);
  const senior = seniorBalance ?? (seniorText && Number.isFinite(seniorEntered) && seniorEntered >= 0 ? seniorEntered : null);
  const cprEntered = parseAmount(cprText);
  const cpr = cprText.trim() && Number.isFinite(cprEntered) && cprEntered >= 0 && cprEntered <= 60 ? cprEntered : null;
  const costs = useMemo(() => ({ premiumBps: premiumBps ?? 0, closingCost: closingCost ?? 0, cpr }), [premiumBps, closingCost, cpr]);
  const feesIn = Boolean(premiumBps || closingCost);
  // Current value: the estimate when the server sent one, otherwise the seller's figure, and the label says which.
  const priced = pricingValue(value, valueEstimate ?? null);
  const pricedValue = priced.value;
  const valueWords = priced.source === "estimate" ? priced.label : valueLabel ? `seller's value (${valueLabel})` : "seller's value";
  const valueName = priced.source === "estimate" ? "estimate" : valueLabel ? valueLabel.split(",")[0].trim() : "value";

  const note: PricingNote = useMemo(
    () => ({
      upb,
      interestRate: annualRate,
      monthlyPi,
      termMonths,
      estimatedValue: pricedValue,
      state,
      paymentStatus: performing ? "PERFORMING" : "NON_PERFORMING",
      occupancy: occupancy ?? "UNKNOWN",
      lienPosition: lienPosition ?? "FIRST",
      monthsDelinquent,
      foreclosureFiledAt: foreclosureFiledAt ?? null,
      seniorBalance: senior,
      balloonMonth: balloonMonth > 0 ? balloonMonth : null,
      missedMonths: missed.split(/[^0-9]+/).map(Number).filter((month) => month > 0),
      armResets: armAt > 0 && armYield > 0 ? [{ month: armAt, annualRate: armYield }] : [],
    }),
    [upb, annualRate, monthlyPi, termMonths, pricedValue, state, performing, occupancy, lienPosition, monthsDelinquent, foreclosureFiledAt, senior, balloonMonth, missed, armAt, armYield],
  );

  const atPrice = useMemo(() => (bidValid ? yieldAtPrice(note, bid, costs) : null), [bidValid, note, bid, costs]);
  const forYield = useMemo(() => (targetValid ? priceForYield(note, target, costs) : null), [targetValid, note, target, costs]);
  const cash = useMemo(
    () =>
      performing && bidValid
        ? performingCase({
            bid: cashIn(bid, costs),
            upb,
            annualRate,
            monthlyPi,
            termMonths,
            balloonMonth: note.balloonMonth,
            missedMonths: note.missedMonths,
            armResets: note.armResets,
          })
        : null,
    [performing, bidValid, bid, costs, upb, annualRate, monthlyPi, termMonths, note],
  );
  const rows = !performing && atPrice ? atPrice.cases : [];
  const rule = atPrice?.timeline ?? forYield?.timeline ?? null;
  const progress = atPrice?.foreclosure ?? forYield?.foreclosure ?? null;
  const ltv = atPrice?.ltv ?? forYield?.ltv ?? null;
  const prepayment = atPrice?.prepayment ?? forYield?.prepayment ?? null;
  const pathWeights = performingWeights(prepayment?.cpr ?? PREPAYMENT.cpr)
    .map((path) => `${path.label.toLowerCase()} ${share(path.weight)}`)
    .join(", ");
  const weightsBasis = atPrice?.weightsBasis ?? forYield?.weightsBasis ?? null;
  const memoBid = mode === "yield" ? (bidValid ? bid : null) : forYield?.bid ?? null;
  const feeLine = feesIn
    ? `After the ${premiumBps ? `${(premiumBps / 100).toFixed(2)}% buyer premium` : ""}${premiumBps && closingCost ? " and " : ""}${closingCost ? `${money(closingCost)} of closing costs` : ""}.`
    : "The buyer premium and closing costs are not in these figures.";

  return (
    <section className="mt-8 glass p-6">
      <p className="eyebrow">Deal analyzer</p>
      <h2 className="mt-2 font-semibold tracking-tight text-lg text-foreground">{title}</h2>

      <div role="group" aria-label="Analyzer mode" className="mt-5 inline-flex rounded-lg border border-border p-1">
        {([
          ["yield", "Yield at my price"],
          ["price", "Price for my yield"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={mode === key}
            onClick={() => setMode(key)}
            className={`min-h-9 rounded-md px-3 text-[13px] font-medium transition ${mode === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {mode === "yield" ? (
          <label className="block" htmlFor={`${ids}-bid`}>
            <span className="text-[13px] text-muted-foreground">Your bid</span>
            <input
              id={`${ids}-bid`}
              value={bidText}
              onChange={(event) => setBidText(event.target.value)}
              inputMode="decimal"
              aria-invalid={!bidValid}
              aria-describedby={bidValid ? undefined : `${ids}-bid-error`}
              className="desk-input mt-2 tabular-nums"
            />
          </label>
        ) : (
          <label className="block" htmlFor={`${ids}-target`}>
            <span className="text-[13px] text-muted-foreground">Target IRR, % a year</span>
            <input
              id={`${ids}-target`}
              value={targetText}
              onChange={(event) => setTargetText(event.target.value)}
              inputMode="decimal"
              aria-invalid={!targetValid}
              aria-describedby={targetValid ? undefined : `${ids}-target-error`}
              className="desk-input mt-2 tabular-nums"
            />
          </label>
        )}
        {!performing && junior && seniorBalance == null && (
          <label className="block" htmlFor={`${ids}-senior`}>
            <span className="text-[13px] text-muted-foreground">Senior lien balance</span>
            <input
              id={`${ids}-senior`}
              value={seniorText}
              onChange={(event) => setSeniorText(event.target.value)}
              inputMode="decimal"
              placeholder={money(pricedValue * NPL_ASSUMPTIONS.seniorShare)}
              className="desk-input mt-2 tabular-nums"
            />
          </label>
        )}
      </div>
      <p className="mt-3 text-xs text-muted-foreground tabular-nums">
        {ltv
          ? `Priced on a current ${ltv.combined ? "combined LTV" : "LTV"} of ${pct(ltv.pct, 0)}, from the ${valueWords}${ltv.seniorAssumed ? `, with the senior lien assumed at ${share(NPL_ASSUMPTIONS.seniorShare)} of value` : ""}.`
          : `No value on file, so there is no current LTV.`}
      </p>
      {mode === "yield" && !bidValid && <p id={`${ids}-bid-error`} className="mt-3 text-sm text-bad">Enter a bid above zero.</p>}
      {mode === "price" && !targetValid && <p id={`${ids}-target-error`} className="mt-3 text-sm text-bad">Enter a target between 0% and 100%.</p>}

      {performing && (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Field id={`${ids}-balloon`} label="Balloon month" value={balloon} onChange={setBalloon} hint="Blank for none" />
          <Field id={`${ids}-missed`} label="Missed months" value={missed} onChange={setMissed} hint="Such as 3 4" />
          <Field id={`${ids}-arm-month`} label="ARM reset month" value={armMonth} onChange={setArmMonth} hint="Blank for fixed" />
          <Field id={`${ids}-arm-rate`} label="Rate after reset, %" value={armRate} onChange={setArmRate} hint="Such as 8.5" />
          <Field id={`${ids}-cpr`} label="Prepayment, % CPR a year" value={cprText} onChange={setCprText} hint={`${PREPAYMENT.cpr}, the default`} />
        </div>
      )}
      {performing && prepayment && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{prepayment.label}</p>}

      {!performing && rule && (
        <div className="mt-6 space-y-1 text-sm text-muted-foreground">
          <p>{timelineLine(rule)}</p>
          {progress && <p className="text-foreground tabular-nums">{progress.line}</p>}
          <p className="text-xs">Process law: {rule.law}. About {money(rule.cost)} of legal, court and trustee costs, a desk estimate.</p>
          {weightsBasis && <p className="text-xs">{weightsBasis}</p>}
        </div>
      )}

      {mode === "yield" && performing && cash && atPrice && (
        <>
          <dl className="mt-6 grid gap-px bg-muted sm:grid-cols-4">
            <Metric k="Cash yield" v={pct(cash.yieldPct)} />
            <Metric k="IRR to term" v={pct(atPrice.irrPct)} />
            <Metric k="Cash-on-cash" v={pct(cash.cashOnCash)} />
            <Metric k="Payback" v={cash.paybackMonths == null ? "—" : `${cash.paybackMonths.toFixed(1)} mo`} />
          </dl>
          <Paths
            caption="If the loan does not run to term"
            rows={atPrice.scenarios.map((row) => ({ key: row.key, label: row.label, weight: row.weight, figure: pct(row.irrPct) }))}
            heading="IRR"
          />
          <Strip
            dots={atPrice.dots}
            format={(item) => pct(item)}
            clamp={[-100, 100]}
            range={atPrice.range}
            label="IRR"
            footnote={PATH_NOTE}
          />
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            Unlevered. Cash yield is the contractual payment over the cash in. IRR can include a balloon, skipped months (interest stays on the balance) and one ARM reset. The path weights ({pathWeights}) take the payoff from the prepayment speed and the default from the desk. Neither is a fitted model. {feeLine}
          </p>
        </>
      )}

      {mode === "price" && forYield && (
        <>
          <dl className="mt-6 grid gap-px bg-muted sm:grid-cols-3">
            <Metric k={`Bid for ${pct(target)} IRR`} v={forYield.bid == null ? "No price" : money(forYield.bid)} />
            <Metric k="Of UPB" v={pct(forYield.pctOfUpb)} />
            <Metric k={`Of ${valueName}`} v={pct(forYield.pctOfValue)} />
          </dl>
          {forYield.bid == null && <p className="mt-3 text-sm text-muted-foreground">No bid above zero returns {pct(target)} on this model.</p>}
          {forYield.bid != null && (
            <button
              type="button"
              onClick={() => {
                setBidText(String(Math.round(forYield.bid ?? 0)));
                setMode("yield");
              }}
              className="mt-4 inline-flex h-10 items-center rounded-lg border border-border px-4 text-[13px] font-medium text-foreground hover:border-link/50"
            >
              Check the yield at {money(forYield.bid)}
            </button>
          )}
          <Paths
            caption={forYield.performing ? `What each path is worth at ${pct(target)}` : `What each resolution is worth at ${pct(target)}`}
            rows={forYield.scenarios.map((row) => ({
              key: row.key,
              label: row.label,
              weight: row.weight,
              figure: row.bid == null || row.bid < 1 ? "No price" : `${money(row.bid)} · ${pct(row.pctOfUpb, 0)} of UPB`,
            }))}
            heading="Price"
          />
          <Strip
            dots={forYield.dots}
            format={(item) => money(item)}
            range={forYield.range}
            label="Price"
            footnote={forYield.performing ? PATH_NOTE : RESOLUTION_NOTE}
          />
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            {forYield.basis} {forYield.performing ? "The headline is the price on the contract; the strip shows what an early payoff or a default would justify." : "The headline is the price at which the weighted resolutions return the target."}
            {` Value is the ${valueWords}.`}
          </p>
        </>
      )}

      {mode === "yield" && !performing && atPrice && (
        <>
          <dl className="mt-6 grid gap-px bg-muted sm:grid-cols-3">
            <Metric k="Expected IRR" v={pct(atPrice.irrPct)} />
            <Metric k="Of UPB" v={pct(upb > 0 ? (bid / upb) * 100 : null)} />
            <Metric k={`Of ${valueName}`} v={pct(pricedValue > 0 ? (bid / pricedValue) * 100 : null)} />
          </dl>
          <Strip dots={atPrice.dots} format={(item) => pct(item)} clamp={[-100, 100]} range={atPrice.range} label="IRR" footnote={RESOLUTION_NOTE} />
          <div className="mt-6 relative overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <caption className="sr-only">Resolution cases at {money(bid)}</caption>
              <thead className="text-xs font-medium text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-normal">Resolution</th>
                  {["Weight", "Months", "Paid out", "Received", "Net", "IRR"].map((heading) => (
                    <th key={heading} scope="col" className="px-3 py-2 text-right font-normal">{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="border-t border-border">
                    <td className="px-3 py-3 text-foreground">
                      {row.label}
                      <span className="mt-1 block text-xs text-muted-foreground">{row.note}</span>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{share(row.weight)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{row.months}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{money(row.cost)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{money(row.recovery)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{money(row.net)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{pct(row.irrPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            {atPrice.basis} Paid out is carry, servicing and process costs after the bid. These are desk models, not legal advice.
          </p>
        </>
      )}

      {!performing && (
        <details className="mt-4 text-xs text-muted-foreground">
          <summary className="cursor-pointer text-[13px] font-medium text-foreground">Assumptions</summary>
          <ul className="mt-2 space-y-1 leading-relaxed">
            <li>Taxes and insurance on a first lien: {Math.round(NPL_ASSUMPTIONS.carryRate * 1000) / 10}% of value a year. Servicing: {money(NPL_ASSUMPTIONS.servicingMonthly)} a month.</li>
            <li>Filing waits for boarding ({NPL_ASSUMPTIONS.boardingMonths} months) and for the borrower to be 120 days behind.</li>
            <li>A cured loan sells at {share(NPL_ASSUMPTIONS.reperformingMark)} and a modified one at {share(NPL_ASSUMPTIONS.modifiedMark)} of the lower of UPB and value.</li>
            <li>A short sale nets {share(NPL_ASSUMPTIONS.shortSaleRecovery)} of value. An REO sells at {share(NPL_ASSUMPTIONS.reoRecovery)} after a foreclosure and {share(NPL_ASSUMPTIONS.deedRecovery)} after a deed in lieu, less {share(NPL_ASSUMPTIONS.saleCost)} sale costs.</li>
            <li>No sale pays more than the debt. A junior lien takes what is left after the senior, assumed at {share(NPL_ASSUMPTIONS.seniorShare)} of value when not entered.</li>
            <li>The spread weighs each resolution at a 35% slower timeline with 10% less value, as modelled, and 25% faster with 5% more value, at one, two and one parts in four.</li>
          </ul>
        </details>
      )}

      {memoBid != null && memoBid > 0 && (
        <a
          className="mt-5 inline-flex h-11 items-center border border-link/40 px-5 text-[13px] font-medium text-link rounded-lg"
          href={`/api/listings/${listingId}/memo?bid=${encodeURIComponent(String(Math.round(memoBid)))}${mode === "price" ? `&target=${encodeURIComponent(String(target))}` : ""}`}
        >
          Download underwriting memo
        </a>
      )}
    </section>
  );
}

const PATH_NOTE = "Each dot is one chance in twenty across the three paths. The dashed line is the median. A desk model, not a forecast.";
const RESOLUTION_NOTE =
  "Each dot is one chance in twenty, from the resolution weights and a slower or faster timeline. The dashed line is the median. A desk model, not a forecast.";

function Field({ id, label, value, onChange, hint }: { id: string; label: string; value: string; onChange: (value: string) => void; hint: string }) {
  return (
    <label className="block" htmlFor={id}>
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <input id={id} value={value} onChange={(event) => onChange(event.target.value)} inputMode="decimal" placeholder={hint} className="desk-input mt-2 tabular-nums" />
    </label>
  );
}

function Metric({ k, v }: { k: string; v: string }) {
  return (
    <div className="bg-card/80 px-4 py-3">
      <dt className="text-xs font-medium text-muted-foreground">{k}</dt>
      <dd className="mt-1 font-semibold tracking-tight text-3xl tabular-nums text-foreground">{v}</dd>
    </div>
  );
}

function Paths({ caption, heading, rows }: { caption: string; heading: string; rows: { key: string; label: string; weight: number; figure: string }[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-6 relative overflow-x-auto">
      <table className="min-w-full text-left text-sm">
        <caption className="pb-2 text-left text-[13px] font-medium text-foreground">{caption}</caption>
        <thead className="text-xs font-medium text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-normal">Path</th>
            <th scope="col" className="px-3 py-2 text-right font-normal">Weight</th>
            <th scope="col" className="px-3 py-2 text-right font-normal">{heading}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-border">
              <td className="px-3 py-2.5 text-foreground">{row.label}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{share(row.weight)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{row.figure}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// A quantile dotplot: twenty dots, each one chance in twenty. Dots that land in the same column stack.
function Strip({
  dots,
  format,
  range,
  label,
  clamp,
  footnote,
}: {
  dots: number[];
  format: (value: number) => string;
  range: { p10: number; p50: number; p90: number } | null;
  label: string;
  clamp?: [number, number];
  footnote: string;
}) {
  if (dots.length === 0 || !range) return null;
  const fit = (value: number) => (clamp ? Math.min(clamp[1], Math.max(clamp[0], value)) : value);
  const shown = dots.map(fit);
  const clipped = shown.some((value, index) => value !== dots[index]);
  let low = Math.min(...shown);
  let high = Math.max(...shown);
  if (high - low < 1e-6) {
    low -= 1;
    high += 1;
  }
  const width = 600;
  const radius = 7;
  const left = 16;
  const right = width - 16;
  const x = (value: number) => left + ((value - low) / (high - low)) * (right - left);
  const columns = new Map<number, number>();
  const placed = shown.map((value) => {
    const column = Math.round(x(value) / (radius * 2));
    const stack = columns.get(column) ?? 0;
    columns.set(column, stack + 1);
    return { cx: Math.min(right, Math.max(left, column * radius * 2)), stack };
  });
  const tallest = Math.max(...placed.map((dot) => dot.stack)) + 1;
  const plotHeight = tallest * radius * 2 + 8;
  const height = plotHeight + 26;
  const ticks = [low, (low + high) / 2, high];
  const median = x(fit(range.p50));
  const summary = `Median ${format(range.p50)}. Eight in ten outcomes fall between ${format(range.p10)} and ${format(range.p90)}.`;
  return (
    <figure className="mt-6">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label={`${label} across twenty equally likely outcomes. ${summary}`}>
        <line x1={left} x2={right} y1={plotHeight} y2={plotHeight} stroke="var(--border)" />
        <line x1={median} x2={median} y1={4} y2={plotHeight} stroke="var(--foreground)" strokeDasharray="3 3" />
        {placed.map((dot, index) => (
          <circle key={index} cx={dot.cx} cy={plotHeight - radius - 2 - dot.stack * radius * 2} r={radius - 1} style={{ fill: "var(--chart-2)" }} />
        ))}
        {ticks.map((tick, index) => (
          <text
            key={index}
            x={x(tick)}
            y={height - 6}
            textAnchor={index === 0 ? "start" : index === ticks.length - 1 ? "end" : "middle"}
            className="tabular-nums"
            style={{ fill: "var(--muted-foreground)", fontSize: 12 }}
          >
            {format(tick)}
          </text>
        ))}
      </svg>
      <figcaption className="mt-2 text-sm text-foreground tabular-nums">{summary}</figcaption>
      <p className="mt-1 text-xs text-muted-foreground">
        {footnote}
        {clipped && clamp ? ` Outcomes past ${format(clamp[0])} or ${format(clamp[1])} sit at the edge.` : ""}
      </p>
    </figure>
  );
}
