import type { CollateralKind, CollateralStatus, DocType, RiskKind, RiskResult } from "@prisma/client";
import { audit } from "@/lib/audit";
import { money, pct, prettyDate } from "@/lib/format";
import { FORECLOSURES, LIEN_POSITIONS, OCCUPANCIES, PAYMENT_STATUSES, PROPERTY_TYPES } from "@/lib/labels";
import { typedNumber } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { extensionOf, mimeFor, putBytes, safeBasename } from "@/lib/storage";
import { uploadProblem } from "@/lib/uploads";

// The verified loan file: the desk checks the paper once, before the price, and every bidder sees the same
// record. Everything here is descriptive. There is no score: a buyer reads what is on file and what is not.

// ---------------------------------------------------------------------------------------------------------
// Collateral

export const COLLATERAL_LABELS: Record<CollateralKind, string> = {
  ORIGINAL_NOTE: "Original note",
  ALLONGE: "Allonge",
  MORTGAGE: "Mortgage or deed of trust",
  ASSIGNMENT: "Assignment",
  TITLE_POLICY: "Title policy",
  OE_REPORT: "O&E report",
  PAY_HISTORY: "Pay history",
  BPO: "BPO",
};

export const COLLATERAL_STATUSES: { value: CollateralStatus; label: string }[] = [
  { value: "PRESENT", label: "On file" },
  { value: "MISSING", label: "Missing" },
  { value: "DEFECTIVE", label: "Defective" },
  { value: "NOT_REQUIRED", label: "Not required" },
];

export function collateralStatusLabel(status: string) {
  return COLLATERAL_STATUSES.find((row) => row.value === status)?.label ?? status;
}

export const CHAIN_KINDS = ["ALLONGE", "ASSIGNMENT"] as const;
export type ChainKind = (typeof CHAIN_KINDS)[number];

export function isChainKind(kind: string): kind is ChainKind {
  return (CHAIN_KINDS as readonly string[]).includes(kind);
}

export type ChecklistLine = { kind: CollateralKind; label: string; required: boolean; chain: boolean; hint: string };

// What a buyer's custodian expects in the file. A junior lien rarely closed with its own lender's policy, so
// there the O&E report carries the title work and shows what sits ahead.
export function standardChecklist(lienPosition: string): ChecklistLine[] {
  const junior = lienPosition !== "FIRST";
  const lines: Omit<ChecklistLine, "label">[] = [
    { kind: "ORIGINAL_NOTE", required: true, chain: false, hint: "The signed note, endorsed to the holder or in blank." },
    { kind: "ALLONGE", required: true, chain: true, hint: "Each endorsement from the originator to today's holder. Mark it not required when the note's face carries them." },
    { kind: "MORTGAGE", required: true, chain: false, hint: "The recorded mortgage or deed of trust." },
    { kind: "ASSIGNMENT", required: true, chain: true, hint: "Each recorded assignment from the originator to today's holder. Mark it not required when the seller originated the loan." },
    {
      kind: "TITLE_POLICY",
      required: !junior,
      chain: false,
      hint: junior ? "Junior liens often closed without a lender's policy. The O&E shows what sits ahead." : "The lender's title policy.",
    },
    {
      kind: "OE_REPORT",
      required: true,
      chain: false,
      hint: junior ? "Owner and encumbrances: the senior lien and anything else recorded ahead of this one." : "Owner and encumbrances: who holds title and what is recorded against it.",
    },
    { kind: "PAY_HISTORY", required: true, chain: false, hint: "The servicer's payment history." },
    { kind: "BPO", required: true, chain: false, hint: "A broker price opinion or appraisal." },
  ];
  return lines.map((line) => ({ ...line, label: COLLATERAL_LABELS[line.kind] }));
}

export type CollateralRow = {
  id: string;
  kind: string;
  status: string;
  sequence: number;
  detail?: string;
  cureOwner?: string;
  cureBy?: Date | null;
  recordedAt?: Date | null;
  recording?: string;
  documentId?: string | null;
  updatedById?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

export function sortChain<T extends { sequence: number; createdAt?: Date }>(rows: T[]) {
  return [...rows].sort((a, b) => a.sequence - b.sequence || (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
}

// The checklist with what the desk has on file under each line. A line with nothing under it hasn't been reviewed.
export function collateralLines<T extends CollateralRow>(lienPosition: string, items: T[]) {
  return standardChecklist(lienPosition).map((line) => ({ ...line, items: sortChain(items.filter((item) => item.kind === line.kind)) }));
}

// ---------------------------------------------------------------------------------------------------------
// Chain of title

// The desk enters each link's parties separately. They are kept in the line's detail as "From → To · note",
// so the chain can be read back and checked without another field.
const ARROW = "→";

function cleanParty(value: string) {
  return value.replaceAll(ARROW, "-").replace(/\s+/g, " ").trim().slice(0, 120);
}

export function chainDetail(from: string, to: string, note = "") {
  const extra = note.replace(/\s+/g, " ").trim().slice(0, 200);
  // A line marked not required carries only its reason.
  if (!cleanParty(from) && !cleanParty(to)) return extra;
  const parties = `${cleanParty(from)} ${ARROW} ${cleanParty(to)}`;
  return extra ? `${parties} · ${extra}` : parties;
}

export function chainParties(detail: string | undefined) {
  const text = detail ?? "";
  const [head, ...rest] = text.split(" · ");
  const at = head.indexOf(ARROW);
  if (at < 0) return { from: "", to: "", note: text.trim() };
  return { from: head.slice(0, at).trim(), to: head.slice(at + 1).trim(), note: rest.join(" · ").trim() };
}

const LEGAL_FORMS = /\b(llc|l l c|inc|incorporated|corp|corporation|co|company|ltd|lp|llp|na|n a|fsb|plc|the)\b/g;

// Two spellings of one party ("First Bank, N.A." and "First Bank NA") read as the same party.
export function partyKey(name: string) {
  return name
    .toLowerCase()
    .replace(/[.,'"’]/g, "")
    .replace(/&/g, " and ")
    .replace(LEGAL_FORMS, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function inBlank(name: string) {
  return ["blank", "in blank", "bearer"].includes(partyKey(name));
}

function sameParty(a: string, b: string) {
  const left = partyKey(a);
  const right = partyKey(b);
  if (!left || !right) return false;
  if (left === right) return true;
  // "Coastal Capital" and "Coastal Capital Fund I" are one party written short.
  return Math.min(left.length, right.length) >= 4 && (left.startsWith(right) || right.startsWith(left));
}

// An endorsement in blank makes the note bearer paper, so whoever holds it may endorse it on.
function follows(previousTo: string, from: string) {
  return inBlank(previousTo) || sameParty(previousTo, from);
}

export type ChainLink = {
  id: string;
  sequence: number;
  position: number;
  from: string;
  to: string;
  note: string;
  status: string;
  recordedAt: Date | null;
  recording: string;
  documentId: string | null;
  // Nothing on file moves the paper from the previous link's holder to this link's grantor.
  gap: boolean;
};

// A missing or defective link is also a collateral defect. It is listed here so the chain reads whole, and
// marked so the file's open defects don't count it twice.
export type ChainBreak = { position: number | null; message: string; fromStatus?: boolean };

export type Chain = {
  kind: ChainKind;
  label: string;
  links: ChainLink[];
  breaks: ChainBreak[];
  // The desk marked the chain not required. The reason, which may be empty, is in the detail.
  waived: string | null;
  endsInBlank: boolean;
};

function buildChain(kind: ChainKind, items: CollateralRow[], holder: string | null | undefined): Chain {
  const rows = sortChain(items.filter((item) => item.kind === kind));
  const live = rows.filter((row) => row.status !== "NOT_REQUIRED");
  const waivedRow = rows.length > 0 && live.length === 0 ? rows[rows.length - 1] : null;
  const noun = kind === "ALLONGE" ? "endorsement" : "assignment";
  const breaks: ChainBreak[] = [];
  const links = live.map((row, index): ChainLink => {
    const parties = chainParties(row.detail);
    const previous = index > 0 ? chainParties(live[index - 1].detail) : null;
    const position = index + 1;
    const gap = Boolean(previous && previous.to && parties.from && !follows(previous.to, parties.from));
    if (!parties.from || !parties.to) breaks.push({ position, message: `The ${noun} at step ${position} doesn't name both parties.` });
    if (gap && previous) breaks.push({ position, message: `Nothing on file moves it from ${previous.to} to ${parties.from}.` });
    if (row.status === "MISSING") breaks.push({ position, message: `The ${noun} at step ${position} is missing.`, fromStatus: true });
    if (row.status === "DEFECTIVE") breaks.push({ position, message: `The ${noun} at step ${position} is defective.`, fromStatus: true });
    return {
      id: row.id,
      sequence: row.sequence,
      position,
      from: parties.from,
      to: parties.to,
      note: parties.note,
      status: row.status,
      recordedAt: row.recordedAt ?? null,
      recording: row.recording ?? "",
      documentId: row.documentId ?? null,
      gap,
    };
  });
  const last = links[links.length - 1];
  const endsInBlank = Boolean(last && inBlank(last.to));
  if (last && last.to && holder && !endsInBlank && !sameParty(last.to, holder)) {
    breaks.push({ position: null, message: `The chain ends with ${last.to}, not the seller on file, ${holder}.` });
  }
  return {
    kind,
    label: kind === "ALLONGE" ? "Endorsements on the note" : "Assignments of the mortgage",
    links,
    breaks,
    waived: waivedRow ? chainParties(waivedRow.detail).note : null,
    endsInBlank,
  };
}

// The note travels by endorsement and the mortgage by recorded assignment. Each chain should run from the
// originator to today's holder with no gap. Breaks are listed in plain words, not scored. `breaks` counts the
// gaps, unnamed parties and wrong last holders; a missing link is already counted as a collateral defect.
export function chainOfTitle(items: CollateralRow[], holder?: string | null) {
  const endorsements = buildChain("ALLONGE", items, holder);
  const assignments = buildChain("ASSIGNMENT", items, holder);
  const gaps = [...endorsements.breaks, ...assignments.breaks].filter((item) => !item.fromStatus).length;
  return { endorsements, assignments, breaks: gaps };
}

// ---------------------------------------------------------------------------------------------------------
// Risk card

export const RISK_KINDS: { kind: RiskKind; label: string; hint: string }[] = [
  { kind: "BANKRUPTCY", label: "Bankruptcy", hint: "An open case on the borrower. Clear means none found." },
  { kind: "TAX", label: "Property tax", hint: "Delinquent county or city tax. Clear means paid to date." },
  { kind: "LIENS", label: "Other liens", hint: "Judgments, HOA and code liens, and any senior lien not on the tape." },
  { kind: "PRE_FORECLOSURE", label: "Pre-foreclosure", hint: "A recorded default, lis pendens or sale notice." },
  { kind: "OCCUPANCY", label: "Occupancy", hint: "Who lives there, checked against the tape. Clear means it matches." },
];

export const RISK_RESULTS: { value: RiskResult; label: string }[] = [
  { value: "CLEAR", label: "Clear" },
  { value: "FLAG", label: "Flag" },
  { value: "UNKNOWN", label: "Unknown" },
];

export function riskKindLabel(kind: string) {
  return RISK_KINDS.find((row) => row.kind === kind)?.label ?? kind;
}

export function riskResultLabel(result: string) {
  return RISK_RESULTS.find((row) => row.value === result)?.label ?? result;
}

export type RiskRow = { id: string; kind: string; result: string; detail?: string; source?: string; documentId?: string | null; checkedById?: string | null; checkedAt: Date };

// The newest check of each kind is the one that stands. Older ones stay in the log.
export function latestChecks<T extends RiskRow>(risks: T[]) {
  const latest = {} as Record<RiskKind, T | null>;
  for (const { kind } of RISK_KINDS) {
    latest[kind] = risks.filter((risk) => risk.kind === kind).sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime())[0] ?? null;
  }
  return latest;
}

// ---------------------------------------------------------------------------------------------------------
// Fields: what the tape says, and whether the desk checked it against a document

type FieldKind = "money" | "percent" | "number" | "date" | "choice" | "bool" | "text";

export type FieldSpec = {
  field: string;
  label: string;
  kind: FieldKind;
  options?: readonly { value: string; label: string }[];
  // Street, borrower and the servicer's loan number identify the borrower. They follow the loan's access rule.
  identity?: boolean;
  // Balances and rates sit behind Pro, as on the rest of the listing.
  pro?: boolean;
  // Counted in "key fields verified".
  key?: boolean;
  // Tape v2 fields show only where the tape carries them.
  optional?: boolean;
  // The document the desk usually checks this against.
  source: string;
};

export const VALUE_TYPES = [
  { value: "BPO", label: "BPO" },
  { value: "AVM", label: "AVM" },
  { value: "APPRAISAL", label: "Appraisal" },
  { value: "SELLER", label: "Seller's estimate" },
] as const;

export const LOAN_PURPOSES = [
  { value: "PURCHASE", label: "Purchase" },
  { value: "REFINANCE", label: "Refinance" },
  { value: "CASH_OUT", label: "Cash-out refinance" },
  { value: "SELLER_FINANCED", label: "Seller financed" },
  { value: "BUSINESS", label: "Business purpose" },
] as const;

export const LOAN_FIELDS: FieldSpec[] = [
  { field: "streetAddress", label: "Street", kind: "text", identity: true, key: true, source: "Mortgage or deed of trust" },
  { field: "borrowerName", label: "Borrower", kind: "text", identity: true, key: true, source: "Original note" },
  { field: "loanNumber", label: "Loan number", kind: "text", identity: true, optional: true, source: "Servicer statement" },
  { field: "propertyType", label: "Property", kind: "choice", options: PROPERTY_TYPES, source: "BPO" },
  { field: "occupancy", label: "Occupancy", kind: "choice", options: OCCUPANCIES, key: true, source: "BPO" },
  { field: "lienPosition", label: "Lien", kind: "choice", options: LIEN_POSITIONS, key: true, source: "O&E report" },
  { field: "paymentStatus", label: "Performance", kind: "choice", options: PAYMENT_STATUSES, key: true, source: "Pay history" },
  { field: "monthsDelinquent", label: "Months delinquent", kind: "number", source: "Pay history" },
  { field: "foreclosureStatus", label: "Foreclosure", kind: "choice", options: FORECLOSURES, source: "County records" },
  { field: "interestRate", label: "Note rate", kind: "percent", pro: true, key: true, source: "Original note" },
  { field: "monthlyPi", label: "Monthly P&I", kind: "money", pro: true, key: true, source: "Original note" },
  { field: "upb", label: "UPB", kind: "money", pro: true, key: true, source: "Pay history" },
  { field: "estimatedValue", label: "Estimated value", kind: "money", pro: true, key: true, source: "BPO" },
  { field: "lastPaidDate", label: "Last paid", kind: "date", key: true, source: "Pay history" },
  { field: "originationDate", label: "Origination", kind: "date", source: "Original note" },
  { field: "maturityDate", label: "Maturity", kind: "date", key: true, source: "Original note" },
  { field: "nextDueDate", label: "Next due", kind: "date", key: true, optional: true, source: "Pay history" },
  { field: "payString", label: "Pay string", kind: "text", optional: true, source: "Pay history" },
  { field: "servicerName", label: "Servicer", kind: "text", optional: true, source: "Servicer statement" },
  { field: "modified", label: "Modified", kind: "bool", optional: true, source: "Servicer statement" },
  { field: "modificationDate", label: "Modification date", kind: "date", optional: true, source: "Servicer statement" },
  { field: "lossMitigation", label: "Loss mitigation", kind: "text", optional: true, source: "Servicer statement" },
  { field: "bankruptcyChapter", label: "Bankruptcy chapter", kind: "text", optional: true, source: "Court records" },
  { field: "bankruptcyFiledAt", label: "Bankruptcy filed", kind: "date", optional: true, source: "Court records" },
  { field: "foreclosureFiledAt", label: "Foreclosure filed", kind: "date", optional: true, source: "County records" },
  { field: "valueType", label: "Value type", kind: "choice", options: VALUE_TYPES, optional: true, source: "BPO" },
  { field: "valueAsOf", label: "Value as of", kind: "date", optional: true, source: "BPO" },
  { field: "loanPurpose", label: "Loan purpose", kind: "choice", options: LOAN_PURPOSES, optional: true, source: "Original note" },
  { field: "hoaLien", label: "HOA lien", kind: "bool", optional: true, source: "O&E report" },
  { field: "taxDelinquent", label: "Tax delinquent", kind: "bool", optional: true, source: "County records" },
];

const FIELD_BY_NAME = new Map(LOAN_FIELDS.map((spec) => [spec.field, spec]));

export function fieldSpec(field: string) {
  return FIELD_BY_NAME.get(field) ?? null;
}

export function fieldLabel(field: string) {
  return FIELD_BY_NAME.get(field)?.label ?? field;
}

export const KEY_FIELDS = LOAN_FIELDS.filter((spec) => spec.key).map((spec) => spec.field);

// Where the desk looked. Kept short, since it reads inline in a badge: "Verified · pay history, Oct 2 2026".
export const VERIFY_SOURCES = [
  "Original note",
  "Allonge",
  "Mortgage or deed of trust",
  "Assignment",
  "Title policy",
  "O&E report",
  "Pay history",
  "Servicer statement",
  "BPO",
  "Appraisal",
  "County records",
  "Court records",
  "Borrower contact",
  "Other",
] as const;

// One spelling per value, so a check made against "$120,000" still matches a tape that says 120000.
export function canonical(spec: FieldSpec, raw: unknown): string | null {
  if (raw == null) return null;
  if (spec.kind === "money" || spec.kind === "percent" || spec.kind === "number") {
    const value = typeof raw === "number" ? raw : typedNumber(raw);
    return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : null;
  }
  if (spec.kind === "date") {
    const date = raw instanceof Date ? raw : new Date(String(raw));
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  if (spec.kind === "bool") {
    if (typeof raw === "boolean") return raw ? "yes" : "no";
    const text = String(raw).trim().toLowerCase();
    if (["yes", "y", "true", "1"].includes(text)) return "yes";
    if (["no", "n", "false", "0"].includes(text)) return "no";
    return null;
  }
  const text = String(raw).replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (spec.kind === "choice" && spec.options) {
    const lower = text.toLowerCase();
    return spec.options.find((option) => option.value.toLowerCase() === lower || option.label.toLowerCase() === lower)?.value ?? text;
  }
  return text;
}

function sameValue(spec: FieldSpec, a: string | null, b: string | null) {
  if (a == null || b == null) return a === b;
  return spec.kind === "text" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function displayValue(spec: FieldSpec, value: string | null) {
  if (value == null) return "—";
  if (spec.kind === "money") return money(Number(value));
  if (spec.kind === "percent") return pct(Number(value), 3);
  if (spec.kind === "date") return prettyDate(value);
  if (spec.kind === "bool") return value === "yes" ? "Yes" : "No";
  if (spec.kind === "choice") return spec.options?.find((option) => option.value === value)?.label ?? value;
  return value;
}

export function tapeValue(note: object, field: string) {
  const spec = fieldSpec(field);
  return spec ? canonical(spec, (note as Record<string, unknown>)[field]) : null;
}

export type VerifiedEntry = { at: string; by: string; source: string; value?: string | null; document?: string | null };

// Reads Note.verifiedFields defensively. Anything malformed is dropped, so it reads as seller-stated.
export function verifiedMap(json: unknown): Record<string, VerifiedEntry> {
  if (!json || typeof json !== "object" || Array.isArray(json)) return {};
  const out: Record<string, VerifiedEntry> = {};
  for (const [field, entry] of Object.entries(json as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.at !== "string" || typeof row.source !== "string" || Number.isNaN(new Date(row.at).getTime())) continue;
    out[field] = {
      at: row.at,
      by: typeof row.by === "string" ? row.by : "",
      source: row.source,
      ...(row.value === undefined ? {} : { value: typeof row.value === "string" ? row.value : null }),
      ...(typeof row.document === "string" ? { document: row.document } : {}),
    };
  }
  return out;
}

export type FieldState =
  | { state: "verified"; at: Date; by: string; source: string }
  // The desk checked the document and it says something else. The tape value still stands as the seller's.
  | { state: "disputed"; at: Date; by: string; source: string; document: string }
  // Nothing checked, or the tape changed after the desk checked it.
  | { state: "seller-stated"; changed?: { at: Date; by: string; source: string } };

export function fieldState(note: { verifiedFields?: unknown }, field: string): FieldState {
  const spec = fieldSpec(field);
  const entry = verifiedMap(note.verifiedFields)[field];
  if (!spec || !entry) return { state: "seller-stated" };
  const at = new Date(entry.at);
  const current = tapeValue(note, field);
  // A check holds only for the value it was made against. An edit or a new tape since then reopens it.
  if (entry.value !== undefined && !sameValue(spec, entry.value ?? null, current)) {
    return { state: "seller-stated", changed: { at, by: entry.by, source: entry.source } };
  }
  if (entry.document != null && !sameValue(spec, entry.document, current)) {
    return { state: "disputed", at, by: entry.by, source: entry.source, document: entry.document };
  }
  return { state: "verified", at, by: entry.by, source: entry.source };
}

// "Pay history" reads as "pay history" mid-sentence. "BPO" and "O&E report" keep their capitals.
export function inlineSource(source: string) {
  return /^[A-Z][a-z]/.test(source) ? source[0].toLowerCase() + source.slice(1) : source;
}

// ---------------------------------------------------------------------------------------------------------
// HOA super-lien states

// States where an association's lien for some months of unpaid dues outranks a recorded first mortgage, so a
// small HOA balance can cost the noteholder its lien (in Nevada, SFR Investments Pool 1 v. U.S. Bank, 2014;
// in DC, Chase Plaza Condominium v. JPMorgan Chase, 2014). Compiled from the Joint Editorial Board for Uniform
// Real Property Acts, "The Six-Month 'Limited Priority Lien' for Association Fees Under the Uniform Common
// Interest Ownership Act" (2013), and the statutes cited. "CONDO" covers condominiums only; "ASSOCIATION" also
// covers planned communities. Florida's is a safe harbor that caps what a foreclosing first mortgagee owes
// (12 months or 1% of the original debt) rather than a true priority, listed because it costs the buyer the
// same way. Statutes change: the desk checks the current text before it relies on an entry.
export const SUPER_LIEN_STATES: Record<string, { scope: "CONDO" | "ASSOCIATION"; cite: string }> = {
  AK: { scope: "ASSOCIATION", cite: "AS 34.08.470" },
  AL: { scope: "CONDO", cite: "Ala. Code § 35-8A-316" },
  CO: { scope: "ASSOCIATION", cite: "C.R.S. § 38-33.3-316" },
  CT: { scope: "ASSOCIATION", cite: "Conn. Gen. Stat. § 47-258" },
  DC: { scope: "CONDO", cite: "D.C. Code § 42-1903.13" },
  DE: { scope: "ASSOCIATION", cite: "25 Del. C. § 81-316" },
  FL: { scope: "CONDO", cite: "Fla. Stat. § 718.116" },
  HI: { scope: "CONDO", cite: "HRS § 514B-146" },
  IL: { scope: "CONDO", cite: "765 ILCS 605/9(g)(4)" },
  MA: { scope: "CONDO", cite: "M.G.L. c. 183A, § 6" },
  MD: { scope: "ASSOCIATION", cite: "Md. Real Prop. § 14-204" },
  MN: { scope: "ASSOCIATION", cite: "Minn. Stat. § 515B.3-116" },
  NH: { scope: "CONDO", cite: "RSA 356-B:46" },
  NJ: { scope: "CONDO", cite: "N.J.S.A. 46:8B-21" },
  NV: { scope: "ASSOCIATION", cite: "NRS 116.3116" },
  OR: { scope: "CONDO", cite: "ORS 100.450" },
  PA: { scope: "ASSOCIATION", cite: "68 Pa.C.S. §§ 3315, 5315" },
  RI: { scope: "CONDO", cite: "R.I. Gen. Laws § 34-36.1-3.16" },
  TN: { scope: "CONDO", cite: "Tenn. Code § 66-27-415" },
  VT: { scope: "ASSOCIATION", cite: "27A V.S.A. § 3-116" },
  WA: { scope: "ASSOCIATION", cite: "RCW 64.34.364, 64.90.485" },
  WV: { scope: "ASSOCIATION", cite: "W. Va. Code § 36B-3-116" },
};

export type SuperLienFlag = { state: string; cite: string; scope: "CONDO" | "ASSOCIATION"; certain: boolean; openLien: boolean; label: string };

// A condominium sits in an association by definition. A house or townhouse may or may not, so in a state whose
// rule covers planned communities it is flagged as conditional unless the tape says there is an HOA lien, or
// says there isn't.
export function superLien(note: { state: string; propertyType: string; hoaLien?: boolean | null }): SuperLienFlag | null {
  const state = note.state.trim().toUpperCase();
  const rule = SUPER_LIEN_STATES[state];
  if (!rule) return null;
  const openLien = note.hoaLien === true;
  const condo = note.propertyType === "CONDO";
  const base = { state, cite: rule.cite, scope: rule.scope, openLien };
  if (rule.scope === "CONDO") {
    if (!condo) return null;
    return { ...base, certain: true, label: openLien ? "Open HOA lien · super-lien state" : "HOA super-lien state" };
  }
  if (condo || openLien) {
    return { ...base, certain: true, label: openLien ? "Open HOA lien · super-lien state" : "HOA super-lien state" };
  }
  if (note.hoaLien === false || note.propertyType === "LAND" || note.propertyType === "COMMERCIAL") return null;
  return { ...base, certain: false, label: "Super-lien state if in an HOA" };
}

// ---------------------------------------------------------------------------------------------------------
// Completeness: a description of the file, never a grade

export type Completeness = {
  collateral: { present: number; required: number; missing: number; defective: number; unreviewed: number };
  checks: { run: number; total: number; flagged: number; unknown: number };
  fields: { verified: number; total: number; disputed: number };
  defects: { id: string; kind: string; label: string; status: string; cureOwner: string; cureBy: Date | null }[];
  chainBreaks: number;
  // Whether the desk has touched the file at all. An untouched file is all seller-stated.
  reviewed: boolean;
};

export function completeness(
  note: { lienPosition: string; verifiedFields?: unknown },
  collateral: CollateralRow[],
  risks: RiskRow[],
  options: { holder?: string | null } = {},
): Completeness {
  const counts = { present: 0, required: 0, missing: 0, defective: 0, unreviewed: 0 };
  for (const line of collateralLines(note.lienPosition, collateral)) {
    if (!line.items.length) {
      // An empty chain still needs a look: either the links are on file or the desk says none are needed.
      if (line.required) {
        counts.required += 1;
        counts.unreviewed += 1;
      }
      continue;
    }
    for (const item of line.items) {
      if (item.status === "NOT_REQUIRED") continue;
      counts.required += 1;
      if (item.status === "PRESENT") counts.present += 1;
      if (item.status === "MISSING") counts.missing += 1;
      if (item.status === "DEFECTIVE") counts.defective += 1;
    }
  }
  const latest = latestChecks(risks);
  const ran = RISK_KINDS.map(({ kind }) => latest[kind]).filter((row): row is RiskRow => row != null);
  const states = LOAN_FIELDS.map((spec) => ({ spec, state: fieldState(note, spec.field) }));
  const keyStates = states.filter((row) => row.spec.key);
  const defects = sortChain(collateral.filter((item) => item.status === "MISSING" || item.status === "DEFECTIVE")).map((item) => ({
    id: item.id,
    kind: item.kind,
    label: COLLATERAL_LABELS[item.kind as CollateralKind] ?? item.kind,
    status: item.status,
    cureOwner: item.cureOwner ?? "",
    cureBy: item.cureBy ?? null,
  }));
  return {
    collateral: counts,
    checks: { run: ran.length, total: RISK_KINDS.length, flagged: ran.filter((row) => row.result === "FLAG").length, unknown: ran.filter((row) => row.result === "UNKNOWN").length },
    fields: {
      verified: keyStates.filter((row) => row.state.state === "verified").length,
      total: keyStates.length,
      disputed: states.filter((row) => row.state.state === "disputed").length,
    },
    defects,
    chainBreaks: chainOfTitle(collateral, options.holder).breaks,
    reviewed: collateral.length > 0 || risks.length > 0 || Object.keys(verifiedMap(note.verifiedFields)).length > 0,
  };
}

// Rows for many loans at once, keyed by loan, so a pool's summaries cost one pass and not one per loan.
export function groupByNote<T extends { noteId: string }>(rows: T[]) {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.noteId);
    if (list) list.push(row);
    else map.set(row.noteId, [row]);
  }
  return map;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// One line for a table cell or a picker: "6 of 8 on file · 4 of 5 checks · 9 of 12 fields verified · 1 defect".
export function completenessLine(file: Completeness) {
  if (!file.reviewed) return "Not yet reviewed by the desk";
  const parts = [
    `${file.collateral.present} of ${file.collateral.required} on file`,
    `${file.checks.run} of ${file.checks.total} checks`,
    `${file.fields.verified} of ${file.fields.total} fields verified`,
  ];
  const open = file.defects.length + file.chainBreaks;
  if (open) parts.push(plural(open, "open defect"));
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------------------------------------
// Desk writes. Each returns a result instead of throwing, so the action can send the desk back with a sentence.

export type Outcome<T = null> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): Outcome<never> => ({ ok: false, error });

function optionalDate(raw: string | null | undefined, what: string): Outcome<Date | null> {
  const text = (raw ?? "").trim();
  if (!text) return { ok: true, value: null };
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? fail(`Enter the ${what} as a date.`) : { ok: true, value: date };
}

async function loanOnFile(noteId: string) {
  return noteId ? prisma.note.findUnique({ where: { id: noteId }, select: { id: true, listingId: true } }) : null;
}

// A linked file has to belong to this listing, and to this loan when it is a loan's own file.
async function documentForLoan(documentId: string | null | undefined, loan: { id: string; listingId: string }): Promise<Outcome<string | null>> {
  if (!documentId) return { ok: true, value: null };
  const document = await prisma.document.findUnique({ where: { id: documentId }, select: { id: true, listingId: true, noteId: true, type: true } });
  if (!document || document.listingId !== loan.listingId || (document.noteId && document.noteId !== loan.id) || document.type === "NDA") {
    return fail("That file isn't on this loan.");
  }
  return { ok: true, value: document.id };
}

export type CollateralInput = {
  id?: string | null;
  noteId: string;
  kind: string;
  status: string;
  detail?: string;
  cureOwner?: string;
  cureBy?: string | null;
  recordedAt?: string | null;
  recording?: string;
  documentId?: string | null;
};

export async function saveCollateralItem(actorId: string, input: CollateralInput) {
  if (!(input.kind in COLLATERAL_LABELS)) return fail("Pick a collateral line.");
  if (!COLLATERAL_STATUSES.some((row) => row.value === input.status)) return fail("Pick a status.");
  const loan = await loanOnFile(input.noteId);
  if (!loan) return fail("That loan isn't on file.");
  const cureBy = optionalDate(input.cureBy, "cure date");
  if (!cureBy.ok) return cureBy;
  const recordedAt = optionalDate(input.recordedAt, "recording date");
  if (!recordedAt.ok) return recordedAt;
  const documentId = await documentForLoan(input.documentId, loan);
  if (!documentId.ok) return documentId;
  const data = {
    status: input.status as CollateralStatus,
    detail: (input.detail ?? "").trim().slice(0, 400),
    cureOwner: (input.cureOwner ?? "").trim().slice(0, 120),
    cureBy: cureBy.value,
    recordedAt: recordedAt.value,
    recording: (input.recording ?? "").trim().slice(0, 120),
    documentId: documentId.value,
    updatedById: actorId,
  };
  let item;
  if (input.id) {
    const existing = await prisma.collateralItem.findUnique({ where: { id: input.id } });
    if (!existing || existing.noteId !== loan.id) return fail("That line isn't on this loan.");
    item = await prisma.collateralItem.update({ where: { id: existing.id }, data });
  } else {
    const kind = input.kind as CollateralKind;
    // A new link goes on the end of its chain. The desk moves it if it belongs earlier.
    const sequence = isChainKind(kind) ? (await prisma.collateralItem.count({ where: { noteId: loan.id, kind } })) + 1 : 0;
    item = await prisma.collateralItem.create({ data: { noteId: loan.id, kind, sequence, ...data } });
  }
  await audit(actorId, input.id ? "COLLATERAL_UPDATE" : "COLLATERAL_ADD", "note", loan.id, `${item.kind}${isChainKind(item.kind) ? ` #${item.sequence}` : ""} · ${item.status}`);
  return { ok: true as const, value: item };
}

// Numbers a chain 1 to n in the order given, so moves and removals never leave two links on one step.
async function renumber(noteId: string, kind: ChainKind, order?: string[]) {
  const rows = sortChain(await prisma.collateralItem.findMany({ where: { noteId, kind } }));
  const ids = order ?? rows.map((row) => row.id);
  await Promise.all(ids.map((id, index) => prisma.collateralItem.update({ where: { id }, data: { sequence: index + 1 } })));
}

export async function removeCollateralItem(actorId: string, input: { noteId: string; id: string }) {
  const existing = input.id ? await prisma.collateralItem.findUnique({ where: { id: input.id } }) : null;
  if (!existing || existing.noteId !== input.noteId) return fail("That line isn't on this loan.");
  await prisma.collateralItem.delete({ where: { id: existing.id } });
  if (isChainKind(existing.kind)) await renumber(existing.noteId, existing.kind);
  await audit(actorId, "COLLATERAL_REMOVE", "note", existing.noteId, `${existing.kind}${isChainKind(existing.kind) ? ` #${existing.sequence}` : ""}`);
  return { ok: true as const, value: null };
}

export async function moveChainLink(actorId: string, input: { noteId: string; id: string; direction: "up" | "down" }) {
  const existing = input.id ? await prisma.collateralItem.findUnique({ where: { id: input.id } }) : null;
  if (!existing || existing.noteId !== input.noteId || !isChainKind(existing.kind)) return fail("That link isn't on this loan's chain.");
  const rows = sortChain(await prisma.collateralItem.findMany({ where: { noteId: existing.noteId, kind: existing.kind } }));
  const order = rows.map((row) => row.id);
  const at = order.indexOf(existing.id);
  const to = input.direction === "up" ? at - 1 : at + 1;
  if (to < 0 || to >= order.length) return { ok: true as const, value: null };
  [order[at], order[to]] = [order[to], order[at]];
  await renumber(existing.noteId, existing.kind, order);
  await audit(actorId, "COLLATERAL_REORDER", "note", existing.noteId, `${existing.kind} #${at + 1} to #${to + 1}`);
  return { ok: true as const, value: null };
}

export type RiskInput = { noteId: string; kind: string; result: string; source: string; detail?: string; documentId?: string | null; checkedAt?: string | null };

export async function logRiskCheck(actorId: string, input: RiskInput) {
  if (!RISK_KINDS.some((row) => row.kind === input.kind)) return fail("Pick the check that was run.");
  if (!RISK_RESULTS.some((row) => row.value === input.result)) return fail("Pick a result.");
  const source = input.source.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!source) return fail("Name where the desk looked, such as PACER or the county tax collector.");
  const loan = await loanOnFile(input.noteId);
  if (!loan) return fail("That loan isn't on file.");
  const checked = optionalDate(input.checkedAt, "check date");
  if (!checked.ok) return checked;
  if (checked.value && checked.value.getTime() > Date.now() + 24 * 60 * 60 * 1000) return fail("A check can't be dated in the future.");
  const documentId = await documentForLoan(input.documentId, loan);
  if (!documentId.ok) return documentId;
  const check = await prisma.riskCheck.create({
    data: {
      noteId: loan.id,
      kind: input.kind as RiskKind,
      result: input.result as RiskResult,
      source,
      detail: (input.detail ?? "").trim().slice(0, 400),
      documentId: documentId.value,
      checkedById: actorId,
      checkedAt: checked.value ?? new Date(),
    },
  });
  await audit(actorId, "RISK_CHECK", "note", loan.id, `${check.kind} · ${check.result} · ${source}`);
  return { ok: true as const, value: check };
}

export async function markFieldVerified(actorId: string, input: { noteId: string; field: string; source: string; document?: string | null }) {
  const spec = fieldSpec(input.field);
  if (!spec) return fail("That field can't be verified.");
  const source = input.source.replace(/\s+/g, " ").trim().slice(0, 60);
  if (!source) return fail("Name the document the desk checked.");
  const note = input.noteId ? await prisma.note.findUnique({ where: { id: input.noteId } }) : null;
  if (!note) return fail("That loan isn't on file.");
  const current = tapeValue(note, spec.field);
  const typed = (input.document ?? "").trim();
  const document = typed ? canonical(spec, typed) : null;
  if (typed && document == null) return fail(`That doesn't read as a ${spec.kind === "money" || spec.kind === "percent" ? "number" : spec.kind === "bool" ? "yes or no" : spec.kind}.`);
  if (current == null && document == null) return fail("The tape has nothing here. Enter what the document shows.");
  const entry: VerifiedEntry = {
    at: new Date().toISOString(),
    by: actorId,
    source,
    value: current,
    ...(document != null && !sameValue(spec, document, current) ? { document } : {}),
  };
  const map = verifiedMap(note.verifiedFields);
  map[spec.field] = entry;
  await prisma.note.update({ where: { id: note.id }, data: { verifiedFields: map } });
  // Values stay out of the log: a street or a borrower's name doesn't belong in the audit trail.
  await audit(actorId, "FIELD_VERIFY", "note", note.id, `${spec.field} · ${source}${entry.document != null ? " · differs from the tape" : ""}`);
  return { ok: true as const, value: entry };
}

export async function clearFieldVerified(actorId: string, input: { noteId: string; field: string }) {
  const note = input.noteId ? await prisma.note.findUnique({ where: { id: input.noteId }, select: { id: true, verifiedFields: true } }) : null;
  if (!note) return fail("That loan isn't on file.");
  const map = verifiedMap(note.verifiedFields);
  if (!map[input.field]) return { ok: true as const, value: null };
  delete map[input.field];
  await prisma.note.update({ where: { id: note.id }, data: { verifiedFields: map } });
  await audit(actorId, "FIELD_UNVERIFY", "note", note.id, input.field);
  return { ok: true as const, value: null };
}

// Files the desk attaches to one loan: the collateral it reviewed and its third-party reports.
export const LOAN_DOCUMENT_TYPES: DocType[] = ["OE_REPORT", "RISK_SEARCH", "ASSIGNMENT", "ALLONGE", "NOTE", "MORTGAGE", "TITLE", "PAY_HISTORY", "BPO", "OTHER"];

export async function fileLoanDocument(actorId: string, input: { noteId: string; type: string; name: string; bytes: Buffer; mime?: string }) {
  if (!LOAN_DOCUMENT_TYPES.includes(input.type as DocType)) return fail("Pick what kind of file this is.");
  const loan = await loanOnFile(input.noteId);
  if (!loan) return fail("That loan isn't on file.");
  const problem = uploadProblem(input.name, input.bytes.length, input.bytes);
  const ext = extensionOf(input.name);
  if (problem || !ext) return fail(problem ?? "That file type is not accepted.");
  const storedName = `${crypto.randomUUID()}-${safeBasename(input.name)}`;
  const mime = mimeFor(ext, input.mime || "application/octet-stream");
  await putBytes(storedName, input.bytes, mime);
  const document = await prisma.document.create({
    data: { listingId: loan.listingId, noteId: loan.id, type: input.type as DocType, originalName: input.name.slice(0, 180), storedName, mime, size: input.bytes.length },
  });
  await audit(actorId, "LOAN_DOCUMENT", "note", loan.id, `${document.type} · ${document.id}`);
  return { ok: true as const, value: document };
}
