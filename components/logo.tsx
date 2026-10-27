import Link from "next/link";

export function Logo({ compact = false, href = "/" }: { compact?: boolean; href?: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-2">
      <span className="grid size-[22px] place-items-center rounded-[7px] bg-primary text-xs font-bold text-primary-foreground">U</span>
      {!compact && <span className="text-[15px] font-semibold tracking-tight text-foreground">UPB Capital</span>}
    </Link>
  );
}
