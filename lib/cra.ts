// CRA and LMI tags. A bank or credit union buys residential loans partly for Community Reinvestment Act credit: loans
// to low- or moderate-income (LMI) borrowers, or secured by homes in LMI census tracts. The tape can carry the 11-digit
// census tract, the tract's income level from the FFIEC census file, and whether the borrower was LMI at origination.
// lib/tape-fields.ts reads them from a tape; this file holds the rule and the words.
//
// craEligible() is UPB's simplified reading of the tape, not a CRA determination. The bank's own CRA officer and its
// regulator decide what counts, and the 2023 CRA final rule changed how loan purchases are credited (for instance, a
// purchase can be weighed differently from an origination, and distressed or underserved middle-income tracts can
// count). UPB doesn't model any of that, and the copy below says so wherever a buyer reads the tag.
//
// A census tract covers a few thousand people, so it doesn't identify the borrower on its own and isn't an identity
// field: it shows before confidentiality like the city. lib/loan-file.ts and lib/mismo.ts follow that.

// The tract income levels as the FFIEC census file names them. The file codes them 1 to 4, and 0 for not known.
export const TRACT_INCOME_LEVELS = [
  { value: "LOW", label: "Low" },
  { value: "MODERATE", label: "Moderate" },
  { value: "MIDDLE", label: "Middle" },
  { value: "UPPER", label: "Upper" },
  { value: "UNKNOWN", label: "Unknown" },
] as const;

export type TractIncomeLevel = (typeof TRACT_INCOME_LEVELS)[number]["value"];

export function tractIncomeLabel(value: string | null | undefined) {
  return TRACT_INCOME_LEVELS.find((level) => level.value === value)?.label ?? null;
}

// A census tract is 11 digits: the 2-digit state FIPS code, the 3-digit county code and the 6-digit tract code, whose
// last two digits are the suffix after the tract's decimal point. Tapes write it as 11 digits, as "12-086-010500", or
// as the county and the tract number, "12086.0105" (tract 0105.00). A spreadsheet drops a leading zero from a state
// below 10, so 10 digits get it back. Null when it can't be read as a whole tract.
export function parseCensusTract(raw: string) {
  const text = raw.trim();
  if (!text || /e\+/i.test(text)) return null;
  const whole = (state: string, county: string, tract: string) => {
    if (state.length > 2 || county.length > 3 || tract.length !== 6) return null;
    const id = `${state.padStart(2, "0")}${county.padStart(3, "0")}${tract}`;
    return /^\d{11}$/.test(id) && !id.startsWith("00") && id.slice(2, 5) !== "000" && !id.endsWith("000000") ? id : null;
  };
  // The tract code alone: 6 digits, a base of up to 4 with its 2-digit suffix ("0105.01"), or a bare base ("105").
  const tractCode = (part: string) => {
    const [base, suffix, extra] = part.split(".");
    if (extra !== undefined || !/^\d+$/.test(base) || (suffix !== undefined && !/^\d{1,2}$/.test(suffix))) return null;
    if (suffix === undefined && base.length === 6) return base;
    if (base.length > 4) return null;
    return `${base.padStart(4, "0")}${(suffix ?? "").padEnd(2, "0")}`;
  };
  const digits = text.replace(/\s/g, "");
  if (/^\d{11}$/.test(digits)) return whole(digits.slice(0, 2), digits.slice(2, 5), digits.slice(5));
  if (/^\d{10}$/.test(digits)) return whole(digits.slice(0, 1), digits.slice(1, 4), digits.slice(4));
  // "12-086-010500", "12 086 0105.00".
  const parts = text.split(/[\s\-/]+/).filter(Boolean);
  if (parts.length === 3 && /^\d{1,2}$/.test(parts[0]) && /^\d{1,3}$/.test(parts[1])) {
    const tract = tractCode(parts[2]);
    return tract ? whole(parts[0], parts[1], tract) : null;
  }
  // "12086.0105", "12086 0105.00", "12086-010500": the 5-digit state and county, then the tract's 4-digit base (with
  // any suffix) or all 6 digits. A shorter tract here is a number a spreadsheet trimmed ("12086.01" for 0100), or a
  // tract with no county ("1234.56"), so it isn't guessed at.
  const county = /^(\d{4,5})[.\s\-/]+(\d{4}(?:\.\d{1,2})?|\d{6})$/.exec(text);
  if (county) {
    const tract = tractCode(county[2]);
    const id = county[1].padStart(5, "0");
    return tract ? whole(id.slice(0, 2), id.slice(2), tract) : null;
  }
  return null;
}

export const CENSUS_TRACT_MESSAGE = "Enter the census tract as 11 digits: the state, county and tract codes.";

// "Low", "Moderate income", "Mod", "Upper", the FFIEC file's codes 1 to 4 and 0, and "Unknown". "Low-moderate" or
// "LMI" says low or moderate without saying which, so it isn't read.
export function parseTractIncomeLevel(raw: string): TractIncomeLevel | null {
  const key = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key) return null;
  if (key.includes("low") && key.includes("mod")) return null;
  if (key === "0" || key === "unknown" || key === "notknown" || key === "unk" || key === "nk" || key === "notavailable") return "UNKNOWN";
  if (key === "1" || key.startsWith("low")) return "LOW";
  if (key === "2" || key.startsWith("mod")) return "MODERATE";
  if (key === "3" || key.startsWith("mid") || key.includes("middle")) return "MIDDLE";
  if (key === "4" || key.startsWith("upp") || key.startsWith("high")) return "UPPER";
  return null;
}

const LMI_YES = new Set(["y", "yes", "true", "t", "1", "x", "lmi", "low", "moderate", "lowincome", "moderateincome", "lowmod", "lowmoderate", "lowtomoderate"]);
const LMI_NO = new Set(["n", "no", "false", "f", "0", "none", "nonlmi", "notlmi", "middle", "upper", "high", "middleincome", "upperincome"]);

// The LMI borrower flag reads yes or no, and also the words a servicer puts in an LMI column: "LMI", "Low-mod",
// "Non-LMI", "Middle".
export function parseLmiBorrower(raw: string) {
  const key = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (LMI_YES.has(key)) return true;
  if (LMI_NO.has(key)) return false;
  return null;
}

export type CraNote = {
  tractIncomeLevel?: string | null;
  lmiBorrower?: boolean | null;
};

export type CraReason = "LMI tract" | "LMI borrower";

// UPB's simplified CRA reading: a loan in a low- or moderate-income tract, or to a borrower whose income was at or
// under 80% of area median at origination. See the note at the top: the bank's CRA officer decides what counts.
export function craEligible(note: CraNote): { eligible: boolean; reasons: CraReason[] } {
  const reasons: CraReason[] = [];
  if (note.tractIncomeLevel === "LOW" || note.tractIncomeLevel === "MODERATE") reasons.push("LMI tract");
  if (note.lmiBorrower === true) reasons.push("LMI borrower");
  return { eligible: reasons.length > 0, reasons };
}

export function isCraEligible(note: CraNote) {
  return craEligible(note).eligible;
}

// "LMI tract", "LMI tract and LMI borrower".
export function craReasonText(reasons: CraReason[]) {
  return reasons.join(" and ");
}

export type CraCount = { eligible: number; total: number; tract: number; borrower: number; reasons: CraReason[] };

// How many of these loans read as CRA-eligible, and for which reason. reasons is the single loan's own.
export function craCount(notes: CraNote[]): CraCount {
  const read = notes.map(craEligible);
  return {
    eligible: read.filter((row) => row.eligible).length,
    total: notes.length,
    tract: read.filter((row) => row.reasons.includes("LMI tract")).length,
    borrower: read.filter((row) => row.reasons.includes("LMI borrower")).length,
    reasons: notes.length === 1 ? read[0].reasons : [],
  };
}

// "6 of 16 loans CRA-eligible".
export function craCountLine(count: { eligible: number; total: number }) {
  return `${count.eligible} of ${count.total} ${count.total === 1 ? "loan" : "loans"} CRA-eligible`;
}

// The badge's words for a listing, or null when no loan qualifies: the reason for one loan, the count for a pool.
export function craBadgeText(kind: string, notes: CraNote[]) {
  const count = craCount(notes);
  if (!count.eligible) return null;
  return kind === "POOL" || notes.length > 1 ? craCountLine(count) : craReasonText(count.reasons);
}

// The share of a pool's UPB that reads as CRA-eligible, for the buy box, which judges a pool by half its UPB.
export function craShare(notes: (CraNote & { upb: number })[]) {
  const total = notes.reduce((sum, note) => sum + note.upb, 0);
  if (!(total > 0)) return 0;
  return notes.filter(isCraEligible).reduce((sum, note) => sum + note.upb, 0) / total;
}

// The caution under every CRA tag a buyer reads.
export const CRA_CAVEAT =
  "UPB's reading of the tape: a low- or moderate-income census tract or borrower, as the seller states it until the desk verifies it. Your CRA officer and your regulator decide what counts, including under the 2023 CRA rule.";

// The FFIEC's public geocoder, where the desk checks a property's census tract and its income level. The site takes
// the address typed into its search box; UPB found no documented way to pass one in the link, so the link opens the
// geocoder and the desk pastes the address beside it. UPB builds the link only and never fetches it.
export const FFIEC_GEOCODER_URL = "https://geomap.ffiec.gov/ffiecgeomap/";

// The geocoder link and the one-line address to search, or null when the street isn't on file. Desk only: the address
// is the loan's street.
export function ffiecGeocoderLink(note: { streetAddress?: string | null; city?: string | null; state?: string | null; zip?: string | null }) {
  const street = note.streetAddress?.trim();
  if (!street || street === "Not provided on tape") return null;
  const place = [note.city?.trim(), [note.state?.trim(), note.zip?.trim()].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return { href: FFIEC_GEOCODER_URL, address: place ? `${street}, ${place}` : street };
}
