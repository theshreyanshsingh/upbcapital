import { PROVENANCE_VERSION, STATEMENT_NOTE, statementText, type StatementKind } from "@/lib/provenance-rules";

// The seller's ownership statement as a required checkbox. Ticked, it sends the wording's version, which the server
// records with who gave it and when (lib/provenance.ts). In a plain form it is uncontrolled; a wizard that builds its
// own form data passes checked and onChange.
export function OwnershipStatement({
  kind = "SELLER",
  checked,
  onChange,
  className = "",
}: {
  kind?: StatementKind;
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  className?: string;
}) {
  const controlled = onChange ? { checked: Boolean(checked), onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.checked) } : {};
  return (
    <label className={`flex items-start gap-3 text-sm text-foreground ${className}`}>
      <input type="checkbox" name="ownership" value={PROVENANCE_VERSION} required className="mt-1 shrink-0" {...controlled} />
      <span>
        <span className="font-medium">Ownership statement.</span> {statementText(kind)}
        <span className="mt-1 block text-xs text-muted-foreground">{STATEMENT_NOTE}</span>
      </span>
    </label>
  );
}
