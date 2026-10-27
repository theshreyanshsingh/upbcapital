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
