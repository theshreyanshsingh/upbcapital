import type { ChangeEntry } from "@/lib/discrepancies";

// The tape's dated change log for buyers: where the desk's reading of a document differed from the tape, and how
// it was answered. The entries arrive already veiled for this viewer by changeLog().
export function DiscrepancyLog({ entries }: { entries: ChangeEntry[] }) {
  if (!entries.length) return null;
  return (
    <div className="mt-8">
      <h3 className="text-[13px] font-medium text-foreground">Tape changes and differences</h3>
      <p className="mt-1 text-xs text-muted-foreground">Where the desk read a document and it differed from the tape, with the answer and its date.</p>
      <ul className="mt-2 divide-y divide-border text-sm">
        {entries.map((entry) => (
          <li key={entry.id} className="py-2">
            <p className={entry.status === "OPEN" ? "text-warn tabular-nums" : "text-foreground tabular-nums"}>{entry.text}</p>
            {entry.note && (
              <p className="mt-1 text-xs text-muted-foreground">
                {entry.note.by === "Seller" ? "Seller explained" : "Desk note"}: {entry.note.text}
              </p>
            )}
            {entry.noteGate && <p className="mt-1 text-xs text-muted-foreground">{entry.noteGate}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
