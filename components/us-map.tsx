import { projectUs } from "@/lib/enrichment";

export type MapPin = {
  id: string;
  title: string;
  href?: string;
  latitude: number;
  longitude: number;
};

export function UsMap({ pins, label }: { pins: MapPin[]; label: string }) {
  return (
    <div className="border border-border bg-card rounded-xl">
      <svg viewBox="0 0 1000 560" role="img" aria-label={label} className="h-auto w-full">
        <rect width="1000" height="560" fill="var(--card)" />
        <text x="36" y="42" fill="var(--foreground)" fontSize="14" fontWeight="600">
          Continental book
        </text>
        <text x="36" y="64" fill="var(--muted-foreground)" fontSize="12">
          Pins sit on a city estimate. This is not a survey.
        </text>
        {pins.map((pin) => {
          const point = projectUs(pin.latitude, pin.longitude);
          const dot = (
            <g key={pin.id}>
              <circle cx={point.x} cy={point.y} r="10" fill="var(--link)" opacity="0.18" />
              <circle cx={point.x} cy={point.y} r="4.5" fill="var(--link)" />
              <title>{pin.title}</title>
            </g>
          );
          if (!pin.href) return dot;
          return (
            <a key={pin.id} href={pin.href} aria-label={pin.title}>
              {dot}
            </a>
          );
        })}
        {pins.length === 0 && (
          <text x="36" y="280" fill="var(--muted-foreground)" fontSize="16">
            No coordinates on this slice yet.
          </text>
        )}
      </svg>
    </div>
  );
}

// One square per state, placed roughly where the state sits. Notes are screened on state law, not on streets,
// so the book counts listings by state instead of pinning them.
export const STATE_TILES: Record<string, [row: number, col: number]> = {
  AK: [0, 0], ME: [0, 11],
  WI: [1, 6], VT: [1, 10], NH: [1, 11],
  WA: [2, 1], ID: [2, 2], MT: [2, 3], ND: [2, 4], MN: [2, 5], IL: [2, 6], MI: [2, 7], NY: [2, 9], MA: [2, 10],
  OR: [3, 1], NV: [3, 2], WY: [3, 3], SD: [3, 4], IA: [3, 5], IN: [3, 6], OH: [3, 7], PA: [3, 8], NJ: [3, 9], CT: [3, 10], RI: [3, 11],
  CA: [4, 1], UT: [4, 2], CO: [4, 3], NE: [4, 4], MO: [4, 5], KY: [4, 6], WV: [4, 7], VA: [4, 8], MD: [4, 9], DE: [4, 10],
  AZ: [5, 2], NM: [5, 3], KS: [5, 4], AR: [5, 5], TN: [5, 6], NC: [5, 7], SC: [5, 8], DC: [5, 9],
  OK: [6, 4], LA: [6, 5], MS: [6, 6], AL: [6, 7], GA: [6, 8],
  HI: [7, 0], TX: [7, 4], FL: [7, 8],
};

export type StateCell = {
  state: string;
  count: number;
  href?: string;
  selected?: boolean;
  // Judicial foreclosure, where the desk's foreclosure table has the state. Unknown states carry no mark.
  judicial?: boolean;
};

const TILE = 76;
const GAP = 6;
const TOP = 70;
// Shade steps, as opacity of the link colour. The darkest step flips its text to the card colour for contrast.
const STEPS = [0.14, 0.3, 0.55, 1];

function step(count: number, max: number) {
  if (count <= 0 || max <= 0) return -1;
  return Math.min(STEPS.length - 1, Math.ceil((count / max) * STEPS.length) - 1);
}

export function StateMap({ label, cells, unit = "listing" }: { label: string; cells: StateCell[]; unit?: string }) {
  const byState = new Map(cells.map((cell) => [cell.state, cell]));
  const max = Math.max(0, ...cells.map((cell) => cell.count));
  const width = 12 * (TILE + GAP) + 40;
  const height = TOP + 8 * (TILE + GAP) + 20;
  const plural = (count: number) => `${count} ${unit}${count === 1 ? "" : "s"}`;
  return (
    <div className="border border-border bg-card rounded-xl">
      <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label={label} className="h-auto w-full">
        <text x="20" y="30" fill="var(--foreground)" fontSize="15" fontWeight="600">
          Listings by state
        </text>
        <text x="20" y="52" fill="var(--muted-foreground)" fontSize="12">
          Darker means more {unit}s. ◆ marks a judicial foreclosure state. A pool counts in each state it lends in.
        </text>
        {Object.entries(STATE_TILES).map(([state, [row, col]]) => {
          const cell = byState.get(state);
          const count = cell?.count ?? 0;
          const shade = step(count, max);
          const x = 20 + col * (TILE + GAP);
          const y = TOP + row * (TILE + GAP);
          const ink = shade === STEPS.length - 1 ? "var(--card)" : count ? "var(--foreground)" : "var(--muted-foreground)";
          const name = `${state}: ${plural(count)}${cell?.judicial ? ", judicial foreclosure" : ""}${cell?.selected ? ", selected" : ""}`;
          const tile = (
            <g>
              <rect x={x} y={y} width={TILE} height={TILE} rx="10" fill="var(--muted)" />
              {shade >= 0 && <rect x={x} y={y} width={TILE} height={TILE} rx="10" fill="var(--link)" fillOpacity={STEPS[shade]} />}
              {cell?.selected && <rect x={x + 2} y={y + 2} width={TILE - 4} height={TILE - 4} rx="9" fill="none" stroke="var(--foreground)" strokeWidth="3" />}
              <text x={x + 10} y={y + 24} fill={ink} fontSize="15" fontWeight="600">
                {state}{cell?.judicial ? " ◆" : ""}
              </text>
              <text x={x + 10} y={y + 60} fill={ink} fontSize="20" fontWeight="600" style={{ fontVariantNumeric: "tabular-nums" }}>
                {count || ""}
              </text>
              <title>{name}</title>
            </g>
          );
          if (!count && !cell?.selected) return <g key={state} aria-hidden="true">{tile}</g>;
          if (!cell?.href) return <g key={state} role="img" aria-label={name}>{tile}</g>;
          return (
            <a key={state} href={cell.href} aria-label={name}>
              {tile}
            </a>
          );
        })}
      </svg>
    </div>
  );
}
