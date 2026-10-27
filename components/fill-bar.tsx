import { money } from "@/lib/format";

export function FillBar({ filled, target, label }: { filled: number; target: number; label?: string }) {
  const pct = target > 0 ? Math.min(100, (filled / target) * 100) : 0;
  const left = Math.max(0, target - filled);
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <p className="text-foreground">{label || `${money(filled)} pledged`}</p>
        <p className="text-muted-foreground">{money(left)} left · {pct.toFixed(0)}%</p>
      </div>
      <div className="mt-3 h-2 bg-muted" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Group fill">
        <div className="h-full bg-primary rounded-lg" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
