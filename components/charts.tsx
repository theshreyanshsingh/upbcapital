import { Lock } from "lucide-react";
import { money, moneyCompact } from "@/lib/format";

// Small charts for the desk. Each one has an accessible name, labels its values directly or shows them
// on hover and keyboard focus, and draws from the chart tokens, which clear 3:1 against a panel in both
// themes. They render on the server; the hover and focus states are CSS only.

const share = (value: number, total: number) => (total > 0 ? Math.round((value / total) * 100) : 0);

// Rounds an axis maximum up to 1, 2, 2.5 or 5 times a power of ten, so gridlines land on plain numbers.
function niceCeiling(value: number) {
  if (!(value > 0)) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(value)));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => value <= candidate * power) ?? 10;
  return step * power;
}

export function RatioRing({
  label,
  value,
  caption,
}: {
  label: string;
  value: number | null;
  caption: string;
}) {
  const shown = value != null && Number.isFinite(value) ? value : null;
  const pct = shown == null ? 0 : Math.max(0, Math.min(shown, 100));
  const radius = 46;
  const circ = 2 * Math.PI * radius;
  const dash = (pct / 100) * circ;
  return (
    <div className="glass flex items-center gap-4 p-5">
      <div className="relative size-24 shrink-0">
        <svg viewBox="0 0 120 120" className="size-24" role="img" aria-label={`${label}: ${shown == null ? "not available" : `${shown.toFixed(0)} of 100`}`}>
          <circle cx="60" cy="60" r={radius} fill="none" stroke="var(--muted)" strokeWidth="7" />
          {/* A quarter tick at 25, 50 and 75 gives the ring a scale to read against. */}
          {[25, 50, 75].map((tick) => {
            const angle = ((tick / 100) * 360 - 90) * (Math.PI / 180);
            return (
              <line
                key={tick}
                x1={60 + Math.cos(angle) * (radius - 5)}
                y1={60 + Math.sin(angle) * (radius - 5)}
                x2={60 + Math.cos(angle) * (radius + 5)}
                y2={60 + Math.sin(angle) * (radius + 5)}
                stroke="var(--card)"
                strokeWidth="1.5"
              />
            );
          })}
          {pct > 0 && (
            <circle
              cx="60"
              cy="60"
              r={radius}
              fill="none"
              stroke="var(--chart-1)"
              strokeWidth="7"
              strokeLinecap="round"
              strokeDasharray={`${dash} ${circ - dash}`}
              transform="rotate(-90 60 60)"
            />
          )}
        </svg>
        <div aria-hidden className="figure absolute inset-0 grid place-items-center text-2xl font-semibold tracking-tight text-foreground">
          {shown == null ? "—" : shown.toFixed(0)}
        </div>
      </div>
      <div className="min-w-0">
        <p className="eyebrow">{label}</p>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{caption}</p>
      </div>
    </div>
  );
}

export function CapitalStack({
  value,
  upb,
  price,
  title = "Capital stack",
}: {
  value: number;
  upb: number;
  price: number;
  title?: string;
}) {
  const max = Math.max(value, upb, price, 1);
  const rows = [
    { label: "Property value", amount: value, color: "var(--chart-1)" },
    { label: "Unpaid principal", amount: upb, color: "var(--chart-3)" },
    { label: "Asking price", amount: price, color: "var(--chart-2)" },
  ];
  return (
    <figure className="m-0" aria-label={title}>
      <ul className="space-y-4">
        {rows.map((row) => (
          <li key={row.label}>
            <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
              <span className="text-muted-foreground">{row.label}</span>
              <span className="figure text-right font-medium text-foreground">
                {money(row.amount)}
                {value > 0 && row.amount !== value && (
                  <span className="ml-2 font-normal text-muted-foreground">{share(row.amount, value)}% of value</span>
                )}
              </span>
            </div>
            <div aria-hidden className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full" style={{ width: `${(Math.max(row.amount, 0) / max) * 100}%`, background: row.color }} />
            </div>
          </li>
        ))}
      </ul>
      <div aria-hidden className="figure mt-2 flex justify-between type-meta text-muted-foreground">
        <span>$0</span>
        <span>{moneyCompact(max)}</span>
      </div>
    </figure>
  );
}

export function Donut({
  slices,
  title = "Share by category",
}: {
  slices: { label: string; value: number; color: string }[];
  title?: string;
}) {
  const total = slices.reduce((sum, slice) => sum + Math.max(slice.value, 0), 0);
  const radius = 56;
  const circ = 2 * Math.PI * radius;
  // A hairline gap between slices keeps neighbours apart for anyone who can't tell the colours apart.
  const shown = slices.filter((slice) => slice.value > 0);
  const gap = shown.length > 1 ? 2 : 0;
  const summary = slices.map((slice) => `${slice.label} ${share(slice.value, total)}%`).join(", ");
  let acc = 0;
  return (
    <figure className="m-0 flex flex-wrap items-center gap-6">
      <svg viewBox="0 0 160 160" className="size-36 shrink-0 [&:has(circle:hover)_circle:not(:hover)]:opacity-40" role="img" aria-label={`${title}: ${total > 0 ? summary : "nothing to show"}`}>
        <circle cx="80" cy="80" r={radius} fill="none" stroke="var(--muted)" strokeWidth="14" className="pointer-events-none" />
        {shown.map((slice) => {
          const len = (slice.value / (total || 1)) * circ;
          const element = (
            <circle
              key={slice.label}
              cx="80"
              cy="80"
              r={radius}
              fill="none"
              stroke={slice.color}
              strokeWidth="14"
              strokeDasharray={`${Math.max(len - gap, 0.001)} ${circ - Math.max(len - gap, 0.001)}`}
              strokeDashoffset={-acc}
              transform="rotate(-90 80 80)"
              className="transition-opacity"
            >
              <title>{`${slice.label}: ${share(slice.value, total)}%`}</title>
            </circle>
          );
          acc += len;
          return element;
        })}
      </svg>
      <ul className="min-w-40 flex-1 space-y-2 text-sm" aria-hidden>
        {slices.map((slice) => (
          <li key={slice.label} className="flex items-center gap-2 text-muted-foreground">
            <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: slice.color }} />
            <span className="min-w-0 flex-1 truncate">{slice.label}</span>
            <span className="figure font-medium text-foreground">{share(slice.value, total)}%</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

export function HorizontalBars({
  rows,
  title = "Counts",
}: {
  rows: { label: string; value: number }[];
  title?: string;
}) {
  const max = Math.max(...rows.map((row) => row.value), 1);
  return (
    <ul className="space-y-1" aria-label={title}>
      {rows.map((row) => (
        <li key={row.label} className="grid grid-cols-[4.5rem_minmax(0,1fr)_4rem] items-center gap-3 rounded-md px-1 py-1 text-sm transition-colors hover:bg-hover">
          <span className="truncate text-muted-foreground" title={row.label}>{row.label}</span>
          {/* The track's left edge is the zero line every bar starts from. */}
          <span aria-hidden className="h-2 overflow-hidden rounded-r-full border-l border-input bg-muted/70">
            <span className="block h-full rounded-r-full bg-chart-1" style={{ width: `${(Math.max(row.value, 0) / max) * 100}%` }} />
          </span>
          <span className="figure text-right font-medium text-foreground">{row.value.toLocaleString("en-US")}</span>
        </li>
      ))}
    </ul>
  );
}

const SERIES = [
  { key: "premium", label: "Premium", color: "var(--chart-1)" },
  { key: "commission", label: "Commission", color: "var(--chart-2)" },
  { key: "subscription", label: "Subscription", color: "var(--chart-3)" },
] as const;

export function RevenueBars({
  months,
  title = "Desk revenue by month",
}: {
  months: { label: string; premium: number; commission: number; subscription: number }[];
  title?: string;
}) {
  const totals = months.map((month) => month.premium + month.commission + month.subscription);
  const peak = Math.max(...totals, 0);
  const top = niceCeiling(peak);
  const ticks = peak > 0 ? [0, top / 2, top] : [0];
  return (
    <figure className="m-0">
      <figcaption className="sr-only">{title}. Each month lists its total and breakdown.</figcaption>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 pt-5">
        <div aria-hidden className="figure relative h-44 type-meta text-muted-foreground">
          {ticks.map((tick) => (
            <span key={tick} className="absolute right-0 translate-y-1/2 whitespace-nowrap" style={{ bottom: `${(tick / top) * 100}%` }}>
              {moneyCompact(tick)}
            </span>
          ))}
          {/* Keeps the axis column as wide as its widest label. */}
          <span className="invisible">{moneyCompact(top)}</span>
        </div>
        <div className="relative h-44">
          {ticks.map((tick) => (
            <div
              key={tick}
              aria-hidden
              className={tick === 0 ? "absolute inset-x-0 border-t border-input" : "absolute inset-x-0 border-t border-dashed border-border"}
              style={{ bottom: `${(tick / top) * 100}%` }}
            />
          ))}
          <ul className="relative flex h-full items-end gap-2 sm:gap-3">
            {months.map((month, index) => {
              const total = totals[index];
              const breakdown = SERIES.map((series) => `${series.label} ${money(month[series.key])}`).join(", ");
              return (
                <li key={month.label} tabIndex={0} className="group relative flex h-full min-w-0 flex-1 cursor-default justify-center rounded-sm">
                  <span className="sr-only">{`${month.label}: ${money(total)}. ${breakdown}.`}</span>
                  <div className="absolute bottom-0 flex w-full max-w-10 flex-col-reverse gap-px" style={{ height: `${(total / top) * 100}%` }}>
                    {total > 0 &&
                      SERIES.map((series, position) =>
                        month[series.key] > 0 ? (
                          <div
                            key={series.key}
                            className={`transition-opacity group-hover:opacity-90 ${position === SERIES.length - 1 || SERIES.slice(position + 1).every((next) => month[next.key] <= 0) ? "rounded-t-[4px]" : ""}`}
                            style={{ flexGrow: month[series.key], flexBasis: 0, minHeight: 2, background: series.color }}
                          />
                        ) : null,
                      )}
                    <span aria-hidden className="figure absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap type-meta font-medium text-foreground">
                      {total > 0 ? moneyCompact(total) : ""}
                    </span>
                    <span
                      aria-hidden
                      className={`figure pointer-events-none invisible absolute bottom-full z-10 mb-6 w-max translate-y-1 rounded-lg border border-border bg-popover px-3 py-2 text-left type-meta text-popover-foreground opacity-0 shadow-pop transition-[opacity,translate] duration-(--dur-1) group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:visible group-focus-visible:translate-y-0 group-focus-visible:opacity-100 ${index < months.length / 2 ? "left-0" : "right-0"}`}
                    >
                      <strong className="block font-semibold">{month.label} · {money(total)}</strong>
                      {SERIES.map((series) => (
                        <span key={series.key} className="mt-0.5 flex items-center gap-1.5 text-muted-foreground">
                          <i className="size-2 rounded-[2px]" style={{ background: series.color }} />
                          {series.label}
                          <span className="ml-auto pl-3 text-popover-foreground">{money(month[series.key])}</span>
                        </span>
                      ))}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
          {peak === 0 && (
            <p className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">Nothing posted in these months.</p>
          )}
        </div>
        <div />
        <div aria-hidden className="mt-2 flex gap-2 sm:gap-3">
          {months.map((month) => (
            <span key={month.label} className="flex min-w-0 flex-1 justify-center">
              <span className="w-full max-w-10 truncate text-center type-meta font-medium text-muted-foreground">{month.label}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-4 type-meta font-medium text-muted-foreground">
        {SERIES.map((series) => (
          <span key={series.key} className="inline-flex items-center gap-2">
            <i className="size-2.5 rounded-[3px]" style={{ background: series.color }} /> {series.label}
          </span>
        ))}
      </div>
    </figure>
  );
}

export function LockedStat({ label }: { label: string }) {
  return (
    <div className="glass relative overflow-hidden p-5">
      <p className="eyebrow">{label}</p>
      <div aria-hidden className="mt-4 flex items-end gap-1.5">
        <span className="h-7 w-20 rounded-md bg-muted" />
        <span className="h-4 w-10 rounded-md bg-muted" />
      </div>
      <p className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Lock className="size-3" aria-hidden /> Pro
      </p>
    </div>
  );
}
