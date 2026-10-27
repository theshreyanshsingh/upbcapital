import { money } from "@/lib/format";

export type StrataRow = { label: string; count: number; upb: number; share: number };

export function StrataPanel({
  count,
  totalUpb,
  wac,
  waltv,
  weightedDelinquency,
  groups,
  exportBase,
}: {
  count: number;
  totalUpb: number;
  wac: number;
  waltv: number;
  weightedDelinquency: number;
  groups: { title: string; rows: StrataRow[] }[];
  exportBase: string;
}) {
  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Tape analytics</p>
          <h2 className="mt-2 font-semibold tracking-tight text-lg text-foreground">{count} loans · {money(totalUpb)} UPB</h2>
        </div>
        <div className="flex gap-3">
          <a className="text-[13px] font-medium text-link" href={`${exportBase}?format=csv`}>CSV</a>
          <a className="text-[13px] font-medium text-link" href={`${exportBase}?format=xlsx`}>Excel</a>
        </div>
      </div>
      <dl className="mt-5 grid gap-px bg-muted sm:grid-cols-3">
        <Stat k="WAC" v={`${wac.toFixed(2)}%`} />
        <Stat k="Weighted LTV" v={`${waltv.toFixed(1)}%`} />
        <Stat k="Weighted months delinquent" v={weightedDelinquency.toFixed(1)} />
      </dl>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {groups.map((group) => (
          <article key={group.title} className="glass p-5">
            <p className="eyebrow">{group.title}</p>
            <div className="mt-4 space-y-3">
              {group.rows.map((row) => (
                <div key={row.label}>
                  <div className="flex justify-between gap-3 text-sm">
                    <span className="text-foreground">{row.label}</span>
                    <span className="text-muted-foreground">{row.count} · {row.share.toFixed(0)}%</span>
                  </div>
                  <div className="mt-1 h-1.5 bg-muted/60">
                    <div className="h-full bg-primary rounded-lg" style={{ width: `${Math.max(2, row.share)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="bg-card/80 px-4 py-3">
      <dt className="text-xs font-medium text-muted-foreground">{k}</dt>
      <dd className="mt-1 font-semibold tracking-tight text-3xl text-foreground">{v}</dd>
    </div>
  );
}
