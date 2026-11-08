import { money } from "@/lib/format";

// A desk edit to a listing keeps why and what: a short reason, and each field's value before and after, in one line
// the audit page prints as it stands. The seller hears which fields changed and the reason.

export const EDIT_REASON_MIN = 3;
export const EDIT_REASON_MAX = 200;
// The audit log keeps 500 characters of detail (lib/audit.ts).
const DETAIL_MAX = 500;

export function readEditReason(raw: unknown) {
  const text = String(raw ?? "").trim().replace(/\s+/g, " ").slice(0, EDIT_REASON_MAX);
  return text.length < EDIT_REASON_MIN ? ({ error: "Give a short reason for the edit. The seller and the audit log see it." } as const) : ({ error: null, reason: text } as const);
}

type Kind = "text" | "money" | "rate" | "count" | "status";

const LISTING_FIELDS: [key: string, label: string, kind: Kind][] = [
  ["title", "Title", "text"],
  ["summary", "Narrative", "text"],
];

// The note fields the desk edit form writes. memo follows the narrative, so it isn't listed twice.
const NOTE_FIELDS: [key: string, label: string, kind: Kind][] = [
  ["streetAddress", "Street", "text"],
  ["city", "City", "text"],
  ["state", "State", "text"],
  ["zip", "ZIP", "text"],
  ["borrowerName", "Borrower", "text"],
  ["upb", "UPB", "money"],
  ["askingPrice", "Asking price", "money"],
  ["estimatedValue", "Value", "money"],
  ["interestRate", "Rate", "rate"],
  ["monthlyPi", "Monthly P&I", "money"],
  ["monthsDelinquent", "Months delinquent", "count"],
  ["paymentStatus", "Status", "status"],
];

export type FieldChange = { field: string; label: string; before: string; after: string };

type Row = Record<string, unknown>;
export type EditSnapshot = Row & { notes: (Row & { id: string; city?: unknown; state?: unknown })[] };

function asNumber(value: unknown) {
  if (value == null || value === "") return null;
  const number = typeof value === "object" && value && "toNumber" in value ? (value as { toNumber: () => number }).toNumber() : Number(value);
  return Number.isFinite(number) ? number : null;
}

function show(kind: Kind, value: unknown) {
  if (kind === "text") {
    const text = String(value ?? "").trim().replace(/\s+/g, " ");
    if (!text) return "blank";
    return text.length > 40 ? `${text.slice(0, 39)}…` : text;
  }
  if (kind === "status") return value ? String(value).replaceAll("_", " ").toLowerCase() : "blank";
  const number = asNumber(value);
  if (number == null) return "blank";
  if (kind === "money") return money(number);
  if (kind === "rate") return `${Number(number.toFixed(3))}%`;
  return String(Math.round(number));
}

function same(kind: Kind, before: unknown, after: unknown) {
  if (kind === "text" || kind === "status") return String(before ?? "").trim() === String(after ?? "").trim();
  const a = asNumber(before);
  const b = asNumber(after);
  if (a == null || b == null) return a === b;
  // Money to the cent, rates and counts to the thousandth.
  return kind === "money" ? Math.round(a * 100) === Math.round(b * 100) : Math.abs(a - b) < 0.0005;
}

function compare(fields: [string, string, Kind][], before: Row, after: Row, prefix = "", keyPrefix = "") {
  const changes: FieldChange[] = [];
  for (const [key, label, kind] of fields) {
    if (!(key in after) || same(kind, before[key], after[key])) continue;
    changes.push({ field: `${keyPrefix}${key}`, label: `${prefix}${label}`, before: show(kind, before[key]), after: show(kind, after[key]) });
  }
  return changes;
}

// Every listing and loan field the edit changed, read from the rows before and after. A pool's loans are named by
// city, as the edit form names them.
export function listingChanges(before: EditSnapshot, after: EditSnapshot): FieldChange[] {
  const changes = compare(LISTING_FIELDS, before, after);
  const pool = before.notes.length > 1;
  for (const note of before.notes) {
    const next = after.notes.find((row) => row.id === note.id);
    if (!next) continue;
    const where = pool ? `Loan in ${String(note.city ?? "")}, ${String(note.state ?? "")}: ` : "";
    changes.push(...compare(NOTE_FIELDS, note, next, where, `${note.id}.`));
  }
  return changes;
}

export function changeLine(change: FieldChange) {
  return `${change.label} ${change.before} → ${change.after}`;
}

// The audit detail: "Reason: … · Changed: Asking price $100,000 → $95,000; City Austin → Round Rock". Changes that
// don't fit are counted at the end.
export function editDetail(reason: string, changes: FieldChange[], max = DETAIL_MAX) {
  const head = `Reason: ${reason} · `;
  if (!changes.length) return `${head}No field changed.`.slice(0, max);
  const lines = changes.map(changeLine);
  for (let shown = lines.length; shown >= 1; shown -= 1) {
    const rest = lines.length - shown;
    const text = `${head}Changed: ${lines.slice(0, shown).join("; ")}${rest ? `; and ${rest} more` : ""}`;
    if (text.length <= max) return text;
  }
  return `${head}Changed ${lines.length} field${lines.length === 1 ? "" : "s"}.`.slice(0, max);
}

// The seller's notice names the fields, not the old figures, and the reason.
export function sellerEditNotice(reason: string, changes: FieldChange[]) {
  const labels = [...new Set(changes.map((change) => change.label))];
  const list = labels.length > 8 ? `${labels.slice(0, 8).join(", ")} and ${labels.length - 8} more` : labels.join(", ");
  return `The desk changed ${list} on your listing. Reason: ${reason}${/[.!?]$/.test(reason) ? "" : "."} Open the listing to see the new figures, and write the desk if anything is wrong.`;
}
