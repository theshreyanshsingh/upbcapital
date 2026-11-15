import { solExposure, type SolExposure } from "@/lib/statute-limits";
import { asksForPartialClaim, PARTIAL_CLAIM_ASK, partialClaimLine, type PartialClaimNote } from "@/lib/tape-fields";

// Tape v3's risk flags and the statute-of-limitations flag, as risk lines a buyer reads before the facts. The
// litigation note can name the borrower, so it follows the street address. A partial claim's balance follows Pro.

export type RiskNote = {
  state: string;
  paymentStatus: string;
  lastPaidDate?: Date | string | null;
  maturityDate?: Date | string | null;
  nextDueDate?: Date | string | null;
  scraFlag?: boolean | null;
  borrowerDeceased?: boolean | null;
  litigationFlag?: boolean | null;
  litigationNote?: string | null;
} & PartialClaimNote;

export type RiskLine = { key: "scra" | "deceased" | "litigation" | "partialClaim" | "partialClaimAsk"; title: string; text: string };

export function riskLines(note: RiskNote, open: boolean, pro = false): RiskLine[] {
  const lines: RiskLine[] = [];
  if (note.scraFlag) {
    lines.push({
      key: "scra",
      title: "SCRA protection",
      text: "The borrower is covered by the Servicemembers Civil Relief Act. On a mortgage from before service the rate is capped at 6%, and a foreclosure needs a court order during service and for a year after.",
    });
  }
  if (note.borrowerDeceased) {
    lines.push({ key: "deceased", title: "Borrower deceased", text: "Expect probate and heirs, which slow a workout or a foreclosure." });
  }
  if (note.litigationFlag) {
    const detail = note.litigationNote?.trim();
    lines.push({
      key: "litigation",
      title: "Litigation",
      text: `A case touches the loan or the property.${detail ? (open ? ` ${detail}` : " The details open with confidentiality.") : ""}`,
    });
  }
  const claim = partialClaimLine(note, pro);
  if (claim) lines.push({ key: "partialClaim", title: "Partial claim", text: claim });
  if (asksForPartialClaim(note)) {
    lines.push({
      key: "partialClaimAsk",
      title: "Partial claim not stated",
      text: `${note.loanProgram === "VA" ? "A VA" : "An FHA"} loan that was modified or caught up on its arrears may carry the agency's partial claim. ${PARTIAL_CLAIM_ASK}`,
    });
  }
  return lines;
}

// Shown on non-performing loans, where the time to sue matters to the price.
export function solFor(note: RiskNote, now = new Date()): SolExposure | null {
  if (note.paymentStatus !== "NON_PERFORMING") return null;
  return solExposure({ state: note.state, lastPaidDate: note.lastPaidDate, maturityDate: note.maturityDate, nextDueDate: note.nextDueDate, now });
}

export function TapeRisks({ note, open, now, pro = false }: { note: RiskNote; open: boolean; now?: Date; pro?: boolean }) {
  const lines = riskLines(note, open, pro);
  const sol = solFor(note, now);
  if (!lines.length && !sol) return null;
  return (
    <section aria-label="Risk flags" className="mt-8 space-y-3 rounded-xl border border-warn/40 bg-warn/10 p-5">
      <p className="eyebrow text-warn">Risk flags</p>
      {lines.map((line) => (
        <p key={line.key} className="text-sm leading-relaxed text-foreground">
          <span className="font-semibold">{line.title}.</span> {line.text}
        </p>
      ))}
      {sol && <SolBlock sol={sol} />}
    </section>
  );
}

function SolBlock({ sol }: { sol: SolExposure }) {
  return (
    <div className="space-y-2 border-t border-warn/30 pt-3 first:border-t-0 first:pt-0">
      <p className="text-sm font-semibold text-foreground">{sol.headline}</p>
      <p className="text-sm leading-relaxed text-foreground">{sol.summary}</p>
      {sol.lines.length > 0 && (
        <ul className="space-y-1 text-[13px] leading-relaxed text-muted-foreground">
          {sol.lines.map((line) => (
            <li key={`${line.kind}-${line.law}`}>{sol.name}: {line.text}</li>
          ))}
        </ul>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">{sol.caveat}</p>
    </div>
  );
}

// A pool's flags as counts, with each loan's lines in its own file.
export function PoolRisks({ notes, now }: { notes: RiskNote[]; now?: Date }) {
  const count = (test: (note: RiskNote) => boolean) => notes.filter(test).length;
  const scra = count((note) => Boolean(note.scraFlag));
  const deceased = count((note) => Boolean(note.borrowerDeceased));
  const litigation = count((note) => Boolean(note.litigationFlag));
  const claims = count((note) => note.partialClaim === true);
  const ask = count(asksForPartialClaim);
  const sol = notes.map((note) => solFor(note, now)).filter((row): row is SolExposure => row != null);
  const near = sol.filter((row) => row.status === "PAST" || row.status === "RUNNING_OUT").length;
  const lines = [
    scra && `${scra} of ${notes.length} loans carry SCRA protection.`,
    deceased && `${deceased} of ${notes.length} loans have a deceased borrower.`,
    litigation && `${litigation} of ${notes.length} loans are in litigation.`,
    claims && `${claims} of ${notes.length} loans carry an FHA or VA partial claim, which UPB reads as a subordinate lien due at payoff, sale or refinance. Each loan's file has the agency and the balance.`,
    ask && `${ask} FHA or VA ${ask === 1 ? "loan was" : "loans were"} modified or caught up without saying whether a partial claim was filed. ${PARTIAL_CLAIM_ASK}`,
    sol.length > 0 &&
      `${sol.length} non-performing ${sol.length === 1 ? "loan" : "loans"}${near ? `, ${near} where the time to sue may be running out or past` : ""}. SOL exposure: check with counsel. Each loan's file has the dates and basis.`,
  ].filter((line): line is string => Boolean(line));
  if (!lines.length) return null;
  return (
    <section aria-label="Risk flags" className="mt-8 space-y-2 rounded-xl border border-warn/40 bg-warn/10 p-5">
      <p className="eyebrow text-warn">Risk flags</p>
      {lines.map((line) => <p key={line} className="text-sm leading-relaxed text-foreground">{line}</p>)}
      {sol.length > 0 && <p className="text-xs text-muted-foreground">Not legal advice.</p>}
    </section>
  );
}
