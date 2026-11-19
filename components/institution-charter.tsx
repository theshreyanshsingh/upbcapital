import { charterLine, charterLookup, isInstitution } from "@/lib/institutions";

// A bank's or credit union's charter as the desk reviews it (lib/institutions.ts): the number and regulator the buyer
// gave, with a link to the regulator's public record. The link is built from the number and opens in the reviewer's
// own browser; UPB never fetches it.

type CharterFile = { entityType: string; charterNumber?: string | null; regulator?: string | null };

export function CharterReview({ file }: { file: CharterFile }) {
  if (!isInstitution(file.entityType)) return null;
  const lookup = charterLookup(file);
  return (
    <p className="mt-1 break-words text-sm text-foreground">
      <span className="tabular-nums">{charterLine(file)}</span>
      {lookup && (
        <>
          {" · "}
          <a href={lookup.href} target="_blank" rel="noopener noreferrer" className="font-medium text-link">
            Check on {lookup.label}
          </a>
        </>
      )}
    </p>
  );
}

// Inside an approval form: the reviewer says they checked the charter. Approval refuses a bank or credit union without it.
export function CharterCheck({ file }: { file: CharterFile }) {
  if (!isInstitution(file.entityType)) return null;
  return (
    <label className="flex min-h-10 w-full items-start gap-3 text-sm text-foreground">
      <input type="checkbox" name="charterChecked" value="yes" className="mt-1 size-4 shrink-0" />
      <span className="min-w-0">I checked this charter number and regulator on the regulator&apos;s public record, for approval.</span>
    </label>
  );
}
