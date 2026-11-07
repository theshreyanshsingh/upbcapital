export const PROPERTY_TYPES = [
  { value: "SFR", label: "Single family" },
  { value: "CONDO", label: "Condominium" },
  { value: "TOWNHOUSE", label: "Townhouse" },
  { value: "MULTIFAMILY", label: "Multifamily" },
  { value: "LAND", label: "Land" },
  { value: "COMMERCIAL", label: "Commercial" },
  { value: "MIXED_USE", label: "Mixed use" },
  { value: "OTHER", label: "Other" },
] as const;

export const LIEN_POSITIONS = [
  { value: "FIRST", label: "First" },
  { value: "SECOND", label: "Second" },
  { value: "THIRD", label: "Third" },
  { value: "OTHER", label: "Other" },
] as const;

export const PAYMENT_STATUSES = [
  { value: "PERFORMING", label: "Performing" },
  { value: "SUB_PERFORMING", label: "Sub-performing" },
  { value: "NON_PERFORMING", label: "Non-performing" },
] as const;

export const OCCUPANCIES = [
  { value: "OWNER_OCCUPIED", label: "Owner occupied" },
  { value: "TENANT", label: "Tenant occupied" },
  { value: "VACANT", label: "Vacant" },
  { value: "UNKNOWN", label: "Unknown" },
] as const;

export const FORECLOSURES = [
  { value: "NONE", label: "None" },
  { value: "PRE_FORECLOSURE", label: "Pre-foreclosure" },
  { value: "NOTICE_OF_DEFAULT", label: "Notice of default" },
  { value: "LIS_PENDENS", label: "Lis pendens" },
  { value: "AUCTION_SCHEDULED", label: "Auction scheduled" },
  { value: "REO", label: "REO" },
  { value: "UNKNOWN", label: "Unknown" },
] as const;

export const LISTING_STATUSES = [
  { value: "SUBMITTED", label: "Submitted" },
  { value: "UNDER_REVIEW", label: "Under review" },
  { value: "APPROVED", label: "Live" },
  { value: "REJECTED", label: "Rejected" },
  { value: "CHANGES_REQUESTED", label: "Changes requested" },
  { value: "PENDING", label: "In contract" },
  { value: "SOLD", label: "Sold" },
  { value: "WITHDRAWN", label: "Withdrawn" },
] as const;

export const DOC_TYPES = [
  { value: "NOTE", label: "Note", hint: "Promissory note" },
  { value: "MORTGAGE", label: "Mortgage", hint: "Mortgage or deed of trust" },
  { value: "PAY_HISTORY", label: "Pay history", hint: "Servicer payment history" },
  { value: "BPO", label: "BPO", hint: "Broker price opinion or appraisal" },
  { value: "TITLE", label: "Title", hint: "Title report or commitment" },
  { value: "NDA", label: "Signed NDA", hint: "Electronic confidentiality agreement" },
  { value: "OTHER", label: "Other", hint: "Allonge, modification, photos" },
] as const;

// The kinds of buying entity a buyer file or an extra buying entity can be. The main file is never an IRA, since
// an IRA needs a custodian and an account title the main file doesn't carry.
export const INVESTOR_ENTITIES = [
  { value: "INDIVIDUAL", label: "Individual" },
  { value: "LLC", label: "Limited liability company" },
  { value: "TRUST", label: "Trust" },
  { value: "FUND", label: "Fund" },
  { value: "OTHER", label: "Other entity" },
  { value: "IRA", label: "Self-directed IRA" },
] as const;

export const MAIN_FILE_ENTITIES = INVESTOR_ENTITIES.filter((entity) => entity.value !== "IRA");

export function entityLabel(value: string | null | undefined) {
  return INVESTOR_ENTITIES.find((entity) => entity.value === value)?.label ?? (value || "");
}

export const IRA_TITLE_EXAMPLE = "Equity Trust Company Custodian FBO Jane Doe IRA #12345";
// Counsel: the buyer confirms with their own custodian. UPB doesn't say what an IRA may hold.
export const IRA_NOTE =
  "The custodian signs the purchase papers and sends the deposit and balance wires from the IRA. Check with your custodian that the account may buy mortgage notes before you bid.";

export const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DC","DE","FL","GA","HI","IA","ID","IL","IN","KS","KY","LA","MA","MD","ME","MI","MN","MO","MS","MT","NC","ND","NE","NH","NJ","NM","NV","NY","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VA","VT","WA","WI","WV","WY",
] as const;

const labelMap = (pairs: readonly { value: string; label: string }[]) =>
  Object.fromEntries(pairs.map((pair) => [pair.value, pair.label]));

const propertyLabels = labelMap(PROPERTY_TYPES);
const lienLabels = labelMap(LIEN_POSITIONS);
const paymentLabels = labelMap(PAYMENT_STATUSES);
const occupancyLabels = labelMap(OCCUPANCIES);
const foreclosureLabels = labelMap(FORECLOSURES);
const statusLabels = labelMap(LISTING_STATUSES);

export function labelOf(map: "property" | "lien" | "payment" | "occupancy" | "foreclosure" | "status", value: string) {
  const table = {
    property: propertyLabels,
    lien: lienLabels,
    payment: paymentLabels,
    occupancy: occupancyLabels,
    foreclosure: foreclosureLabels,
    status: statusLabels,
  }[map];
  return table[value] ?? value;
}

export function roleLabel(role: string) {
  switch (role) {
    case "ADMIN":
      return "Desk";
    case "INDIVIDUAL_SELLER":
      return "Note seller";
    case "INSTITUTIONAL_SELLER":
      return "Institution";
    case "BUYER":
      return "Buyer";
    case "BROKER":
      return "Broker";
    default:
      return role;
  }
}

export function homeFor(role: string) {
  switch (role) {
    case "ADMIN":
      return "/admin";
    case "BUYER":
      return "/marketplace";
    case "BROKER":
      return "/broker";
    default:
      return "/seller";
  }
}

// Files the desk attaches to one loan. They stay out of the seller's wizard, which files DOC_TYPES.
export const LOAN_DOC_TYPES = [
  { value: "ALLONGE", label: "Allonge", hint: "Endorsement attached to the note" },
  { value: "ASSIGNMENT", label: "Assignment", hint: "Assignment of the mortgage or deed of trust" },
  { value: "OE_REPORT", label: "O&E report", hint: "Owner and encumbrance report" },
  { value: "RISK_SEARCH", label: "Risk search", hint: "Bankruptcy, tax, lien or foreclosure search" },
] as const;

// A tape comes from the pool upload, not the note wizard's file list, so its label lives here.
export function docLabel(type: string) {
  if (type === "TAPE") return "Loan tape";
  return [...DOC_TYPES, ...LOAN_DOC_TYPES].find((doc) => doc.value === type)?.label ?? type;
}
