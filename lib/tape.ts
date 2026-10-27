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
import { suggestMapping, type TapeFieldKey } from "@/lib/tape-fields";

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
};

export type TapeError = { row: number; message: string };

function cell(row: Record<string, string>, mapping: Partial<Record<TapeFieldKey, string>>, key: TapeFieldKey) {
  const header = mapping[key];
  if (!header) return "";
  return (row[header] ?? "").trim();
}

function money(raw: string) {
  if (!raw) return null;
  const cleaned = raw.replace(/[$,\s]/g, "").replace(/[()]/g, "");
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function parseDate(raw: string) {
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

export function normalizeTapeRows(input: {
  rows: Record<string, string>[];
  mapping: Partial<Record<TapeFieldKey, string>>;
  priceMode: "COLUMN" | "PERCENT" | "POOL_TOTAL";
  pricePercent?: number;
  poolTotal?: number;
}): { loans: NormalizedLoan[]; errors: TapeError[] } {
  const errors: TapeError[] = [];
  const drafts: Array<Omit<NormalizedLoan, "askingPrice"> & { askingPrice: number | null; upb: number }> = [];

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
    const paymentStatus = pickEnum(PAYMENT_STATUSES, cell(row, input.mapping, "paymentStatus"), {
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

    const upb = money(cell(row, input.mapping, "upb"));
    const estimatedValue = money(cell(row, input.mapping, "estimatedValue"));
    const rateRaw = money(cell(row, input.mapping, "interestRate"));
    const interestRate = rateRaw == null ? null : rateRaw <= 1 ? rateRaw * 100 : rateRaw;
    const monthlyRaw = cell(row, input.mapping, "monthlyPi");
    const monthlyPi = monthlyRaw ? money(monthlyRaw) : 0;
    const monthsRaw = cell(row, input.mapping, "monthsDelinquent");
    const monthsDelinquent = monthsRaw ? Number(monthsRaw.replace(/[^0-9.]/g, "")) : 0;
    const askingRaw = cell(row, input.mapping, "askingPrice");
    const askingPrice = askingRaw ? money(askingRaw) : null;

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
      zip: cell(row, input.mapping, "zip").replace(/[^0-9]/g, "").slice(0, 5),
      propertyType: propertyType as NormalizedLoan["propertyType"],
      lienPosition: lienPosition as NormalizedLoan["lienPosition"],
      upb: upb!,
      interestRate: interestRate!,
      monthlyPi: monthlyPi ?? 0,
      paymentStatus: paymentStatus as NormalizedLoan["paymentStatus"],
      monthsDelinquent: Number.isFinite(monthsDelinquent) ? Math.round(monthsDelinquent) : 0,
      lastPaidDate: parseDate(cell(row, input.mapping, "lastPaidDate")),
      originationDate: parseDate(cell(row, input.mapping, "originationDate")),
      maturityDate: parseDate(cell(row, input.mapping, "maturityDate")),
      estimatedValue: estimatedValue!,
      askingPrice,
      occupancy: occupancy as NormalizedLoan["occupancy"],
      foreclosureStatus: foreclosureStatus as NormalizedLoan["foreclosureStatus"],
      borrowerName: cell(row, input.mapping, "borrowerName"),
      memo: cell(row, input.mapping, "memo"),
    });
  });

  if (!drafts.length && !errors.length) {
    errors.push({ row: 0, message: "The tape has no loan rows." });
  }

  let loans: NormalizedLoan[] = [];
  if (input.priceMode === "PERCENT") {
    const percent = input.pricePercent ?? 0;
    if (percent <= 0 || percent > 150) {
      errors.push({ row: 0, message: "Enter a pool price between 1% and 150% of UPB." });
    } else {
      loans = drafts.map((draft) => ({ ...draft, askingPrice: Math.round(draft.upb * percent) / 100 }));
    }
  } else if (input.priceMode === "POOL_TOTAL") {
    const total = input.poolTotal ?? 0;
    const upb = drafts.reduce((sum, draft) => sum + draft.upb, 0);
    if (total <= 0 || upb <= 0) {
      errors.push({ row: 0, message: "Enter a pool asking price greater than zero." });
    } else {
      loans = drafts.map((draft) => ({ ...draft, askingPrice: Math.round((total * (draft.upb / upb)) * 100) / 100 }));
    }
  } else {
    loans = drafts.map((draft) => ({ ...draft, askingPrice: draft.askingPrice ?? 0 }));
  }

  return { loans, errors };
}

export { suggestMapping };
