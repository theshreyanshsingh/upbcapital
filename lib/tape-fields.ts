export const TAPE_FIELDS = [
  { key: "streetAddress", label: "Street address", required: false },
  { key: "city", label: "City", required: true },
  { key: "state", label: "State", required: true },
  { key: "zip", label: "ZIP", required: false },
  { key: "propertyType", label: "Property type", required: true },
  { key: "lienPosition", label: "Lien position", required: true },
  { key: "upb", label: "Unpaid principal balance", required: true },
  { key: "interestRate", label: "Interest rate", required: true },
  { key: "monthlyPi", label: "Monthly P&I", required: false },
  { key: "paymentStatus", label: "Payment status", required: true },
  { key: "monthsDelinquent", label: "Months delinquent", required: false },
  { key: "lastPaidDate", label: "Last paid date", required: false },
  { key: "originationDate", label: "Origination date", required: false },
  { key: "maturityDate", label: "Maturity date", required: false },
  { key: "estimatedValue", label: "Estimated value / BPO", required: true },
  { key: "askingPrice", label: "Asking price", required: false },
  { key: "occupancy", label: "Occupancy", required: false },
  { key: "foreclosureStatus", label: "Foreclosure status", required: false },
  { key: "borrowerName", label: "Borrower name", required: false },
  { key: "memo", label: "Notes", required: false },
] as const;

export type TapeFieldKey = (typeof TAPE_FIELDS)[number]["key"];

export const TAPE_HEADERS = [
  "street_address",
  "city",
  "state",
  "zip",
  "property_type",
  "lien_position",
  "upb",
  "interest_rate",
  "monthly_pi",
  "payment_status",
  "months_delinquent",
  "last_paid_date",
  "origination_date",
  "maturity_date",
  "estimated_value",
  "asking_price",
  "occupancy",
  "foreclosure_status",
  "borrower_name",
  "notes",
];

const SYNONYMS: Record<TapeFieldKey, string[]> = {
  streetAddress: ["streetaddress", "propertyaddress", "address", "siteaddress"],
  city: ["city", "propertycity"],
  state: ["state", "propertystate", "st"],
  zip: ["zip", "zipcode", "postalcode", "postal"],
  propertyType: ["propertytype", "proptype", "assettype", "collateraltype"],
  lienPosition: ["lienposition", "lien", "lienpos"],
  upb: ["upb", "unpaidprincipalbalance", "principalbalance", "unpaidbalance"],
  interestRate: ["interestrate", "rate", "noterate", "coupon"],
  monthlyPi: ["monthlypi", "monthlypayment", "pi", "pandi", "monthlypandi"],
  paymentStatus: ["paymentstatus", "performancestatus", "performancestatuscode", "loanstatus"],
  monthsDelinquent: ["monthsdelinquent", "monthdelinquent", "delinquentmonths", "monthsbehind"],
  lastPaidDate: ["lastpaiddate", "lastpaid", "lastpaymentdate"],
  originationDate: ["originationdate", "origination", "origdate", "notedate"],
  maturityDate: ["maturitydate", "maturity", "maturitydt"],
  estimatedValue: ["estimatedvalue", "bpo", "bpv", "propertyvalue", "asisvalue", "asIsvalue", "value"],
  askingPrice: ["askingprice", "askprice", "price", "offerprice", "listprice"],
  occupancy: ["occupancy", "occstatus", "occupancystatus"],
  foreclosureStatus: ["foreclosurestatus", "foreclosure", "fcstatus", "legalstatus"],
  borrowerName: ["borrowername", "borrower", "mortgagor"],
  memo: ["notes", "memo", "comments", "comment", "loannote"],
};

export function normalizeHeader(header: string) {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function suggestMapping(headers: string[]): Partial<Record<TapeFieldKey, string>> {
  const used = new Set<string>();
  const result: Partial<Record<TapeFieldKey, string>> = {};
  for (const field of TAPE_FIELDS) {
    const match = headers.find((header) => {
      if (used.has(header)) return false;
      return SYNONYMS[field.key].includes(normalizeHeader(header));
    });
    if (match) {
      result[field.key] = match;
      used.add(match);
    }
  }
  return result;
}

export const SAMPLE_TAPE_ROWS = [
  ["100 SAMPLE Banyan Street", "Miami", "FL", "33130", "SFR", "First", "428000", "6.50", "2704", "Performing", "0", "2026-09-01", "2019-06-15", "2049-06-15", "710000", "312000", "Owner occupied", "None", "FICTIONAL BORROWER 01", "Sample row — delete before a live tape"],
  ["200 SAMPLE Magnolia Court", "Savannah", "GA", "31401", "Condo", "Second", "86000", "8.25", "690", "Non-performing", "11", "2025-10-01", "2018-03-01", "2048-03-01", "340000", "29000", "Vacant", "Lis pendens", "FICTIONAL BORROWER 02", "Sample row — fictional"],
  ["300 SAMPLE Palmetto Lane", "Charlotte", "NC", "28202", "Townhouse", "First", "196500", "7.00", "1310", "Sub-performing", "2", "2026-07-15", "2021-01-20", "2051-01-20", "285000", "151000", "Tenant occupied", "None", "FICTIONAL BORROWER 03", "Sample row — fictional"],
];
