import Papa from "papaparse";

export const FILING_COUNTIES = ["Miami-Dade", "Broward", "Palm Beach"] as const;

export type FilingRow = {
  county: string;
  caseNumber: string;
  filedOn: Date | null;
  defendant: string;
  plaintiff: string;
  street: string;
  city: string;
  zip: string;
};

const ALIASES: Record<string, keyof Omit<FilingRow, "county" | "filedOn"> | "filedOn"> = {
  casenumber: "caseNumber",
  case: "caseNumber",
  caseno: "caseNumber",
  filingnumber: "caseNumber",
  filingdate: "filedOn",
  date: "filedOn",
  fileddate: "filedOn",
  defendant: "defendant",
  defendantname: "defendant",
  plaintiff: "plaintiff",
  plaintiffname: "plaintiff",
  address: "street",
  street: "street",
  propertyaddress: "street",
  city: "city",
  zip: "zip",
  zipcode: "zip",
};

export function parseFilingCsv(text: string, county: string): { rows: FilingRow[]; errors: string[] } {
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  const errors: string[] = [];
  const rows: FilingRow[] = [];
  parsed.data.forEach((record, index) => {
    const mapped: Partial<FilingRow> = { county };
    for (const [header, raw] of Object.entries(record)) {
      const key = ALIASES[header.toLowerCase().replace(/[^a-z0-9]/g, "")];
      if (!key) continue;
      const value = String(raw ?? "").trim();
      if (key === "filedOn") mapped.filedOn = value ? new Date(value) : null;
      else mapped[key] = value;
    }
    if (!mapped.caseNumber) {
      errors.push(`Row ${index + 2} has no case number.`);
      return;
    }
    if (mapped.filedOn && Number.isNaN(mapped.filedOn.getTime())) mapped.filedOn = null;
    rows.push({
      county,
      caseNumber: mapped.caseNumber,
      filedOn: mapped.filedOn ?? null,
      defendant: mapped.defendant || "",
      plaintiff: mapped.plaintiff || "",
      street: mapped.street || "",
      city: mapped.city || "",
      zip: mapped.zip || "",
    });
  });
  if (!rows.length && !errors.length) errors.push("The file had no rows.");
  return { rows, errors };
}

export function addressKey(street: string, city: string) {
  return `${street} ${city}`.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function matchFiling(row: { street: string; city: string }, notes: { id: string; streetAddress: string; city: string }[]) {
  const key = addressKey(row.street, row.city);
  if (key.length < 6) return null;
  return notes.find((note) => addressKey(note.streetAddress, note.city) === key)?.id ?? null;
}
