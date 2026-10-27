import { US_STATES } from "@/lib/labels";
import type { TapeFieldKey } from "@/lib/tape-fields";

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

export function reviewTape(rows: Record<string, string>[], mapping: Partial<Record<TapeFieldKey, string>>): TapeFlag[] {
  const flags: TapeFlag[] = [];
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
  });
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
  if (value > 0 && value <= 1) return { value: value * 100, fix: `${raw} will be read as ${(value * 100).toFixed(2)}%.` };
  if (raw.includes("%")) return { value, fix: "The percent sign will be dropped." };
  return { value, fix: "" };
}
