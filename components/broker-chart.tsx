export function EarningsChart({
  months,
}: {
  months: { label: string; paid: number; owed: number }[];
}) {
  const max = Math.max(...months.map((month) => month.paid + month.owed), 1);
  const width = 640;
  const height = 210;
  const bar = 28;
  const gap = (width - 48) / months.length;
  const base = 168;
  const empty = months.every((month) => month.paid + month.owed === 0);
  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-48 w-full md:h-56" role="img" aria-label="Fees by month, paid in dark bars and still owed in light bars">
        <line x1="16" y1={base} x2={width - 16} y2={base} stroke="var(--border)" />
        {months.map((month, index) => {
          const paid = (month.paid / max) * 140;
          const owed = (month.owed / max) * 140;
          const x = 28 + index * gap;
          return (
            <g key={`${month.label}-${index}`}>
              <rect x={x} y={base - paid - owed} width={bar} height={Math.max(owed, 0)} fill="var(--chart-1)" opacity="0.18" />
              <rect x={x} y={base - paid} width={bar} height={Math.max(paid, 0)} fill="var(--chart-1)" />
              <text x={x + bar / 2} y="192" textAnchor="middle" fill="var(--muted-foreground)" fontSize="12" fontFamily="inherit">
                {month.label}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex gap-5 text-xs font-medium text-muted-foreground">
        <span className="inline-flex items-center gap-2"><i className="inline-block size-2 rounded-full bg-primary" /> Paid</span>
        <span className="inline-flex items-center gap-2"><i className="inline-block size-2 rounded-full bg-primary/20" /> Still owed</span>
      </div>
      {empty && <p className="mt-3 text-sm text-muted-foreground">The first close draws a bar. Until then the axis stays quiet.</p>}
    </div>
  );
}
