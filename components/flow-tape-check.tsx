"use client";

import { useEffect, useRef, useState } from "react";
import { checkFlowTape, type TapeCheck } from "@/actions/flow";

// On the tape wizard's confirm step for a programme's tranche: the loans outside the programme's criteria, before
// the seller submits. A flag doesn't stop the tranche; the desk sees it too.
export function FlowTapeCheck({ program, check }: { program: { id: string; name: string }; check: Omit<TapeCheck, "programId"> }) {
  const [state, setState] = useState<{ loading: boolean; error: string | null; loans: number; flagged: number; lines: string[] }>({ loading: true, error: null, loans: 0, flagged: 0, lines: [] });
  // Only the latest check lands.
  const latest = useRef(0);
  const key = JSON.stringify(check);

  useEffect(() => {
    const id = ++latest.current;
    setState((current) => ({ ...current, loading: true }));
    checkFlowTape({ programId: program.id, ...(JSON.parse(key) as Omit<TapeCheck, "programId">) })
      .then((result) => {
        if (id === latest.current) setState({ loading: false, ...result });
      })
      .catch(() => {
        if (id === latest.current) setState({ loading: false, error: "The criteria check is unavailable right now. You can still submit.", loans: 0, flagged: 0, lines: [] });
      });
  }, [program.id, key]);

  return (
    <div className="mt-6 rounded-xl border border-border p-4" aria-live="polite">
      <p className="eyebrow">Tranche of {program.name}</p>
      {state.loading ? (
        <p className="mt-2 text-sm text-muted-foreground">Checking the loans against the programme&apos;s criteria…</p>
      ) : state.error ? (
        <p className="mt-2 text-sm text-foreground">{state.error}</p>
      ) : state.flagged === 0 ? (
        <p className="mt-2 text-sm text-foreground">All {state.loans} loans fit the programme&apos;s criteria.</p>
      ) : (
        <>
          <p className="mt-2 text-sm text-foreground">
            {state.flagged} of {state.loans} loans sit outside the programme&apos;s criteria. You can still submit, and the desk sees the flags in review.
          </p>
          <ul className="mt-2 space-y-1 text-sm text-bad">
            {state.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {state.flagged > state.lines.length && <p className="mt-1 text-xs text-muted-foreground">And {state.flagged - state.lines.length} more.</p>}
        </>
      )}
    </div>
  );
}
