import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  BOARD_METRICS,
  BOARD_TILES,
  COHORT_LABELS,
  boardDefinitions,
  boardMetric,
  formatMetric,
  metricChange,
  metricValue,
  monthLabel,
  monthShort,
  shiftMonth,
  type BoardDifference,
  type BoardPack,
  type MetricChange,
} from "@/lib/board-pack";

// The board pack's pieces for /admin/board: headline tiles, one small table per section, the buyer cohorts and the
// definitions. A locked month passes the figures a live recount now puts differently, and each is marked where it shows.

type Differences = Map<string, BoardDifference>;

const arrows = { up: "▲", down: "▼", flat: "▬" } as const;
const tones = { good: "text-good", bad: "text-bad", neutral: "text-muted-foreground" } as const;

function Change({ change }: { change: MetricChange | null }) {
  if (!change) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={`figure inline-flex items-center gap-1 whitespace-nowrap ${tones[change.tone]}`}>
      <span aria-hidden className="text-[0.625rem]">{arrows[change.direction]}</span>
      {change.text}
    </span>
  );
}

function Recount({ difference, format }: { difference: BoardDifference | undefined; format: (value: number | null) => string }) {
  if (!difference) return null;
  return <span className="mt-0.5 block text-xs font-normal whitespace-normal text-warn">Recount {format(difference.live)}</span>;
}

export function BoardTiles({ pack, differences }: { pack: BoardPack; differences: Differences }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4" aria-label={`Headline figures, ${monthLabel(pack.month)}`}>
      {BOARD_TILES.map((key) => {
        const metric = boardMetric(key)!;
        const value = metricValue(pack.current, key);
        const prior = metricValue(pack.prior, key);
        return (
          <li key={key} className="glass @container p-4 sm:p-5">
            <p className="eyebrow">{metric.label}</p>
            {/* Sized to the tile, so a long figure shrinks to fit on a phone rather than overflowing. */}
            <p className="figure mt-2 text-[clamp(1.125rem,13cqi,1.75rem)] leading-tight font-semibold tracking-tight whitespace-nowrap text-foreground">{formatMetric(metric, value)}</p>
            <p className="mt-1.5 text-[0.8125rem] font-medium">
              <Change change={metricChange(metric, value, prior)} />
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {monthShort(shiftMonth(pack.month, -1))}: {formatMetric(metric, prior)}
            </p>
            <Recount difference={differences.get(key)} format={(live) => formatMetric(metric, live)} />
          </li>
        );
      })}
    </ul>
  );
}

export function BoardSection({ section, pack, differences }: { section: string; pack: BoardPack; differences: Differences }) {
  const id = `board-${section.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  const prior = monthShort(shiftMonth(pack.month, -1));
  return (
    <section aria-labelledby={id} className="mt-8">
      <h2 id={id} className="eyebrow">{section}</h2>
      <div className="mt-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Figure</TableHead>
              <TableHead numeric>{monthShort(pack.month)}</TableHead>
              <TableHead numeric className="hidden sm:table-cell">{prior}{pack.priorLocked ? ", locked" : ""}</TableHead>
              <TableHead numeric>Change</TableHead>
              <TableHead numeric className="hidden sm:table-cell">3 months</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {BOARD_METRICS.filter((metric) => metric.section === section).map((metric) => {
              const value = metricValue(pack.current, metric.key);
              const before = metricValue(pack.prior, metric.key);
              return (
                <TableRow key={metric.key}>
                  <TableCell className="text-foreground">{metric.label}</TableCell>
                  <TableCell numeric className="font-medium text-foreground">
                    {formatMetric(metric, value)}
                    <Recount difference={differences.get(metric.key)} format={(live) => formatMetric(metric, live)} />
                  </TableCell>
                  <TableCell numeric className="hidden text-muted-foreground sm:table-cell">{formatMetric(metric, before)}</TableCell>
                  <TableCell numeric className="text-[0.8125rem]"><Change change={metricChange(metric, value, before)} /></TableCell>
                  <TableCell numeric className="hidden text-muted-foreground sm:table-cell">{metric.stock ? "—" : formatMetric(metric, metricValue(pack.trailing, metric.key))}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

export function BoardCohorts({ pack, differences }: { pack: BoardPack; differences: Differences }) {
  const fields = ["signedUp", "everBid", "bidThisMonth"] as const;
  // Short heads, and "have bid" left to a wider screen, so the table fits a phone without scrolling.
  const heads = { signedUp: "Buyers", everBid: COHORT_LABELS.everBid, bidThisMonth: `Bid in ${monthShort(pack.month).split(" ")[0]}` };
  const wide = (field: (typeof fields)[number]) => (field === "everBid" ? "hidden sm:table-cell" : undefined);
  return (
    <section aria-labelledby="board-cohorts" className="mt-8">
      <h2 id="board-cohorts" className="eyebrow">Buyer retention by signup month</h2>
      <p className="mt-1.5 text-sm text-muted-foreground">Buyers who signed up in each of the six months before {monthLabel(pack.month)}, and how many bid in it.</p>
      <div className="mt-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Signed up in</TableHead>
              {fields.map((field) => <TableHead key={field} numeric className={wide(field)}>{heads[field]}</TableHead>)}
              <TableHead numeric>Retention</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pack.cohorts.map((cohort) => (
              <TableRow key={cohort.month}>
                <TableCell className="whitespace-nowrap text-foreground">{monthShort(cohort.month)}</TableCell>
                {fields.map((field) => (
                  <TableCell key={field} numeric className={wide(field)}>
                    {cohort[field].toLocaleString("en-US")}
                    <Recount difference={differences.get(`cohort.${cohort.month}.${field}`)} format={(live) => (live == null ? "—" : live.toLocaleString("en-US"))} />
                  </TableCell>
                ))}
                <TableCell numeric className="font-medium text-foreground">{cohort.retention == null ? "—" : `${(cohort.retention * 100).toFixed(1)}%`}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

export function BoardDefinitions({ demoAccounts }: { demoAccounts: number }) {
  return (
    <section id="definitions" aria-labelledby="board-definitions" className="mt-12 scroll-mt-6">
      <h2 id="board-definitions" className="eyebrow">Definitions</h2>
      <div className="mt-4 grid gap-8 lg:grid-cols-2">
        {boardDefinitions(demoAccounts).map((group) => (
          <div key={group.section}>
            <h3 className="text-sm font-semibold text-foreground">{group.section}</h3>
            <dl className="mt-2 space-y-3">
              {group.items.map((item) => (
                <div key={item.term}>
                  <dt className="text-[13px] font-medium text-foreground">{item.term}</dt>
                  <dd className="mt-0.5 text-sm leading-relaxed text-pretty text-muted-foreground">{item.text}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </section>
  );
}
