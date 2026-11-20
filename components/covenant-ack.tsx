import type { BidCovenants } from "@/lib/covenants";

// The acknowledgement's words, the same in every form that asks for it.
export const COVENANT_ACK_LABEL = "I've read the covenants that pass with these loans and will service to them.";

const WITHHELD = "This text names the borrower, so it shows once the data room opens to you, like the street.";

// The covenants a bid's loans carry, in full, and the box that acknowledges them, inside the bid's own form. The box's
// value names the version shown, so a change since the page loaded is caught when the bid arrives. A text withheld
// from this buyer can't be acknowledged, so the box gives way to the reason. `fold` tucks the text into a disclosure
// for the pool table's narrow bid boxes. lib/covenants.ts.
export function CovenantAck({ covenants, fold = false }: { covenants: BidCovenants | null | undefined; fold?: boolean }) {
  if (!covenants?.loans.length) return null;
  const list = (
    <ul className="mt-2 max-h-56 space-y-2 overflow-y-auto pr-1 text-xs leading-relaxed">
      {covenants.loans.map((loan) => (
        <li key={loan.noteId} className="min-w-0">
          <p className="break-words font-medium text-foreground">
            {loan.label} <span className="font-normal text-muted-foreground">· {loan.verified ? "Desk-verified" : "Seller-stated"}</span>
          </p>
          <p className={loan.text == null ? "mt-0.5 text-muted-foreground" : "mt-0.5 whitespace-pre-line break-words text-foreground"}>{loan.text ?? WITHHELD}</p>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="min-w-0 rounded-lg border border-border bg-muted/30 p-3 text-left whitespace-normal">
      {fold ? (
        <details>
          <summary className="cursor-pointer text-xs font-medium text-foreground pointer-coarse:min-h-10">
            Read the covenants that pass with {covenants.loans.length === 1 ? "this loan" : `these ${covenants.loans.length} loans`}
          </summary>
          {list}
        </details>
      ) : (
        <>
          <p className="text-[13px] font-medium text-foreground">Covenants that pass with {covenants.loans.length === 1 ? "this loan" : "these loans"}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{covenants.summary} UPB reads them as binding the buyer once it owns the loans; counsel to confirm.</p>
          {list}
        </>
      )}
      {covenants.hash ? (
        <label className="mt-3 flex items-start gap-2.5 text-xs leading-relaxed text-foreground pointer-coarse:min-h-10">
          <input type="checkbox" name="covenantsAck" value={covenants.hash} required className="mt-0.5 size-4 shrink-0" />
          <span>{COVENANT_ACK_LABEL}</span>
        </label>
      ) : (
        <p className="mt-3 text-xs leading-relaxed text-foreground">Sign the confidentiality agreement to read every covenant here before you bid.</p>
      )}
    </div>
  );
}
