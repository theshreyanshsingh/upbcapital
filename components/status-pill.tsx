import { cn } from "@/lib/utils";
import { labelOf } from "@/lib/labels";

// The word carries the meaning; the tint and the dot only echo it, so nothing rests on colour alone.
const tones: Record<string, string> = {
  APPROVED: "bg-good/10 text-good",
  SOLD: "bg-muted text-muted-foreground",
  PENDING: "bg-warn/12 text-warn",
  REJECTED: "bg-bad/10 text-bad",
  CHANGES_REQUESTED: "bg-warn/12 text-warn",
  UNDER_REVIEW: "bg-link/10 text-link",
  SUBMITTED: "bg-muted text-muted-foreground",
  WITHDRAWN: "bg-muted text-muted-foreground",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={cn("figure inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap", tones[status] ?? tones.SUBMITTED)}>
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
      {labelOf("status", status)}
    </span>
  );
}
