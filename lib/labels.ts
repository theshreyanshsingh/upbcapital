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

export function docLabel(type: string) {
  return DOC_TYPES.find((doc) => doc.value === type)?.label ?? type;
}
