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
        <svg viewBox="0 0 120 120" className="size-24">
          <circle cx="60" cy="60" r={radius} fill="none" stroke="var(--border)" strokeWidth="6" />
          <circle
            cx="60"
            cy="60"
            r={radius}
            fill="none"
            stroke="var(--chart-1)"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circ - dash}`}
            transform="rotate(-90 60 60)"
          />
        </svg>
        <div className="absolute inset-0 grid place-items-center font-semibold tracking-tight text-2xl text-foreground">
          {shown == null ? "—" : shown.toFixed(0)}
        </div>
      </div>
      <div>
        <p className="eyebrow">{label}</p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{caption}</p>
      </div>
    </div>
  );
}

export function CapitalStack({
  value,
  upb,
  price,
}: {
  value: number;
  upb: number;
  price: number;
}) {
  const max = Math.max(value, upb, price, 1);
  const rows = [
    { label: "Property value", amount: value, width: (value / max) * 100, color: "bg-foreground/70" },
    { label: "Unpaid principal", amount: upb, width: (upb / max) * 100, color: "bg-good" },
    { label: "Asking price", amount: price, width: (price / max) * 100, color: "bg-primary" },
  ];
  return (
    <div className="space-y-4">
      {rows.map((row) => (
        <div key={row.label}>
          <div className="mb-1 flex justify-between text-[13px] font-medium text-muted-foreground">
            <span>{row.label}</span>
            <span className="text-foreground">{row.amount.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className={`h-full ${row.color}`} style={{ width: `${row.width}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Donut({
  slices,
}: {
  slices: { label: string; value: number; color: string }[];
}) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0) || 1;
  const radius = 56;
  const circ = 2 * Math.PI * radius;
  let acc = 0;
  return (
    <div className="flex items-center gap-6">
      <svg viewBox="0 0 160 160" className="size-36">
        {slices.map((slice) => {
          const len = (slice.value / total) * circ;
          const element = (
            <circle
              key={slice.label}
              cx="80"
              cy="80"
              r={radius}
              fill="none"
              stroke={slice.color}
              strokeWidth="14"
              strokeDasharray={`${len} ${circ - len}`}
              strokeDashoffset={-acc}
              transform="rotate(-90 80 80)"
            />
          );
          acc += len;
          return element;
        })}
      </svg>
      <ul className="space-y-2 text-sm">
        {slices.map((slice) => (
          <li key={slice.label} className="flex items-center gap-2 text-muted-foreground">
            <span className="size-2" style={{ background: slice.color }} />
            {slice.label}
            <span className="text-foreground">{Math.round((slice.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HorizontalBars({
  rows,
}: {
  rows: { label: string; value: number }[];
}) {
  const max = Math.max(...rows.map((row) => row.value), 1);
  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div key={row.label} className="grid grid-cols-[72px_1fr_auto] items-center gap-3 text-sm">
          <span className="text-muted-foreground">{row.label}</span>
          <div className="h-1.5 bg-muted/60">
            <div className="h-full bg-primary rounded-lg" style={{ width: `${(row.value / max) * 100}%` }} />
          </div>
          <span className="tabular-nums text-foreground">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

export function RevenueBars({
  months,
}: {
  months: { label: string; premium: number; commission: number; subscription: number }[];
}) {
  const max = Math.max(...months.map((month) => month.premium + month.commission + month.subscription), 1);
  return (
    <div>
      <div className="flex h-48 items-end gap-3">
        {months.map((month) => {
          const total = month.premium + month.commission + month.subscription;
          return (
            <div key={month.label} className="flex flex-1 flex-col items-center gap-2">
              <div className="flex h-40 w-full max-w-10 flex-col justify-end">
                {total > 0 && (
                  <>
                    <div className="bg-good" style={{ height: `${(month.subscription / max) * 100}%` }} />
                    <div className="bg-foreground/80" style={{ height: `${(month.commission / max) * 100}%` }} />
                    <div className="bg-primary rounded-lg" style={{ height: `${(month.premium / max) * 100}%` }} />
                  </>
                )}
              </div>
              <span className="text-xs font-medium text-muted-foreground">{month.label}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap gap-4 text-xs font-medium text-muted-foreground">
        <span className="inline-flex items-center gap-2"><i className="size-2 bg-primary rounded-lg" /> Premium</span>
        <span className="inline-flex items-center gap-2"><i className="size-2 bg-foreground/80" /> Commission</span>
        <span className="inline-flex items-center gap-2"><i className="size-2 bg-good" /> Subscription</span>
      </div>
    </div>
  );
}

export function LockedStat({ label }: { label: string }) {
  return (
    <div className="glass relative overflow-hidden p-5">
      <p className="eyebrow">{label}</p>
      <div className="mt-4 h-10 w-36 bg-gradient-to-r from-link/10 via-link/40 to-link/10 blur-[3px]" />
      <p className="mt-3 text-xs font-medium text-link">Pro</p>
    </div>
  );
}
