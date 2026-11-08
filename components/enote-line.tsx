import { eNoteSummary } from "@/lib/enotes";

// On a listing with eNotes: how they move at closing, so a buyer knows there is no original to courier and what the
// seller will ask for. lib/enotes.ts.
export function ENoteLine({ notes }: { notes: object[] }) {
  const summary = eNoteSummary(notes);
  if (!summary) return null;
  return (
    <section aria-label="eNote" className="mt-8 rounded-xl border border-link/30 bg-link/5 p-5">
      <p className="text-sm font-semibold text-foreground">{summary.title}</p>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{summary.text}</p>
    </section>
  );
}
