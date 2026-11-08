import { US_STATES } from "@/lib/labels";
import { monthsDelinquentFrom, parseDate, parsePaymentStatus, readServicing, tapePayWidth } from "@/lib/tape";
import { payStringMonths, type ServicingRecord, type TapeFieldKey } from "@/lib/tape-fields";

export type TapeFlag = {
  row: number;
  level: "error" | "warn" | "fix";
  field: string;
  message: string;
};

const ZIP_RANGES: [number, number, string][] = [
  [320, 349, "FL"],
  [300, 319, "GA"],
  [398, 399, "GA"],
  [733, 733, "TX"],
  [750, 799, "TX"],
  [885, 885, "TX"],
  [270, 289, "NC"],
  [290, 299, "SC"],
  [350, 369, "AL"],
  [370, 385, "TN"],
  [100, 149, "NY"],
  [900, 961, "CA"],
];

const STATE_NAMES: Record<string, string> = {
  florida: "FL",
  georgia: "GA",
  texas: "TX",
  california: "CA",
  newyork: "NY",
  northcarolina: "NC",
  southcarolina: "SC",
  alabama: "AL",
  tennessee: "TN",
};

export function zipState(zip: string) {
  const prefix = Number(zip.replace(/\D/g, "").slice(0, 3));
  if (!Number.isFinite(prefix)) return null;
  return ZIP_RANGES.find(([low, high]) => prefix >= low && prefix <= high)?.[2] ?? null;
}

function cell(row: Record<string, string>, mapping: Partial<Record<TapeFieldKey, string>>, key: TapeFieldKey) {
  const header = mapping[key];
  if (!header) return "";
  return (row[header] ?? "").trim();
}

export function reviewTape(rows: Record<string, string>[], mapping: Partial<Record<TapeFieldKey, string>>, now = new Date()): TapeFlag[] {
  const flags: TapeFlag[] = [];
  const payWidth = tapePayWidth(rows, mapping);
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const city = cell(row, mapping, "city");
    const upbRaw = cell(row, mapping, "upb");
    const street = cell(row, mapping, "streetAddress");
    const touched = Object.values(row).some((value) => String(value).trim());
    if (!touched || (!city && !upbRaw && !street && !cell(row, mapping, "state"))) return;
    const stateRaw = cell(row, mapping, "state");
    const state = normalizeState(stateRaw);
    if (state.fix) flags.push({ row: rowNumber, level: "fix", field: "state", message: state.fix });
    if (!state.value) flags.push({ row: rowNumber, level: "error", field: "state", message: "State is missing or not a US state." });
    if (!city) flags.push({ row: rowNumber, level: "error", field: "city", message: "City is missing." });
    const cityState = city.match(/,\s*([A-Za-z]{2})$/)?.[1]?.toUpperCase();
    if (cityState && state.value && (US_STATES as readonly string[]).includes(cityState) && cityState !== state.value) {
      flags.push({ row: rowNumber, level: "warn", field: "state", message: `City says ${cityState} and the state column says ${state.value}.` });
    }
    const upb = moneyValue(upbRaw);
    if (upb.fix) flags.push({ row: rowNumber, level: "fix", field: "upb", message: upb.fix });
    if (upb.value == null || upb.value <= 0) flags.push({ row: rowNumber, level: "error", field: "upb", message: "UPB is missing." });
    const value = moneyValue(cell(row, mapping, "estimatedValue"));
    if (value.fix) flags.push({ row: rowNumber, level: "fix", field: "value", message: value.fix });
    if (upb.value && value.value && value.value > 0 && upb.value / value.value > 1) {
      flags.push({
        row: rowNumber,
        level: "warn",
        field: "ltv",
        message: `LTV is ${Math.round((upb.value / value.value) * 100)}%, above 100% of the stated value.`,
      });
    }
    const rate = rateValue(cell(row, mapping, "interestRate"));
    if (rate.fix) flags.push({ row: rowNumber, level: "fix", field: "rate", message: rate.fix });
    if (rate.value != null && (rate.value < 1 || rate.value > 18)) {
      flags.push({ row: rowNumber, level: "warn", field: "rate", message: `Coupon ${rate.value.toFixed(2)}% is outside the usual 1–18% band.` });
    }
    if (rate.value != null && rate.value > 36) {
      flags.push({ row: rowNumber, level: "error", field: "rate", message: "Coupon is above 36% and will be rejected." });
    }
    const zipRaw = cell(row, mapping, "zip");
    const zip = zipRaw.replace(/\D/g, "").slice(0, 5);
    if (zipRaw && zipRaw.replace(/\D/g, "") !== zip) {
      flags.push({ row: rowNumber, level: "fix", field: "zip", message: "ZIP was trimmed to five digits." });
    }
    const zipped = zipState(zip);
    if (zipped && state.value && zipped !== state.value) {
      flags.push({ row: rowNumber, level: "warn", field: "state", message: `ZIP ${zip} usually sits in ${zipped}, not ${state.value}.` });
    }
    const lienRaw = cell(row, mapping, "lienPosition");
    if (lienRaw && /^(1st|2nd|3rd|first lien|second lien)$/i.test(lienRaw.trim())) {
      flags.push({ row: rowNumber, level: "fix", field: "lien", message: `Lien “${lienRaw}” will be read as a standard position.` });
    }
    const statusRaw = cell(row, mapping, "paymentStatus");
    if (statusRaw && /^(current|npl|re-?performing)$/i.test(statusRaw.trim())) {
      flags.push({ row: rowNumber, level: "fix", field: "status", message: `Status “${statusRaw}” will be mapped to a desk status.` });
    }
    const servicing = readServicing(row, mapping, payWidth);
    for (const note of servicing.notes) flags.push({ row: rowNumber, ...note });
    flags.push(...servicingFlags(rowNumber, servicing.record, parsePaymentStatus(statusRaw), cell(row, mapping, "monthsDelinquent"), now));
    flags.push(...riskFlags(rowNumber, servicing.record, {
      lien: lienRaw,
      upb: upb.value,
      value: value.value,
      maturity: parseDate(cell(row, mapping, "maturityDate")),
      now,
    }));
  });
  return flags;
}

const FIRST_LIEN = new Set(["1", "1st", "first", "firstlien"]);
const JUNIOR_LIEN = new Set(["2", "2nd", "second", "secondlien", "3", "3rd", "third", "thirdlien"]);

// Combined LTV for a junior lien: this loan and what is owed ahead of it, over the value. Null for a first lien,
// or when the senior balance, the UPB or the value is missing.
export function combinedLtv(input: { lien: string; upb: number | null; value: number | null; seniorLienBalance?: number | null }) {
  const lien = input.lien.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!JUNIOR_LIEN.has(lien) ||input.seniorLienBalance == null || !input.upb || !input.value || input.value <= 0) return null;
  return ((input.upb + input.seniorLienBalance) / input.value) * 100;
}

const PAYOFF_STALE_DAYS = 90;

// Tape v3. A payoff is the balance plus interest and fees, so one under the UPB is worth a second look. A balloon
// needs its date, and a past balloon means the whole balance is already due.
function riskFlags(row: number, record: ServicingRecord, loan: { lien: string; upb: number | null; value: number | null; maturity: Date | null; now: Date }) {
  const flags: TapeFlag[] = [];
  const warn = (field: string, message: string) => flags.push({ row, level: "warn", field, message });
  const { now } = loan;
  if (record.payoffAmount != null && loan.upb && record.payoffAmount < loan.upb - 1) {
    warn("payoffAmount", `The payoff, ${record.payoffAmount.toLocaleString("en-US")}, is less than the UPB. A payoff is usually the balance plus interest and fees.`);
  }
  if (record.payoffAsOf && record.payoffAsOf.getTime() < now.getTime() - PAYOFF_STALE_DAYS * DAY) {
    warn("payoffAsOf", `The payoff is good through ${day(record.payoffAsOf)}, more than ${PAYOFF_STALE_DAYS} days ago. Ask the servicer for a new quote.`);
  }
  if (record.paymentType === "BALLOON" && !record.balloonDate) warn("balloonDate", "The payment type is balloon, but the balloon date is missing.");
  if (record.balloonDate && loan.maturity && record.balloonDate.getTime() > loan.maturity.getTime() + DAY) {
    warn("balloonDate", `The balloon date, ${day(record.balloonDate)}, is after the maturity date.`);
  }
  if (record.balloonDate && record.balloonDate.getTime() < now.getTime() - DAY) {
    warn("balloonDate", `The balloon date, ${day(record.balloonDate)}, has passed, so the whole balance is due.`);
  }
  const armTerms = Boolean(record.armIndex) || record.armMargin != null || record.armNextReset != null;
  if (record.paymentType === "ARM" && !armTerms) warn("paymentType", "The payment type is ARM, but the index and the margin are missing.");
  if (record.paymentType === "FIXED" && armTerms) warn("paymentType", "The payment type is fixed, but the tape carries ARM terms.");
  const lien = loan.lien.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (record.seniorLienBalance != null && FIRST_LIEN.has(lien)) {
    warn("seniorLienBalance", "A first lien has nothing ahead of it, so the senior lien balance won't count in its LTV.");
  }
  const combined = combinedLtv({ ...loan, seniorLienBalance: record.seniorLienBalance });
  // A UPB over the value is already flagged on its own.
  if (combined != null && combined > 100 && loan.upb != null && loan.value != null && loan.upb <= loan.value) {
    warn("ltv", `Combined LTV is ${Math.round(combined)}% with the senior lien, above 100% of the stated value.`);
  }
  return flags;
}

const SEVERITY = { error: 0, warn: 1, fix: 2 } as const;

// The preview shows the first 40 flags, so errors go first and the counts cover the whole tape.
export function flagSummary(flags: TapeFlag[], limit = 40) {
  return {
    flags: [...flags].sort((a, b) => SEVERITY[a.level] - SEVERITY[b.level]).slice(0, limit),
    errors: flags.filter((flag) => flag.level === "error").length,
    warnings: flags.filter((flag) => flag.level === "warn").length,
    fixes: flags.filter((flag) => flag.level === "fix").length,
  };
}

const DAY = 86400000;

// Whole months since the next due date: a payment due 1 October is a month behind on 5 November, current on 30 October.
export function monthsPastDue(nextDue: Date, now: Date) {
  const months =
    (now.getUTCFullYear() - nextDue.getUTCFullYear()) * 12 +
    now.getUTCMonth() -
    nextDue.getUTCMonth() -
    (now.getUTCDate() < nextDue.getUTCDate() ? 1 : 0);
  return Math.max(0, months);
}

function monthsText(months: number) {
  return months === 1 ? "1 month" : `${months} months`;
}

function day(date: Date) {
  return date.toISOString().slice(0, 10);
}

// Checks a real servicing record needs: the pay string, the next due date and months delinquent should tell one story,
// filing dates can't be ahead of today, and a value over a year old needs refreshing before anyone prices from it.
function servicingFlags(row: number, record: ServicingRecord, status: string | null, monthsRaw: string, now: Date) {
  const flags: TapeFlag[] = [];
  const warn = (field: TapeFieldKey, message: string) => flags.push({ row, level: "warn", field, message });
  const latest = record.payString?.[0];
  const behind = latest && latest !== "X" ? Number(latest) : null;
  const behindText = behind === 9 ? "9 or more months" : behind != null ? monthsText(behind) : "";
  if (behind != null && behind >= 2 && status === "PERFORMING") {
    warn("payString", `The pay string's newest month is ${behindText} behind, but the status is performing.`);
  }
  if (behind === 0 && status === "NON_PERFORMING") {
    warn("payString", "The pay string's newest month was paid on time, but the status is non-performing.");
  }
  const months = monthsDelinquentFrom(monthsRaw, record.payString);
  if (behind != null && monthsRaw && (behind === 9 ? months < 9 : behind !== months)) {
    warn("payString", `The pay string's newest month is ${behindText} behind, but months delinquent says ${months}.`);
  }
  if (record.nextDueDate) {
    const due = monthsPastDue(record.nextDueDate, now);
    // A 9 in the pay string means nine or more, so months read from it are a floor. A month either way is cutoff timing.
    const floor = !monthsRaw && payStringMonths(record.payString) === 9;
    if (Math.abs(due - months) > 1 && !(floor && due >= 8)) {
      const reading = due === 0 ? "current" : `about ${monthsText(due)} behind`;
      warn("nextDueDate", `Next due ${day(record.nextDueDate)} puts the loan ${reading}, but months delinquent ${monthsRaw ? "says" : "will be stored as"} ${months}.`);
    }
  }
  // A day of slack, so a date typed in a timezone ahead of the server isn't called the future.
  const future = (date: Date | undefined) => date != null && date.getTime() > now.getTime() + DAY;
  if (future(record.bankruptcyFiledAt)) warn("bankruptcyFiledAt", `Bankruptcy filed date ${day(record.bankruptcyFiledAt!)} is in the future.`);
  if (future(record.foreclosureFiledAt)) warn("foreclosureFiledAt", `Foreclosure filed date ${day(record.foreclosureFiledAt!)} is in the future.`);
  const yearAgo = new Date(now);
  yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1);
  if (record.valueAsOf && record.valueAsOf < yearAgo) {
    warn("valueAsOf", `The value is dated ${day(record.valueAsOf)}, more than 12 months ago.`);
  }
  flags.push(...termsFlags(row, record, now, yearAgo));
  return flags;
}

// Tape v2.1. Any one ARM term says the rate adjusts, and a buyer can't project the payment without both the index
// and the margin. A reset date already past, or a credit score over a year old, means the tape is out of date.
function termsFlags(row: number, record: ServicingRecord, now: Date, yearAgo: Date) {
  const flags: TapeFlag[] = [];
  const warn = (field: TapeFieldKey, message: string) => flags.push({ row, level: "warn", field, message });
  const arm = Boolean(record.armIndex) || record.armMargin != null || record.armNextReset != null;
  if (arm && !record.armIndex && record.armMargin == null) {
    warn("armIndex", "This loan reads as an adjustable rate, but the index and the margin are missing.");
  } else if (arm && !record.armIndex) {
    warn("armIndex", "This loan reads as an adjustable rate, but the index is missing.");
  } else if (arm && record.armMargin == null) {
    warn("armMargin", "This loan reads as an adjustable rate, but the margin is missing.");
  }
  if (record.armNextReset && record.armNextReset.getTime() < now.getTime() - DAY) {
    warn("armNextReset", `The next rate reset, ${day(record.armNextReset)}, is in the past. Ask the servicer for the current reset date.`);
  }
  if (record.creditScore != null && !record.creditScoreType) {
    warn("creditScoreType", "The credit score has no model. FICO and VantageScore read differently, so map a score model column.");
  }
  if (record.creditScoreDate && record.creditScoreDate < yearAgo) {
    warn("creditScoreDate", `The credit score is dated ${day(record.creditScoreDate)}, more than 12 months ago.`);
  }
  return flags;
}

function normalizeState(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return { value: null as string | null, fix: "" };
  const upper = trimmed.toUpperCase();
  if ((US_STATES as readonly string[]).includes(upper)) return { value: upper, fix: "" };
  const named = STATE_NAMES[trimmed.toLowerCase().replace(/[^a-z]/g, "")];
  if (named) return { value: named, fix: `“${trimmed}” will be stored as ${named}.` };
  return { value: null, fix: "" };
}

function moneyValue(raw: string) {
  if (!raw) return { value: null as number | null, fix: "" };
  const cleaned = raw.replace(/[$,\s]/g, "");
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return { value: null, fix: "" };
  const fix = raw !== cleaned ? `“${raw}” will be read as ${value.toLocaleString("en-US")}.` : "";
  return { value, fix };
}

function rateValue(raw: string) {
  if (!raw) return { value: null as number | null, fix: "" };
  const cleaned = raw.replace(/[%$,\s]/g, "");
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return { value: null, fix: "" };
  if (raw.includes("%")) return { value, fix: "The percent sign will be dropped." };
  if (value > 0 && value < 1) return { value: value * 100, fix: `${raw} will be read as ${(value * 100).toFixed(2)}%.` };
  return { value, fix: "" };
}
