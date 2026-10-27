import { cn } from "@/lib/utils";
import { labelOf } from "@/lib/labels";

const tones: Record<string, string> = {
  APPROVED: "bg-good/10 text-good",
  SOLD: "bg-muted text-muted-foreground",
  PENDING: "bg-warn/12 text-warn",
  REJECTED: "bg-bad/10 text-bad",
  CHANGES_REQUESTED: "bg-warn/12 text-warn",
  UNDER_REVIEW: "bg-link/10 text-link",
  SUBMITTED: "bg-muted text-muted-foreground",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold", tones[status] ?? tones.SUBMITTED)}>
      {labelOf("status", status)}
    </span>
  );
}
