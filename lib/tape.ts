import Papa from "papaparse";
import * as XLSX from "xlsx";
import {
  FORECLOSURES,
  LIEN_POSITIONS,
  OCCUPANCIES,
  PAYMENT_STATUSES,
  PROPERTY_TYPES,
  US_STATES,
} from "@/lib/labels";
import {
  CREDIT_SCORE_MAX,
  CREDIT_SCORE_MIN,
  normalizeHeader,
  parseBankruptcyChapter,
  parseCreditScore,
  parseCreditScoreType,
  parseLoanPurpose,
  parseLossMitStage,
  parseMersMin,
  parseValueType,
  parseYesNo,
  payStringMonths,
  payStringWidth,
  parsePayString,
  restorePayString,
  suggestMapping,
  type ServicingRecord,
  type TapeFieldKey,
} from "@/lib/tape-fields";

export type TapeMatrix = {
  headers: string[];
  rows: Record<string, string>[];
};

const STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", districtofcolumbia: "DC", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY",
  louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", newhampshire: "NH",
  newjersey: "NJ", newmexico: "NM", newyork: "NY", northcarolina: "NC", northdakota: "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", rhodeisland: "RI", southcarolina: "SC",
  southdakota: "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA",
  washington: "WA", westvirginia: "WV", wisconsin: "WI", wyoming: "WY",
};

export function parseTapeBuffer(buffer: Buffer, filename: string): TapeMatrix {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    const parsed = Papa.parse<string[]>(buffer.toString("utf8"), { skipEmptyLines: true });
    return matrixToRecords(parsed.data);
  }
  const book = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheet = book.Sheets[book.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json<(string | number | Date | null)[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
    dateNF: "yyyy-mm-dd",
  });
  return matrixToRecords(matrix.map((row) => row.map((cell) => (cell == null ? "" : String(cell)))));
}

function matrixToRecords(matrix: string[][]): TapeMatrix {
  const [headerRow, ...body] = matrix.filter((row) => row.some((cell) => String(cell).trim()));
  if (!headerRow) return { headers: [], rows: [] };
  const headers = headerRow.map((cell, index) => String(cell).trim() || `Column ${index + 1}`);
  const rows = body.map((row) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = String(row[index] ?? "").trim();
    });
    return record;
  });
  return { headers, rows };
}

export type NormalizedLoan = {
  streetAddress: string;
  city: string;
  state: string;
  zip: string;
  propertyType: (typeof PROPERTY_TYPES)[number]["value"];
  lienPosition: (typeof LIEN_POSITIONS)[number]["value"];
  upb: number;
  interestRate: number;
  monthlyPi: number;
  paymentStatus: (typeof PAYMENT_STATUSES)[number]["value"];
  monthsDelinquent: number;
  lastPaidDate: Date | null;
  originationDate: Date | null;
  maturityDate: Date | null;
  estimatedValue: number;
  askingPrice: number;
  occupancy: (typeof OCCUPANCIES)[number]["value"];
  foreclosureStatus: (typeof FORECLOSURES)[number]["value"];
  borrowerName: string;
  memo: string;
} & ServicingRecord;

export type TapeError = { row: number; message: string };

function cell(row: Record<string, string>, mapping: Partial<Record<TapeFieldKey, string>>, key: TapeFieldKey) {
  const header = mapping[key];
  if (!header) return "";
  return (row[header] ?? "").trim();
}

export function parseMoney(raw: string) {
  if (!raw) return null;
  // Accounting style "(1,000)" is a negative, which the checks below refuse, not a positive 1,000.
  const cleaned = raw.replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

// "6.50%" is already a percent; a bare 0.065 is a fraction. The quality check reads rates the same way.
export function parseRate(text: string) {
  const raw = parseMoney(text.replace(/%/g, ""));
  if (raw == null) return null;
  return raw < 1 && !text.includes("%") ? raw * 100 : raw;
}

export function parseDate(raw: string) {
  if (!raw) return null;
  if (/^\d{5}$/.test(raw)) {
    const excel = Number(raw);
    const utc = new Date(Date.UTC(1899, 11, 30) + excel * 86400000);
    return Number.isNaN(utc.getTime()) ? null : utc;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function parseState(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  if ((US_STATES as readonly string[]).includes(upper)) return upper;
  const named = STATE_NAMES[trimmed.toLowerCase().replace(/[^a-z]/g, "")];
  return named ?? null;
}

function pickEnum<T extends readonly { value: string; label: string }[]>(options: T, raw: string, aliases: Record<string, T[number]["value"]>) {
  const key = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key) return null;
  if (aliases[key]) return aliases[key];
  const direct = options.find((option) => option.value.toLowerCase().replace(/[^a-z0-9]/g, "") === key || option.label.toLowerCase().replace(/[^a-z0-9]/g, "") === key);
  return direct?.value ?? null;
}

export function parsePaymentStatus(raw: string) {
  return pickEnum(PAYMENT_STATUSES, raw, {
    performing: "PERFORMING",
    current: "PERFORMING",
    p: "PERFORMING",
    perf: "PERFORMING",
    subperforming: "SUB_PERFORMING",
    sub: "SUB_PERFORMING",
    reperforming: "SUB_PERFORMING",
    nonperforming: "NON_PERFORMING",
    npl: "NON_PERFORMING",
    np: "NON_PERFORMING",
    default: "NON_PERFORMING",
  });
}

// A blank months-delinquent cell reads the pay string's newest month, and 0 without one, as before.
export function monthsDelinquentFrom(raw: string, payString: string | null | undefined) {
  if (!raw) return payStringMonths(payString) ?? 0;
  const months = Number(raw.replace(/[^0-9.]/g, ""));
  return Number.isFinite(months) ? Math.round(months) : 0;
}

export type ServicingNote = { field: TapeFieldKey; level: "warn" | "fix"; message: string };

// Placeholders a servicer leaves in an empty cell.
const EMPTY = new Set(["", "na", "none", "null", "unknown", "notapplicable", "tbd"]);
const NO_BANKRUPTCY = new Set(["no", "n", "0", "false"]);

function squash(raw: string) {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function clip(raw: string) {
  return raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
}

function put<K extends keyof ServicingRecord>(record: ServicingRecord, key: K, value: ServicingRecord[K] | null | undefined) {
  if (value != null) record[key] = value;
}

// The servicing columns are optional, so a value that can't be read is left off with a warning, never a row error.
// The import and the preview both read them here, so the preview says what the import will store.
export function readServicing(
  row: Record<string, string>,
  mapping: Partial<Record<TapeFieldKey, string>>,
  payWidth = 0,
): { record: ServicingRecord; notes: ServicingNote[] } {
  const record: ServicingRecord = {};
  const notes: ServicingNote[] = [];
  const warn = (field: TapeFieldKey, message: string) => notes.push({ field, level: "warn", message });
  const get = (key: TapeFieldKey) => {
    const raw = cell(row, mapping, key);
    return EMPTY.has(squash(raw)) ? "" : raw;
  };
  const date = (key: TapeFieldKey, label: string) => {
    const raw = get(key);
    if (!raw) return null;
    const parsed = parseDate(raw);
    if (!parsed) warn(key, `${label} “${clip(raw)}” wasn't read as a date and will be left off.`);
    return parsed;
  };
  // "None" in an HOA lien column means no lien, so yes and no are read before the placeholders.
  const yesNo = (key: TapeFieldKey, label: string) => {
    const raw = cell(row, mapping, key);
    const parsed = parseYesNo(raw);
    if (parsed == null && get(key)) warn(key, `${label} “${clip(raw)}” wasn't read as yes or no and will be left off.`);
    return parsed;
  };

  const loanNumber = get("loanNumber");
  // Excel shows a long loan number as 1.23457E+11, and the digits it dropped can't be recovered.
  if (/^\d(\.\d+)?E\+\d+$/i.test(loanNumber)) {
    warn("loanNumber", `Loan number “${clip(loanNumber)}” was rounded by a spreadsheet and will be left off. Format the column as text and export again.`);
  } else {
    put(record, "loanNumber", loanNumber.slice(0, 40) || null);
  }
  put(record, "servicerName", get("servicerName").slice(0, 120) || null);

  const payRaw = get("payString");
  if (payRaw) {
    const pay = restorePayString(payRaw, payWidth);
    if (!pay) {
      warn("payString", `Pay string “${clip(payRaw)}” wasn't read and will be left off. Use 0 to 9 or X for each month, newest first.`);
    } else {
      record.payString = pay;
      if (pay !== parsePayString(payRaw)) {
        notes.push({ field: "payString", level: "fix", message: `Pay string ${clip(payRaw)} lost its leading zeros in the spreadsheet and will be read as ${pay}.` });
      } else if (pay !== payRaw.trim()) {
        notes.push({ field: "payString", level: "fix", message: `Pay string “${clip(payRaw)}” will be stored as ${pay}.` });
      }
    }
  }

  put(record, "nextDueDate", date("nextDueDate", "Next due date"));
  put(record, "modified", yesNo("modified", "Modified"));
  put(record, "modificationDate", date("modificationDate", "Modification date"));
  // A modification date answers the question when the modified column is blank.
  if (record.modificationDate && record.modified === undefined) record.modified = true;
  put(record, "lossMitigation", get("lossMitigation").slice(0, 200) || null);

  const chapterRaw = get("bankruptcyChapter");
  if (chapterRaw && !NO_BANKRUPTCY.has(squash(chapterRaw))) {
    const chapter = parseBankruptcyChapter(chapterRaw);
    if (!chapter) warn("bankruptcyChapter", `Bankruptcy chapter “${clip(chapterRaw)}” wasn't recognized and will be left off. Use 7, 11, 12 or 13.`);
    put(record, "bankruptcyChapter", chapter);
  }
  put(record, "bankruptcyFiledAt", date("bankruptcyFiledAt", "Bankruptcy filed date"));
  put(record, "foreclosureFiledAt", date("foreclosureFiledAt", "Foreclosure filed date"));

  const valueTypeRaw = get("valueType");
  if (valueTypeRaw) {
    const valueType = parseValueType(valueTypeRaw);
    if (!valueType) warn("valueType", `Value source “${clip(valueTypeRaw)}” isn't a BPO, AVM, appraisal or seller estimate and will be left off.`);
    put(record, "valueType", valueType);
  }
  put(record, "valueAsOf", date("valueAsOf", "Value date"));

  const purposeRaw = get("loanPurpose");
  if (purposeRaw) {
    const purpose = parseLoanPurpose(purposeRaw);
    if (!purpose) warn("loanPurpose", `Loan purpose “${clip(purposeRaw)}” wasn't recognized and will be left off.`);
    put(record, "loanPurpose", purpose);
  }
  put(record, "hoaLien", yesNo("hoaLien", "HOA lien"));
  put(record, "taxDelinquent", yesNo("taxDelinquent", "Taxes delinquent"));
  readTerms(record, get, warn, mapping, notes);
  return { record, notes };
}

const ROUNDED = /^\d(\.\d+)?E\+\d+$/i;

// Tape v2.1: rate terms, credit, registry and sale terms. Same rule as the servicing record: what can't be read is
// left off with a warning.
function readTerms(
  record: ServicingRecord,
  get: (key: TapeFieldKey) => string,
  warn: (field: TapeFieldKey, message: string) => void,
  mapping: Partial<Record<TapeFieldKey, string>>,
  notes: ServicingNote[],
) {
  const date = (key: TapeFieldKey, label: string) => {
    const raw = get(key);
    if (!raw) return null;
    const parsed = parseDate(raw);
    if (!parsed) warn(key, `${label} “${clip(raw)}” wasn't read as a date and will be left off.`);
    return parsed;
  };

  // A column called "Index" is sometimes a row counter, not a rate index.
  const index = get("armIndex");
  if (index && /^[\d.,\s]+$/.test(index)) {
    warn("armIndex", `ARM index “${clip(index)}” is a number, not an index such as SOFR or the 1-year Treasury, and will be left off.`);
  } else {
    put(record, "armIndex", index.slice(0, 60) || null);
  }
  const marginRaw = get("armMargin");
  if (marginRaw) {
    const margin = parseRate(marginRaw);
    if (margin == null || margin < 0 || margin > 20) warn("armMargin", `ARM margin “${clip(marginRaw)}” wasn't read as a percent from 0 to 20 and will be left off.`);
    else record.armMargin = Math.round(margin * 10000) / 10000;
  }
  put(record, "armNextReset", date("armNextReset", "Next rate reset"));

  const scoreRaw = get("creditScore");
  if (scoreRaw) {
    const score = parseCreditScore(scoreRaw);
    if (score == null) warn("creditScore", `Credit score “${clip(scoreRaw)}” wasn't read as a number and will be left off.`);
    else if (score < CREDIT_SCORE_MIN || score > CREDIT_SCORE_MAX) warn("creditScore", `Credit score ${score} is outside ${CREDIT_SCORE_MIN}–${CREDIT_SCORE_MAX} and will be left off.`);
    else record.creditScore = score;
  }
  const typeRaw = get("creditScoreType");
  if (typeRaw) {
    const type = parseCreditScoreType(typeRaw);
    if (!type) warn("creditScoreType", `Score model “${clip(typeRaw)}” isn't FICO, VantageScore or other and will be left off.`);
    put(record, "creditScoreType", type);
  } else if (record.creditScore != null && mapping.creditScore) {
    // A column headed "FICO" or "VantageScore" names its own model.
    put(record, "creditScoreType", parseCreditScoreType(normalizeHeader(mapping.creditScore)));
  }
  put(record, "creditScoreDate", date("creditScoreDate", "Score date"));

  const minRaw = get("mersMin");
  if (minRaw) {
    if (ROUNDED.test(minRaw)) warn("mersMin", `MERS MIN “${clip(minRaw)}” was rounded by a spreadsheet and will be left off. Format the column as text and export again.`);
    else {
      const min = parseMersMin(minRaw);
      if (!min) warn("mersMin", `MERS MIN “${clip(minRaw)}” isn't 18 digits and will be left off.`);
      put(record, "mersMin", min);
    }
  }
  const eNote = get("eNoteId");
  // Some tapes carry "eNote" as a yes or no flag, which says nothing about the ID.
  if (eNote && parseYesNo(eNote) != null) warn("eNoteId", `eNote “${clip(eNote)}” is a yes or no, not an eNote ID, and will be left off.`);
  else put(record, "eNoteId", eNote.slice(0, 60) || null);
  put(record, "originatingPlatform", get("originatingPlatform").slice(0, 120) || null);

  const stageRaw = get("lossMitStage");
  if (stageRaw) {
    const stage = parseLossMitStage(stageRaw);
    if (stage) record.lossMitStage = stage;
    else if (!record.lossMitigation) {
      // "Forbearance" in a status column is the outcome, so it's kept as one rather than dropped.
      record.lossMitigation = stageRaw.slice(0, 200);
      notes.push({ field: "lossMitStage", level: "fix", message: `Loss mitigation status “${clip(stageRaw)}” isn't a stage, so it will be stored as the loss mitigation outcome.` });
    } else {
      warn("lossMitStage", `Loss mitigation stage “${clip(stageRaw)}” isn't requested, options offered or decided, and will be left off.`);
    }
  }
  put(record, "inheritedCovenants", get("inheritedCovenants").slice(0, 600) || null);
  put(record, "originatorLicense", get("originatorLicense").slice(0, 200) || null);
}

export function tapePayWidth(rows: Record<string, string>[], mapping: Partial<Record<TapeFieldKey, string>>) {
  return mapping.payString ? payStringWidth(rows.map((row) => cell(row, mapping, "payString"))) : 0;
}

export function normalizeTapeRows(input: {
  rows: Record<string, string>[];
  mapping: Partial<Record<TapeFieldKey, string>>;
  priceMode: "COLUMN" | "PERCENT" | "POOL_TOTAL";
  pricePercent?: number;
  poolTotal?: number;
}): { loans: NormalizedLoan[]; errors: TapeError[] } {
  const errors: TapeError[] = [];
  const drafts: Array<Omit<NormalizedLoan, "askingPrice"> & { askingPrice: number | null; upb: number }> = [];

  const payWidth = tapePayWidth(input.rows, input.mapping);

  input.rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const street = cell(row, input.mapping, "streetAddress");
    const city = cell(row, input.mapping, "city");
    if (!city && !street && !cell(row, input.mapping, "upb")) return;

    const state = parseState(cell(row, input.mapping, "state"));
    const propertyType = pickEnum(PROPERTY_TYPES, cell(row, input.mapping, "propertyType"), {
      sfr: "SFR",
      singlefamily: "SFR",
      singlefamilyresidence: "SFR",
      condo: "CONDO",
      condominium: "CONDO",
      townhome: "TOWNHOUSE",
      townhouse: "TOWNHOUSE",
      multi: "MULTIFAMILY",
      multifamily: "MULTIFAMILY",
      twofour: "MULTIFAMILY",
      land: "LAND",
      lot: "LAND",
      commercial: "COMMERCIAL",
      mixeduse: "MIXED_USE",
      mixed: "MIXED_USE",
    });
    const lienPosition = pickEnum(LIEN_POSITIONS, cell(row, input.mapping, "lienPosition"), {
      "1": "FIRST",
      "1st": "FIRST",
      first: "FIRST",
      firstlien: "FIRST",
      "2": "SECOND",
      "2nd": "SECOND",
      second: "SECOND",
      secondlien: "SECOND",
      "3": "THIRD",
      "3rd": "THIRD",
      third: "THIRD",
      other: "OTHER",
    });
    const paymentStatus = parsePaymentStatus(cell(row, input.mapping, "paymentStatus"));
    const occupancy = pickEnum(OCCUPANCIES, cell(row, input.mapping, "occupancy"), {
      owneroccupied: "OWNER_OCCUPIED",
      owner: "OWNER_OCCUPIED",
      oo: "OWNER_OCCUPIED",
      tenant: "TENANT",
      tenantoccupied: "TENANT",
      occupied: "TENANT",
      vacant: "VACANT",
      unknown: "UNKNOWN",
    }) ?? "UNKNOWN";
    const foreclosureStatus = pickEnum(FORECLOSURES, cell(row, input.mapping, "foreclosureStatus"), {
      none: "NONE",
      preforeclosure: "PRE_FORECLOSURE",
      nod: "NOTICE_OF_DEFAULT",
      noticeofdefault: "NOTICE_OF_DEFAULT",
      lispendens: "LIS_PENDENS",
      lp: "LIS_PENDENS",
      auction: "AUCTION_SCHEDULED",
      auctionscheduled: "AUCTION_SCHEDULED",
      reo: "REO",
      unknown: "UNKNOWN",
    }) ?? "NONE";

    const upb = parseMoney(cell(row, input.mapping, "upb"));
    const estimatedValue = parseMoney(cell(row, input.mapping, "estimatedValue"));
    const interestRate = parseRate(cell(row, input.mapping, "interestRate"));
    const monthlyRaw = cell(row, input.mapping, "monthlyPi");
    const monthlyPi = monthlyRaw ? parseMoney(monthlyRaw) : 0;
    const servicing = readServicing(row, input.mapping, payWidth).record;
    const monthsDelinquent = monthsDelinquentFrom(cell(row, input.mapping, "monthsDelinquent"), servicing.payString);
    const askingRaw = cell(row, input.mapping, "askingPrice");
    const askingPrice = askingRaw ? parseMoney(askingRaw) : null;

    const problems: string[] = [];
    if (!city) problems.push("city is required");
    if (!state) problems.push("state is not a US state");
    if (!propertyType) problems.push("property type was not recognized");
    if (!lienPosition) problems.push("lien position was not recognized");
    if (!paymentStatus) problems.push("payment status was not recognized");
    if (upb == null || upb <= 0) problems.push("UPB must be greater than zero");
    if (estimatedValue == null || estimatedValue <= 0) problems.push("estimated value must be greater than zero");
    if (interestRate == null || interestRate < 0 || interestRate > 40) problems.push("interest rate looks invalid");
    if (input.priceMode === "COLUMN" && (askingPrice == null || askingPrice <= 0)) problems.push("asking price is required for this pricing method");
    if (problems.length) {
      errors.push({ row: rowNumber, message: problems.join("; ") });
      return;
    }

    drafts.push({
      streetAddress: street || "Not provided on tape",
      city,
      state: state!,
      // Spreadsheets store 02134 as the number 2134, so short ZIPs get their leading zeros back.
      zip: ((digits) => (digits.length >= 3 && digits.length < 5 ? digits.padStart(5, "0") : digits))(cell(row, input.mapping, "zip").replace(/[^0-9]/g, "").slice(0, 5)),
      propertyType: propertyType as NormalizedLoan["propertyType"],
      lienPosition: lienPosition as NormalizedLoan["lienPosition"],
      upb: upb!,
      interestRate: interestRate!,
      monthlyPi: monthlyPi ?? 0,
      paymentStatus: paymentStatus as NormalizedLoan["paymentStatus"],
      monthsDelinquent,
      lastPaidDate: parseDate(cell(row, input.mapping, "lastPaidDate")),
      originationDate: parseDate(cell(row, input.mapping, "originationDate")),
      maturityDate: parseDate(cell(row, input.mapping, "maturityDate")),
      estimatedValue: estimatedValue!,
      askingPrice,
      occupancy: occupancy as NormalizedLoan["occupancy"],
      foreclosureStatus: foreclosureStatus as NormalizedLoan["foreclosureStatus"],
      borrowerName: cell(row, input.mapping, "borrowerName"),
      memo: cell(row, input.mapping, "memo"),
      ...servicing,
    });
  });

  if (!drafts.length && !errors.length) {
    errors.push({ row: 0, message: "The tape has no loan rows." });
  }

  let loans: NormalizedLoan[] = [];
  if (input.priceMode === "PERCENT") {
    const percent = input.pricePercent ?? 0;
    if (!Number.isFinite(percent) || percent <= 0 || percent > 150) {
      errors.push({ row: 0, message: "Enter a pool price between 1% and 150% of UPB." });
    } else {
      loans = drafts.map((draft) => ({ ...draft, askingPrice: Math.round(draft.upb * percent) / 100 }));
    }
  } else if (input.priceMode === "POOL_TOTAL") {
    const total = input.poolTotal ?? 0;
    const upb = drafts.reduce((sum, draft) => sum + draft.upb, 0);
    if (!Number.isFinite(total) || total <= 0 || upb <= 0) {
      errors.push({ row: 0, message: "Enter a pool asking price greater than zero." });
    } else {
      loans = drafts.map((draft) => ({ ...draft, askingPrice: Math.round((total * (draft.upb / upb)) * 100) / 100 }));
    }
  } else if (input.priceMode === "COLUMN") {
    loans = drafts.map((draft) => ({ ...draft, askingPrice: draft.askingPrice ?? 0 }));
  } else {
    errors.push({ row: 0, message: "Choose how to price the pool." });
  }

  return { loans, errors };
}

export { suggestMapping };
