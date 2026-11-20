// Whether a covenant's text names the borrower, the property or the loan, without database or server imports, so the
// tape and MISMO exports can apply the same rule the listing page does (lib/covenants.ts).
//
// A covenant is not an identity field: its substance (the servicing standard, a loss-mitigation duty) is what a buyer
// prices, so every buyer who can read the loan's facts reads it. But a seller sometimes writes the borrower, the
// property or the loan number into it ("Smith loan: modification agreed in 2024"). A text that carries one of the
// loan's identity fields follows the street's rule and shows only once the loan opens to the viewer. The whole text
// waits rather than a redacted copy, since a redaction that missed a spelling would leak.

// The loan file's identity fields worth looking for in a text (lib/loan-file.ts). The litigation note and the
// originator's licence are identity fields for what they may say, not identifiers to look for: a short phrase of
// either ("Quiet title", "Exempt") would match ordinary covenant wording. tests/covenants.test.ts keeps this list in
// step with the loan file.
export const COVENANT_IDENTITY_FIELDS = ["streetAddress", "borrowerName", "loanNumber", "mersMin", "eNoteId", "eRegistryController", "eRegistryLocation"] as const;

const NAME_NOISE = new Set(["mr", "mrs", "ms", "miss", "dr", "and", "the", "jr", "sr", "iii", "llc", "inc", "corp", "trust", "estate", "of"]);
const NAME_PLACEHOLDERS = new Set(["unknown", "none", "redacted", "withheld", "name", "borrower", "not", "provided", "tape", "see", "file"]);

const plainWords = (text: string) => ` ${text.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim()} `;
const compact = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, "");

function carries(text: string, field: string, value: unknown) {
  if (typeof value !== "string" || !value.trim()) return false;
  const words = plainWords(text);
  if (field === "borrowerName") {
    // Any word of the name that could pick the borrower out, as a whole word.
    return plainWords(value).trim().split(" ").some((word) => word.length >= 3 && !NAME_NOISE.has(word) && !NAME_PLACEHOLDERS.has(word) && words.includes(` ${word} `));
  }
  if (field === "streetAddress") {
    // The house number with the street's first word: "12 Bay St" is found in "12 Bay Street".
    const street = /^ (\d+[a-z]?) ([a-z0-9]+) /.exec(plainWords(value));
    return Boolean(street && words.includes(` ${street[1]} ${street[2]} `));
  }
  // A loan number, MIN, eNote ID or MERS Org ID, however it is punctuated. Short ones match too much.
  const key = compact(value);
  return key.length >= 5 && compact(text).includes(key);
}

export function namesBorrower(text: string, note: object, fields: readonly string[] = COVENANT_IDENTITY_FIELDS) {
  const record = note as Record<string, unknown>;
  return fields.some((field) => carries(text, field, record[field]));
}

// The covenant as a viewer who can't open the loan may read it: the text, or nothing when it names the borrower.
export function closedCovenant(text: string | null | undefined, note: object) {
  const value = text?.trim() ?? "";
  return value && !namesBorrower(value, note) ? value : "";
}
