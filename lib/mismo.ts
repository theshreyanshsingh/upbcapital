import { FORECLOSURES, LIEN_POSITIONS, OCCUPANCIES, PAYMENT_STATUSES, PROPERTY_TYPES } from "@/lib/labels";
import {
  BANKRUPTCY_CHAPTERS,
  CREDIT_SCORE_MAX,
  CREDIT_SCORE_MIN,
  CREDIT_SCORE_TYPES,
  LOAN_PURPOSES,
  LOSS_MIT_STAGES,
  PAYMENT_TYPES,
  TAPE_FIELDS,
  TAPE_HEADERS,
  VALUE_TYPES,
  type TapeFieldKey,
} from "@/lib/tape-fields";

// UPB's tape standard, and where each field sits in MISMO 3.x, the mortgage industry's data dictionary. A bank seller
// maps its tape to this once. The mapping is UPB's own reading of the MISMO 3.4 reference model and the GSE ULDD. It
// isn't MISMO-certified, and MISMO hasn't reviewed it.
//
// exact: a MISMO data point UPB is confident of, meaning the same thing.
// approximate: the closest MISMO data point. The meaning differs, or UPB hasn't checked the name against the
//   reference model. The note says which.
// extension: nothing in MISMO is close. The field travels in a UPB extension, the way MISMO carries data it doesn't
//   define.

export const STANDARD_VERSION = "UPB tape standard v3";
export const STANDARD_SET_ON = "2026-11-08";

export type MismoMatch = "exact" | "approximate" | "extension";

export type MismoEntry = {
  // The data point's name, the last part of the path.
  name: string;
  // The container path from DEAL, with the qualifier that picks one row of a repeating container.
  path: string;
  match: MismoMatch;
  note?: string;
};

export type FieldType = "text" | "money" | "percent" | "whole number" | "date" | "yes or no" | "choice" | "pay string";

type Spec = { type: FieldType; allowed?: string; mismo: MismoEntry };

const PROPERTY = "DEAL/COLLATERALS/COLLATERAL/SUBJECT_PROPERTY";
const VALUATION = `${PROPERTY}/PROPERTY_VALUATIONS/PROPERTY_VALUATION/PROPERTY_VALUATION_DETAIL`;
const LOAN = "DEAL/LOANS/LOAN";
const BORROWER = "DEAL/PARTIES/PARTY[PartyRoleType=Borrower]";
const SCORE = `${BORROWER}/ROLES/ROLE/BORROWER/CREDIT_SCORES/CREDIT_SCORE/CREDIT_SCORE_DETAIL`;
const EXTENSION = `${LOAN}/EXTENSION/OTHER/UPB_TAPE`;
const UNCHECKED = "The closest MISMO name, not yet checked against the 3.4 reference model.";

const exact = (container: string, name: string, note?: string): MismoEntry => ({ name, path: `${container}/${name}`, match: "exact", ...(note ? { note } : {}) });
const approximate = (container: string, name: string, note: string): MismoEntry => ({ name, path: `${container}/${name}`, match: "approximate", note });
const extension = (name: string, note: string): MismoEntry => ({ name, path: `${EXTENSION}/${name}`, match: "extension", note });

const choices = (options: readonly { value: string }[]) => options.map((option) => option.value).join(", ");

const SPECS: Record<TapeFieldKey, Spec> = {
  streetAddress: { type: "text", mismo: exact(`${PROPERTY}/ADDRESS`, "AddressLineText") },
  city: { type: "text", mismo: exact(`${PROPERTY}/ADDRESS`, "CityName") },
  state: { type: "text", allowed: "Two-letter state code, or the state's name", mismo: exact(`${PROPERTY}/ADDRESS`, "StateCode") },
  zip: { type: "text", allowed: "5 digits", mismo: exact(`${PROPERTY}/ADDRESS`, "PostalCode") },
  propertyType: {
    type: "choice",
    allowed: choices(PROPERTY_TYPES),
    mismo: approximate(`${PROPERTY}/PROPERTY_DETAIL`, "AttachmentType", "MISMO has no single property type. Attachment, FinancedUnitCount and the project's ProjectLegalStructureType describe it together."),
  },
  lienPosition: { type: "choice", allowed: choices(LIEN_POSITIONS), mismo: exact(`${LOAN}/TERMS_OF_LOAN`, "LienPriorityType") },
  upb: { type: "money", mismo: exact(`${LOAN}/PAYMENT/PAYMENT_SUMMARY`, "UPBAmount") },
  interestRate: {
    type: "percent",
    allowed: "0 to 40. 6.5 and 6.5% are 6.5%; 0.065 is read as 6.5%",
    mismo: approximate(`${LOAN}/TERMS_OF_LOAN`, "NoteRatePercent", "MISMO's is the rate on the note. UPB's is the rate in force today, which differs after a modification or an ARM reset."),
  },
  monthlyPi: {
    type: "money",
    mismo: approximate(`${LOAN}/PAYMENT/PAYMENT_RULE`, "InitialPrincipalAndInterestPaymentAmount", "MISMO's is the first payment. UPB's is the payment due today."),
  },
  paymentStatus: { type: "choice", allowed: choices(PAYMENT_STATUSES), mismo: extension("PaymentStatusType", "Performing, sub-performing and non-performing are market terms with no MISMO data point.") },
  monthsDelinquent: { type: "whole number", mismo: extension("MonthsDelinquentCount", "No MISMO data point UPB is sure of. Read from the pay string when blank.") },
  lastPaidDate: {
    type: "date",
    mismo: approximate(`${LOAN}/PAYMENT/PAYMENT_SUMMARY`, "LastPaidInstallmentDueDate", "MISMO dates the last paid installment by when it was due. UPB's is when the payment arrived."),
  },
  originationDate: { type: "date", mismo: exact(`${LOAN}/TERMS_OF_LOAN`, "NoteDate", "The date on the note.") },
  maturityDate: { type: "date", mismo: exact(`${LOAN}/MATURITY/MATURITY_RULE`, "LoanMaturityDate") },
  estimatedValue: { type: "money", mismo: exact(VALUATION, "PropertyValuationAmount") },
  askingPrice: { type: "money", allowed: "Required when the pool is priced from this column", mismo: extension("AskingPriceAmount", "A seller's ask has no MISMO data point.") },
  occupancy: {
    type: "choice",
    allowed: choices(OCCUPANCIES),
    mismo: approximate(`${PROPERTY}/PROPERTY_DETAIL`, "PropertyUsageType", "MISMO's is how the home is used: primary residence, second home or investment. UPB's is who lives there today."),
  },
  foreclosureStatus: { type: "choice", allowed: choices(FORECLOSURES), mismo: extension("ForeclosureStatusType", "No MISMO data point UPB is sure of.") },
  borrowerName: { type: "text", mismo: exact(`${BORROWER}/INDIVIDUAL/NAME`, "FullName") },
  memo: { type: "text", mismo: extension("LoanNoteText", "Free text with no MISMO data point.") },
  loanNumber: { type: "text", allowed: "Up to 40 characters. Format the column as text so a spreadsheet doesn't round it", mismo: exact(`${LOAN}/LOAN_IDENTIFIERS/LOAN_IDENTIFIER[LoanIdentifierType=ServicerLoan]`, "LoanIdentifier") },
  servicerName: { type: "text", mismo: exact("DEAL/PARTIES/PARTY[PartyRoleType=Servicer]/LEGAL_ENTITY/LEGAL_ENTITY_DETAIL", "FullName") },
  payString: {
    type: "pay string",
    allowed: "One character a month, newest first: 0 paid on time, 1 to 9 months behind, X nothing due. 30, 60 and 90 between commas read as days late",
    mismo: extension("PayHistoryText", "MISMO has no pay string."),
  },
  nextDueDate: { type: "date", mismo: extension("NextPaymentDueDate", "No MISMO data point UPB is sure of. MISMO's LastPaidInstallmentDueDate plus one payment period gives the same date.") },
  modified: { type: "yes or no", mismo: extension("LoanModifiedIndicator", "MISMO 3.x has modification containers. UPB hasn't matched this to a data point it is sure of.") },
  modificationDate: { type: "date", mismo: extension("LoanModificationDate", "MISMO 3.x has modification containers. UPB hasn't matched this to a data point it is sure of.") },
  lossMitigation: { type: "text", allowed: "A few words, such as forbearance or trial modification", mismo: extension("LossMitigationOutcomeText", "MISMO 3.x has loss mitigation containers. UPB hasn't matched this to a data point it is sure of.") },
  lossMitStage: { type: "choice", allowed: choices(LOSS_MIT_STAGES), mismo: extension("LossMitigationStageType", "MISMO 3.x has loss mitigation containers. UPB hasn't matched this to a data point it is sure of.") },
  bankruptcyChapter: { type: "choice", allowed: BANKRUPTCY_CHAPTERS.join(", "), mismo: approximate(`${LOAN}/BANKRUPTCIES/BANKRUPTCY/BANKRUPTCY_DETAIL`, "BankruptcyChapterType", UNCHECKED) },
  bankruptcyFiledAt: { type: "date", mismo: approximate(`${LOAN}/BANKRUPTCIES/BANKRUPTCY/BANKRUPTCY_DETAIL`, "BankruptcyFilingDate", UNCHECKED) },
  foreclosureFiledAt: { type: "date", mismo: extension("ForeclosureFiledDate", "No MISMO data point UPB is sure of.") },
  valueType: { type: "choice", allowed: choices(VALUE_TYPES), mismo: exact(VALUATION, "PropertyValuationMethodType", "UPB's SELLER, the seller's own estimate, has no MISMO method and reads as Other.") },
  valueAsOf: { type: "date", mismo: exact(VALUATION, "PropertyValuationEffectiveDate") },
  loanPurpose: {
    type: "choice",
    allowed: choices(LOAN_PURPOSES),
    mismo: approximate(`${LOAN}/TERMS_OF_LOAN`, "LoanPurposeType", "MISMO has purchase, refinance and other. A cash-out refinance is a refinance with RefinanceCashOutDeterminationType; seller financing and business purpose read as other."),
  },
  hoaLien: { type: "yes or no", mismo: extension("HOALienIndicator", "No MISMO data point UPB is sure of.") },
  taxDelinquent: { type: "yes or no", mismo: extension("PropertyTaxDelinquentIndicator", "No MISMO data point UPB is sure of.") },
  armIndex: {
    type: "text",
    allowed: "The index as written, such as 30-day average SOFR",
    mismo: approximate(`${LOAN}/ADJUSTMENT/INTEREST_RATE_ADJUSTMENT/INDEX_RULES/INDEX_RULE`, "IndexSourceType", "MISMO picks from a fixed list of index sources. UPB keeps the index as the tape writes it."),
  },
  armMargin: { type: "percent", allowed: "0 to 20", mismo: exact(`${LOAN}/ADJUSTMENT/INTEREST_RATE_ADJUSTMENT/INTEREST_RATE_LIFETIME_ADJUSTMENT_RULE`, "MarginRatePercent") },
  armNextReset: { type: "date", mismo: approximate(`${LOAN}/ADJUSTMENT/INTEREST_RATE_ADJUSTMENT/INTEREST_RATE_PER_CHANGE_ADJUSTMENT_RULES/INTEREST_RATE_PER_CHANGE_ADJUSTMENT_RULE`, "NextRateAdjustmentEffectiveDate", UNCHECKED) },
  creditScore: { type: "whole number", allowed: `${CREDIT_SCORE_MIN} to ${CREDIT_SCORE_MAX}`, mismo: exact(SCORE, "CreditScoreValue") },
  creditScoreType: {
    type: "choice",
    allowed: choices(CREDIT_SCORE_TYPES),
    mismo: approximate(SCORE, "CreditScoreModelNameType", "MISMO names each model and version. UPB keeps FICO, VantageScore or another model."),
  },
  creditScoreDate: { type: "date", mismo: approximate(SCORE, "CreditScoreDate", UNCHECKED) },
  mersMin: { type: "text", allowed: "18 digits. Dashes and spaces are dropped", mismo: exact(`${LOAN}/LOAN_IDENTIFIERS/LOAN_IDENTIFIER[LoanIdentifierType=MERS_MIN]`, "LoanIdentifier") },
  eNoteId: { type: "text", mismo: extension("ENoteIdentifier", "No MISMO data point UPB is sure of.") },
  originatingPlatform: {
    type: "text",
    mismo: approximate("DEAL/PARTIES/PARTY[PartyRoleType=LoanOriginationCompany]/LEGAL_ENTITY/LEGAL_ENTITY_DETAIL", "FullName", "UPB's field can name the system that made the loan, not only the lender."),
  },
  inheritedCovenants: { type: "text", allowed: "Up to 600 characters", mismo: extension("InheritedSaleCovenantsText", "Terms carried from an earlier loan sale have no MISMO data point.") },
  originatorLicense: {
    type: "text",
    allowed: "The loan originator's name and NMLS ID",
    mismo: approximate("DEAL/PARTIES/PARTY[PartyRoleType=LoanOriginator]/ROLES/ROLE/LICENSES/LICENSE/LICENSE_DETAIL", "LicenseIdentifier", "MISMO holds the NMLS ID alone. UPB's field is free text with the name."),
  },
  originalBalance: { type: "money", mismo: exact(`${LOAN}/TERMS_OF_LOAN`, "NoteAmount") },
  escrowBalance: { type: "money", allowed: "May be below zero when the servicer advanced it", mismo: approximate(`${LOAN}/ESCROW/ESCROW_DETAIL`, "EscrowBalanceAmount", UNCHECKED) },
  arrearsAmount: { type: "money", allowed: "Unpaid installments, fees and advances. Zero or more", mismo: extension("ArrearsAmount", "No single MISMO data point holds the arrears.") },
  payoffAmount: {
    type: "money",
    allowed: "Needs its good-through date",
    mismo: approximate(`${LOAN}/PAYOFF`, "PayoffAmount", "MISMO's payoff is a lien paid at a closing. UPB's is the servicer's payoff quote."),
  },
  payoffAsOf: { type: "date", allowed: "Needs a payoff amount", mismo: extension("PayoffGoodThroughDate", "No MISMO data point UPB is sure of.") },
  balloonDate: { type: "date", mismo: extension("BalloonDate", "In MISMO a balloon loan's LoanMaturityDate is the balloon date, with LOAN_DETAIL's BalloonIndicator set.") },
  paymentType: {
    type: "choice",
    allowed: choices(PAYMENT_TYPES),
    mismo: approximate(`${LOAN}/AMORTIZATION/AMORTIZATION_RULE`, "AmortizationType", "AmortizationType carries fixed and adjustable rate. Interest-only and balloon are LOAN_DETAIL's InterestOnlyIndicator and BalloonIndicator."),
  },
  seniorLienBalance: {
    type: "money",
    allowed: "For a second or third lien. Zero or more",
    mismo: extension("SeniorLienUPBAmount", "In MISMO the senior loan is its own LOAN, with LienPriorityType FirstLien and its UPBAmount."),
  },
  scraFlag: { type: "yes or no", allowed: "Yes when the borrower has Servicemembers Civil Relief Act protection", mismo: extension("SCRAProtectionIndicator", "No MISMO data point UPB is sure of.") },
  borrowerDeceased: { type: "yes or no", mismo: extension("BorrowerDeceasedIndicator", "No MISMO data point UPB is sure of.") },
  litigationFlag: { type: "yes or no", allowed: "Yes when a case touches the loan or the property", mismo: extension("LitigationIndicator", "No MISMO data point UPB is sure of.") },
  litigationNote: { type: "text", allowed: "Up to 300 characters", mismo: extension("LitigationNoteText", "Free text with no MISMO data point.") },
  eNote: { type: "yes or no", allowed: "Yes when the note is an eNote on the MERS eRegistry", mismo: extension("ENoteIndicator", "No MISMO data point UPB is sure of.") },
  eRegistryController: { type: "text", allowed: "A 7-digit MERS Org ID", mismo: extension("ERegistryControllerOrganizationIdentifier", "No MISMO data point UPB is sure of.") },
  eRegistryLocation: { type: "text", allowed: "A 7-digit MERS Org ID", mismo: extension("ERegistryLocationOrganizationIdentifier", "No MISMO data point UPB is sure of.") },
  eVaultProvider: { type: "text", mismo: extension("EVaultProviderName", "No MISMO data point UPB is sure of.") },
};

export type StandardField = {
  key: TapeFieldKey;
  header: string;
  label: string;
  group: string;
  required: boolean;
  type: FieldType;
  allowed: string | null;
  mismo: MismoEntry;
};

// The template's headers follow the field list one to one, so a field's header is the one at its position.
export const TAPE_STANDARD: StandardField[] = TAPE_FIELDS.map((field, index) => ({
  key: field.key,
  header: TAPE_HEADERS[index],
  label: field.label,
  group: field.group,
  required: field.required,
  type: SPECS[field.key].type,
  allowed: SPECS[field.key].allowed ?? null,
  mismo: SPECS[field.key].mismo,
}));

export function mismoFor(key: string): MismoEntry | null {
  return (SPECS as Record<string, Spec>)[key]?.mismo ?? null;
}

export const STANDARD_GROUPS = [
  { group: "core", title: "The loan", lede: "Required fields first. A row missing one is sent back with the reason." },
  { group: "servicing", title: "Servicing record", lede: "Optional. What the servicer's statement says about payments, workouts and filings." },
  { group: "terms", title: "Rate, credit and registry", lede: "Optional. An adjustable rate needs its index and margin. A credit score needs its model and date." },
  { group: "risk", title: "Balances and risk flags", lede: "Optional. Balances a buyer prices from, how the payment is set, and flags that change what a buyer can do." },
] as const;

// Fields that find the borrower or the loan. They follow the street address: withheld until the viewer may open it.
export const WITHHELD_UNTIL_OPEN = new Set<TapeFieldKey>([
  "streetAddress",
  "zip",
  "borrowerName",
  "memo",
  "loanNumber",
  "mersMin",
  "eNoteId",
  "originatorLicense",
  "litigationNote",
]);

const isoDay = (date: Date) => (Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10));

function jsonValue(value: unknown) {
  if (value == null) return null;
  if (value instanceof Date) return isoDay(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  const text = String(value).trim();
  return text || null;
}

// One loan keyed by MISMO path. Values stay in UPB's own codes, which the standard lists. Blank fields are left out,
// and so are the identifying fields when `open` is false.
export function mismoLoan(note: Record<string, unknown>, open: boolean) {
  const out: Record<string, string | number | boolean> = {};
  for (const field of TAPE_STANDARD) {
    if (!open && WITHHELD_UNTIL_OPEN.has(field.key)) continue;
    // The tape's placeholder for a missing street isn't an address.
    if (field.key === "streetAddress" && note.streetAddress === "Not provided on tape") continue;
    const value = jsonValue(note[field.key]);
    if (value != null) out[field.mismo.path] = value;
  }
  return out;
}

export function mismoTape(input: { listingId: string; notes: { note: Record<string, unknown>; open: boolean }[]; now?: Date }) {
  return {
    standard: STANDARD_VERSION,
    mapping: "Keys are MISMO 3.x container paths as UPB maps them, with UPB_TAPE extensions where MISMO has no data point. Not MISMO-certified. See /tape-standard.",
    listingId: input.listingId,
    exportedAt: (input.now ?? new Date()).toISOString(),
    loans: input.notes.map(({ note, open }) => mismoLoan(note, open)),
  };
}
