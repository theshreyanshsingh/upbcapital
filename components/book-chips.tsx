import Link from "next/link";
import { Check, X } from "lucide-react";

export type Chip = { label: string; count: number; on: boolean; href: string };
export type ChipGroup = { label: string; chips: Chip[] };

// The filters buyers reach for first, one tap each, with how many listings each would leave. Picking two in a
// group shows either. The applied row underneath takes any filter off again. On a phone each row is one line
// that scrolls sideways under a thumb, edge to edge. Each row is relative, so the screen-reader text inside its
// chips is clipped with them rather than widening the page.
export function BookChips({ groups, applied, clearHref }: { groups: ChipGroup[]; applied: { label: string; href: string }[]; clearHref: string }) {
  return (
    <div className="mt-4 space-y-3">
      <div className="relative flex items-center gap-x-5 gap-y-2 max-md:-mx-4 max-md:no-scrollbar max-md:overflow-x-auto max-md:overscroll-x-contain max-md:px-4 md:flex-wrap">
        {groups.filter((group) => group.chips.length > 0).map((group) => (
          <div key={group.label} role="group" aria-label={group.label} className="flex shrink-0 items-center gap-1.5 md:flex-wrap">
            <span className="mr-1 shrink-0 text-xs font-medium text-muted-foreground">{group.label}</span>
            {group.chips.map((chip) => (
              <Link
                key={chip.label}
                href={chip.href}
                className={`inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium whitespace-nowrap transition-[scale] duration-(--dur-1) active:scale-95 pointer-coarse:min-h-10 pointer-coarse:px-3.5 ${chip.on ? "border-link/40 bg-link/10 text-link" : "border-border bg-card text-foreground hover:border-foreground/30"}`}
              >
                {chip.on && <Check aria-hidden="true" className="size-3.5" />}
                {chip.label}
                <span className="text-xs text-muted-foreground tabular-nums">{chip.count}</span>
                <span className="sr-only">{chip.on ? " listings, on. Select to take it off." : " listings."}</span>
              </Link>
            ))}
          </div>
        ))}
      </div>
      {applied.length > 0 && (
        <div className="relative flex items-center gap-1.5 max-md:-mx-4 max-md:no-scrollbar max-md:overflow-x-auto max-md:px-4 md:flex-wrap">
          <span className="mr-1 shrink-0 text-xs font-medium text-muted-foreground">Applied</span>
          {applied.map((chip) => (
            <Link key={chip.label} href={chip.href} className="inline-flex min-h-7 shrink-0 items-center gap-1 rounded-full bg-muted px-2.5 text-xs font-medium whitespace-nowrap text-foreground hover:bg-muted/70 pointer-coarse:min-h-9 pointer-coarse:px-3">
              {chip.label}
              <X aria-hidden="true" className="size-3" />
              <span className="sr-only">, remove</span>
            </Link>
          ))}
          <Link href={clearHref} className="ml-1 inline-flex min-h-7 shrink-0 items-center text-xs font-medium whitespace-nowrap text-link pointer-coarse:min-h-9 pointer-coarse:px-1">Clear all</Link>
        </div>
      )}
    </div>
  );
}
