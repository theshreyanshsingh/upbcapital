import Link from "next/link";

// An ink tile with the serif U, and the name in Inter. The serif ties the mark to the page titles.
export function Logo({ compact = false, href = "/" }: { compact?: boolean; href?: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-2 rounded-md">
      <span aria-hidden className="grid size-6 place-items-center rounded-[7px] bg-primary pb-px font-display text-[15px] leading-none font-semibold text-primary-foreground shadow-card">
        U
      </span>
      {compact ? (
        <span className="sr-only">UPB Capital</span>
      ) : (
        <span className="text-[15px] font-semibold tracking-[-0.015em] text-foreground">UPB Capital</span>
      )}
    </Link>
  );
}
