export const TAPE_FIELDS = [
  { key: "streetAddress", label: "Street address", required: false, group: "core" },
  { key: "city", label: "City", required: true, group: "core" },
  { key: "state", label: "State", required: true, group: "core" },
  { key: "zip", label: "ZIP", required: false, group: "core" },
  { key: "propertyType", label: "Property type", required: true, group: "core" },
  { key: "lienPosition", label: "Lien position", required: true, group: "core" },
  { key: "upb", label: "Unpaid principal balance", required: true, group: "core" },
  { key: "interestRate", label: "Interest rate", required: true, group: "core" },
  { key: "monthlyPi", label: "Monthly P&I", required: false, group: "core" },
  { key: "paymentStatus", label: "Payment status", required: true, group: "core" },
  { key: "monthsDelinquent", label: "Months delinquent", required: false, group: "core" },
  { key: "lastPaidDate", label: "Last paid date", required: false, group: "core" },
  { key: "originationDate", label: "Origination date", required: false, group: "core" },
  { key: "maturityDate", label: "Maturity date", required: false, group: "core" },
  { key: "estimatedValue", label: "Estimated value / BPO", required: true, group: "core" },
  { key: "askingPrice", label: "Asking price", required: false, group: "core" },
  { key: "occupancy", label: "Occupancy", required: false, group: "core" },
  { key: "foreclosureStatus", label: "Foreclosure status", required: false, group: "core" },
  { key: "borrowerName", label: "Borrower name", required: false, group: "core" },
  { key: "memo", label: "Notes", required: false, group: "core" },
  // Tape v2: the servicing record. Optional, so older tapes import as they did.
  { key: "loanNumber", label: "Loan number", required: false, group: "servicing" },
  { key: "servicerName", label: "Servicer", required: false, group: "servicing" },
  { key: "payString", label: "Pay string, newest month first", required: false, group: "servicing" },
  { key: "nextDueDate", label: "Next due date", required: false, group: "servicing" },
  { key: "modified", label: "Modified (yes or no)", required: false, group: "servicing" },
  { key: "modificationDate", label: "Modification date", required: false, group: "servicing" },
  { key: "lossMitigation", label: "Loss mitigation", required: false, group: "servicing" },
  { key: "bankruptcyChapter", label: "Bankruptcy chapter", required: false, group: "servicing" },
  { key: "bankruptcyFiledAt", label: "Bankruptcy filed date", required: false, group: "servicing" },
  { key: "foreclosureFiledAt", label: "Foreclosure filed date", required: false, group: "servicing" },
  { key: "valueType", label: "Value source (BPO, AVM, appraisal, seller)", required: false, group: "servicing" },
  { key: "valueAsOf", label: "Value date", required: false, group: "servicing" },
  { key: "loanPurpose", label: "Loan purpose", required: false, group: "servicing" },
  { key: "hoaLien", label: "HOA lien (yes or no)", required: false, group: "servicing" },
  { key: "taxDelinquent", label: "Taxes delinquent (yes or no)", required: false, group: "servicing" },
  // Tape v2.1: rate terms, credit, registry and sale terms. Optional like the servicing record.
  { key: "armIndex", label: "ARM index", required: false, group: "terms" },
  { key: "armMargin", label: "ARM margin", required: false, group: "terms" },
  { key: "armNextReset", label: "Next rate reset", required: false, group: "terms" },
  { key: "creditScore", label: "Credit score", required: false, group: "terms" },
  { key: "creditScoreType", label: "Score model (FICO, VantageScore, other)", required: false, group: "terms" },
  { key: "creditScoreDate", label: "Score date", required: false, group: "terms" },
  { key: "mersMin", label: "MERS MIN", required: false, group: "terms" },
  { key: "eNoteId", label: "eNote ID", required: false, group: "terms" },
  { key: "originatingPlatform", label: "Originating platform", required: false, group: "terms" },
  { key: "lossMitStage", label: "Loss mitigation stage", required: false, group: "terms" },
  { key: "inheritedCovenants", label: "Inherited sale covenants", required: false, group: "terms" },
  { key: "originatorLicense", label: "Originator license (seller financing)", required: false, group: "terms" },
  // Tape v3: balances, structure and risk flags. Optional like the rest.
  { key: "originalBalance", label: "Original balance", required: false, group: "risk" },
  { key: "escrowBalance", label: "Escrow balance", required: false, group: "risk" },
  { key: "arrearsAmount", label: "Arrears (installments, fees and advances owed)", required: false, group: "risk" },
  { key: "payoffAmount", label: "Payoff amount", required: false, group: "risk" },
  { key: "payoffAsOf", label: "Payoff good-through date", required: false, group: "risk" },
  { key: "balloonDate", label: "Balloon date", required: false, group: "risk" },
  { key: "paymentType", label: "Payment type (fixed, ARM, interest-only, balloon, other)", required: false, group: "risk" },
  { key: "seniorLienBalance", label: "Senior lien balance (junior liens)", required: false, group: "risk" },
  { key: "scraFlag", label: "SCRA protection (yes or no)", required: false, group: "risk" },
  { key: "borrowerDeceased", label: "Borrower deceased (yes or no)", required: false, group: "risk" },
  { key: "litigationFlag", label: "Litigation (yes or no)", required: false, group: "risk" },
  { key: "litigationNote", label: "Litigation note", required: false, group: "risk" },
  // An eNote on the MERS eRegistry, the Org IDs holding its control and location, and its eVault. lib/enotes.ts.
  { key: "eNote", label: "eNote on the MERS eRegistry (yes or no)", required: false, group: "terms" },
  { key: "eRegistryController", label: "eRegistry controller (MERS Org ID)", required: false, group: "terms" },
  { key: "eRegistryLocation", label: "eRegistry location (MERS Org ID)", required: false, group: "terms" },
  { key: "eVaultProvider", label: "eVault provider", required: false, group: "terms" },
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
  "loan_number",
  "servicer",
  "pay_string",
  "next_due_date",
  "modified",
  "modification_date",
  "loss_mitigation",
  "bankruptcy_chapter",
  "bankruptcy_filed_date",
  "foreclosure_filed_date",
  "value_source",
  "value_date",
  "loan_purpose",
  "hoa_lien",
  "taxes_delinquent",
  "arm_index",
  "arm_margin",
  "next_rate_reset",
  "credit_score",
  "credit_score_type",
  "credit_score_date",
  "mers_min",
  "enote_id",
  "originating_platform",
  "loss_mit_stage",
  "inherited_covenants",
  "originator_license",
  "original_balance",
  "escrow_balance",
  "arrears_amount",
  "payoff_amount",
  "payoff_date",
  "balloon_date",
  "payment_type",
  "senior_lien_balance",
  "scra",
  "borrower_deceased",
  "litigation",
  "litigation_note",
  "is_enote",
  "eregistry_controller",
  "eregistry_location",
  "evault_provider",
];

const SYNONYMS: Record<TapeFieldKey, string[]> = {
  streetAddress: ["streetaddress", "propertyaddress", "address", "siteaddress", "propertystreet", "street", "propertyaddress1"],
  city: ["city", "propertycity"],
  state: ["state", "propertystate", "st"],
  zip: ["zip", "zipcode", "postalcode", "postal", "propertyzip", "propertyzipcode", "propertypostalcode", "zip5"],
  propertyType: ["propertytype", "proptype", "assettype", "collateraltype"],
  lienPosition: ["lienposition", "lien", "lienpos"],
  upb: [
    "upb", "unpaidprincipalbalance", "principalbalance", "unpaidbalance", "currentprincipalbalance", "currentupb", "currentbalance",
    "principalbal", "curprinbal", "unpaidprincipal",
  ],
  interestRate: ["interestrate", "rate", "noterate", "coupon", "currentrate", "currentinterestrate", "currentnoterate"],
  monthlyPi: ["monthlypi", "monthlypayment", "pi", "pandi", "monthlypandi", "pipayment", "pandipayment", "principalandinterest", "pipmt"],
  paymentStatus: ["paymentstatus", "performancestatus", "performancestatuscode", "loanstatus"],
  monthsDelinquent: ["monthsdelinquent", "monthdelinquent", "delinquentmonths", "monthsbehind"],
  lastPaidDate: ["lastpaiddate", "lastpaid", "lastpaymentdate", "lastpaymentreceived", "lastpaymentreceiveddate", "lastpmtdate", "dateoflastpayment"],
  originationDate: ["originationdate", "origination", "origdate", "notedate"],
  maturityDate: ["maturitydate", "maturity", "maturitydt"],
  estimatedValue: ["estimatedvalue", "bpo", "bpv", "propertyvalue", "asisvalue", "asIsvalue", "value"],
  askingPrice: ["askingprice", "askprice", "price", "offerprice", "listprice"],
  occupancy: ["occupancy", "occstatus", "occupancystatus"],
  foreclosureStatus: ["foreclosurestatus", "foreclosure", "fcstatus", "legalstatus"],
  borrowerName: ["borrowername", "borrower", "mortgagor"],
  memo: ["notes", "memo", "comments", "comment", "loannote"],
  // "Loan #" and "Acct #" lose the # when normalised, so the bare words are listed.
  loanNumber: [
    "loannumber", "loanno", "loannum", "loanid", "loan", "loanidentifier", "servicerloannumber", "servicerloanno",
    "servicerloanid", "servicerloan", "sellerloanid", "sellerloannumber", "accountnumber", "accountno", "account",
    "acctnumber", "acctno", "acct",
  ],
  servicerName: ["servicer", "servicername", "currentservicer", "loanservicer", "subservicer", "servicedby"],
  payString: [
    "paystring", "payhistory", "paymenthistory", "payhist", "paymentstring", "mbapaystring", "12monthpayhistory",
    "24monthpayhistory", "12mopayhistory", "24mopayhistory", "delinquencystring", "delinquencyhistory", "dlqstring", "dlqhistory",
  ],
  nextDueDate: ["nextduedate", "nextdue", "nextpaymentdue", "nextpaymentduedate", "nextpaymentdate", "duedate", "nextduedt"],
  modified: ["modified", "modification", "modflag", "loanmodified", "ismodified", "mod", "modyn", "modifiedyn"],
  modificationDate: ["modificationdate", "moddate", "lastmoddate", "modeffectivedate", "modifieddate", "modificationeffectivedate"],
  // "Loss Mit Status" is the stage below. The outcome stays here.
  lossMitigation: ["lossmitigation", "lossmit", "lossmitoutcome", "lossmitigationoutcome", "workout", "workoutstatus", "workouttype", "lossmittype"],
  bankruptcyChapter: ["bankruptcychapter", "bkchapter", "bkch", "bkchap", "chapter", "bktype", "bankruptcytype"],
  bankruptcyFiledAt: [
    "bankruptcyfileddate", "bankruptcyfiledate", "bankruptcydate", "bankruptcyfiled", "bkfileddate", "bkfiledate", "bkdate",
    "bkfiled", "petitiondate",
  ],
  foreclosureFiledAt: [
    "foreclosurefileddate", "foreclosurefiledate", "foreclosuredate", "foreclosurefiled", "fcdate", "fcfileddate", "fcfiledate",
    "fcfiled", "lispendensdate",
  ],
  valueType: ["valuesource", "valuetype", "valuationtype", "valuationsource", "valuationmethod", "valuemethod", "bpotype"],
  valueAsOf: ["valuedate", "valueasof", "valuationdate", "bpodate", "avmdate", "appraisaldate", "valuedt", "valueasofdate"],
  loanPurpose: ["loanpurpose", "purpose", "purposeofloan", "originalpurpose", "loanpurposetype"],
  hoaLien: ["hoalien", "hoaliens", "hoalienyn", "hoadelinquent"],
  taxDelinquent: ["taxesdelinquent", "taxdelinquent", "delinquenttaxes", "taxdelinquency", "taxlien", "propertytaxdelinquent"],
  armIndex: ["armindex", "index", "indexname", "indextype", "rateindex", "armindextype", "indexcode"],
  armMargin: ["armmargin", "margin", "grossmargin", "ratemargin", "armmarginrate"],
  armNextReset: [
    "nextratereset", "nextratechange", "nextratechangedate", "nextresetdate", "nextreset", "rateresetdate", "nextrateadjustment",
    "nextadjustmentdate", "nextratechangedt", "nextrateresetdate", "nextarmreset",
  ],
  creditScore: [
    "creditscore", "fico", "ficoscore", "currentfico", "currentficoscore", "borrowerfico", "borrowercreditscore", "currentcreditscore",
    "vantagescore", "vantage", "score", "creditscorecurrent",
  ],
  creditScoreType: ["creditscoretype", "scoretype", "scoremodel", "creditscoremodel", "scoringmodel", "ficotype", "creditmodel"],
  creditScoreDate: [
    "creditscoredate", "scoredate", "ficodate", "ficoasof", "scoreasof", "creditscoreasof", "ficoscoredate", "ficopulldate",
    "creditpulldate", "creditdate", "scoreasofdate",
  ],
  mersMin: ["mersmin", "min", "mers", "minnumber", "mersminnumber", "mersid", "mersloanid", "mersmin18"],
  eNoteId: ["enoteid", "enote", "enotenumber", "enoteidentifier", "evaultid"],
  originatingPlatform: ["originatingplatform", "originationplatform", "platform", "originationsystem", "originatingsystem", "losplatform"],
  lossMitStage: ["lossmitstage", "lossmitstatus", "lossmitigationstatus", "lossmitigationstage", "lossmitstep", "workoutstage", "lmstatus", "lmstage"],
  inheritedCovenants: ["inheritedcovenants", "inheritedsalecovenants", "salecovenants", "covenants", "buyercovenants", "covenant"],
  originatorLicense: [
    "originatorlicense", "originatorlicence", "originatornmls", "originatornmlsid", "nmls", "nmlsid", "lonmls", "mlonmls", "mlolicense",
    "loanoriginatornmls",
  ],
  originalBalance: [
    "originalbalance", "origbalance", "origbal", "originalprincipalbalance", "originalupb", "originalloanamount", "origloanamount",
    "loanamount", "originalamount", "originalprincipal", "noteamount", "originalnoteamount", "origprinbal",
  ],
  escrowBalance: ["escrowbalance", "escrowbal", "escrow", "escrowaccountbalance", "impoundbalance", "impound", "escrowamount"],
  // A reinstatement quote is the arrears with fees, which is what this field holds.
  arrearsAmount: [
    "arrears", "arrearsamount", "arrearage", "totalarrears", "pastdueamount", "amountpastdue", "totalpastdue", "delinquentamount",
    "totaldelinquentamount", "reinstatementamount", "reinstatement", "reinstatementquote",
  ],
  payoffAmount: ["payoff", "payoffamount", "payoffamt", "totalpayoff", "payoffbalance", "payoffquote", "totalpayoffamount"],
  payoffAsOf: [
    "payoffdate", "payoffasof", "payoffasofdate", "payoffgoodthrough", "payoffgoodthroughdate", "goodthrough", "goodthroughdate",
    "payoffthroughdate", "payoffquotedate",
  ],
  balloonDate: ["balloondate", "balloon", "balloonduedate", "balloondue", "balloonmaturity", "balloonmaturitydate", "balloondt"],
  // "Loan type" usually means FHA, VA or conventional, so it isn't listed.
  paymentType: [
    "paymenttype", "pmttype", "amortizationtype", "amorttype", "amortization", "ratetype", "interestratetype", "paymentstructure",
    "loanstructure", "producttype",
  ],
  seniorLienBalance: [
    "seniorlienbalance", "seniorbalance", "seniorlien", "seniorlienamount", "seniorupb", "firstlienbalance", "1stlienbalance",
    "firstmortgagebalance", "1stmortgagebalance", "firstlienupb", "priorlienbalance", "seniordebt",
  ],
  scraFlag: [
    "scra", "scraflag", "scrastatus", "scraprotected", "scraprotection", "scrayn", "sscra", "military", "militarystatus",
    "activeduty", "activemilitary", "servicemember",
  ],
  borrowerDeceased: ["borrowerdeceased", "deceased", "deceasedflag", "deceasedborrower", "borrowerdeceasedflag", "deceasedyn", "mortgagordeceased"],
  litigationFlag: ["litigation", "litigationflag", "litigationyn", "inlitigation", "litigationstatus", "activelitigation", "contested", "contestedforeclosure", "lawsuit"],
  litigationNote: [
    "litigationnote", "litigationnotes", "litigationdetail", "litigationdetails", "litigationcomment", "litigationcomments",
    "litigationdescription",
  ],
  // "eNote" alone already maps to the eNote ID, so the flag answers to the longer names.
  eNote: ["isenote", "enoteflag", "enoteyn", "enoteindicator", "enoteyesno", "electronicnote", "enotemers"],
  eRegistryController: ["eregistrycontroller", "controllerorgid", "eregistrycontrollerorgid", "enotecontroller", "mersorgidcontroller", "controllermersorgid"],
  eRegistryLocation: ["eregistrylocation", "locationorgid", "eregistrylocationorgid", "enotelocation", "mersorgidlocation", "locationmersorgid"],
  eVaultProvider: ["evaultprovider", "evault", "evaultname", "evaultvendor", "enotevault"],
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
  ["100 SAMPLE Banyan Street", "Miami", "FL", "33130", "SFR", "First", "428000", "6.50", "2704", "Performing", "0", "2026-09-01", "2019-06-15", "2049-06-15", "710000", "312000", "Owner occupied", "None", "FICTIONAL BORROWER 01", "Sample row — delete before a live tape", "SAMPLE-0001", "Sample Servicing LLC", "000000000000", "2026-11-01", "No", "", "", "", "", "", "BPO", "2026-08-15", "Purchase", "No", "No", "", "", "", "742", "FICO", "2026-08-15", "", "", "", "", "", "", "520000", "3150.22", "0", "", "", "", "Fixed", "", "No", "No", "No", "", "No", "", "", ""],
  ["200 SAMPLE Magnolia Court", "Savannah", "GA", "31401", "Condo", "Second", "86000", "8.25", "690", "Non-performing", "11", "2025-10-01", "2018-03-01", "2048-03-01", "340000", "29000", "Vacant", "Lis pendens", "FICTIONAL BORROWER 02", "Sample row — fictional", "SAMPLE-0002", "Sample Servicing LLC", "999876543210", "2025-12-01", "Yes", "2020-08-01", "Forbearance ended", "", "", "2026-04-10", "BPO", "2026-06-01", "Cash-out refinance", "Yes", "No", "", "", "", "588", "VantageScore 4.0", "2026-06-01", "", "", "", "Decided", "", "", "95000", "", "9875", "97210.55", "2026-10-15", "", "Fixed", "212000", "No", "No", "Yes", "Sample: the borrower contests the foreclosure", "No", "", "", ""],
  ["300 SAMPLE Palmetto Lane", "Charlotte", "NC", "28202", "Townhouse", "First", "196500", "7.00", "1310", "Sub-performing", "2", "2026-07-15", "2021-01-20", "2051-01-20", "285000", "151000", "Tenant occupied", "None", "FICTIONAL BORROWER 03", "Sample row — fictional", "SAMPLE-0003", "Sample Servicing LLC", "221100000000", "2026-09-01", "No", "", "Repayment plan", "13", "2026-08-03", "", "AVM", "2026-09-20", "Refinance", "No", "No", "30-day average SOFR", "2.75", "2028-01-20", "691", "FICO", "2026-09-20", "", "", "", "Decided", "", "", "210000", "1840", "2620", "", "", "", "ARM", "", "No", "No", "No", "", "Yes", "1000123", "1000456", "Sample eVault Co"],
];

export const VALUE_TYPES = [
  { value: "BPO", label: "Broker price opinion (BPO)" },
  { value: "AVM", label: "Automated valuation (AVM)" },
  { value: "APPRAISAL", label: "Appraisal" },
  { value: "SELLER", label: "Seller's own estimate" },
] as const;

export const LOAN_PURPOSES = [
  { value: "PURCHASE", label: "Purchase" },
  { value: "REFINANCE", label: "Refinance" },
  { value: "CASH_OUT", label: "Cash-out refinance" },
  { value: "SELLER_FINANCED", label: "Seller financing" },
  { value: "BUSINESS", label: "Business purpose" },
] as const;

export const BANKRUPTCY_CHAPTERS = ["7", "11", "12", "13"] as const;

// Since September 2026 the GSEs accept VantageScore 4.0 as well as FICO, so a bare score needs its model.
export const CREDIT_SCORE_TYPES = [
  { value: "FICO", label: "FICO" },
  { value: "VANTAGE", label: "VantageScore" },
  { value: "OTHER", label: "Another model" },
] as const;

// Loss mitigation as the borrower's request, the options offered and the decision. It reads the same under the
// CFPB's proposed "loss mitigation request" as under the older complete-application rule. The outcome itself, such
// as a forbearance, stays in the free-text loss mitigation field.
export const LOSS_MIT_STAGES = [
  { value: "REQUESTED", label: "Request received" },
  { value: "OPTIONS_OFFERED", label: "Options offered" },
  { value: "DECIDED", label: "Decision made" },
] as const;

// Tape v3: how the payment is set. A balloon or interest-only loan can still carry a fixed or adjustable rate, but
// the payment shape is what a buyer prices first, so it wins on a tape that says both.
export const PAYMENT_TYPES = [
  { value: "FIXED", label: "Fixed rate" },
  { value: "ARM", label: "Adjustable rate (ARM)" },
  { value: "INTEREST_ONLY", label: "Interest-only" },
  { value: "BALLOON", label: "Balloon" },
  { value: "OTHER", label: "Other" },
] as const;

export const CREDIT_SCORE_MIN = 300;
export const CREDIT_SCORE_MAX = 850;

export type ValueType = (typeof VALUE_TYPES)[number]["value"];
export type LoanPurpose = (typeof LOAN_PURPOSES)[number]["value"];
export type BankruptcyChapter = (typeof BANKRUPTCY_CHAPTERS)[number];
export type CreditScoreType = (typeof CREDIT_SCORE_TYPES)[number]["value"];
export type LossMitStage = (typeof LOSS_MIT_STAGES)[number]["value"];
export type PaymentType = (typeof PAYMENT_TYPES)[number]["value"];

// The optional servicing record a tape or the note wizard can carry. Absent keys stay off the stored note.
export type ServicingRecord = {
  loanNumber?: string;
  servicerName?: string;
  payString?: string;
  nextDueDate?: Date;
  modified?: boolean;
  modificationDate?: Date;
  lossMitigation?: string;
  bankruptcyChapter?: BankruptcyChapter;
  bankruptcyFiledAt?: Date;
  foreclosureFiledAt?: Date;
  valueType?: ValueType;
  valueAsOf?: Date;
  loanPurpose?: LoanPurpose;
  hoaLien?: boolean;
  taxDelinquent?: boolean;
  armIndex?: string;
  armMargin?: number;
  armNextReset?: Date;
  creditScore?: number;
  creditScoreType?: CreditScoreType;
  creditScoreDate?: Date;
  mersMin?: string;
  eNoteId?: string;
  originatingPlatform?: string;
  lossMitStage?: LossMitStage;
  inheritedCovenants?: string;
  originatorLicense?: string;
  originalBalance?: number;
  escrowBalance?: number;
  arrearsAmount?: number;
  payoffAmount?: number;
  payoffAsOf?: Date;
  balloonDate?: Date;
  paymentType?: PaymentType;
  seniorLienBalance?: number;
  scraFlag?: boolean;
  borrowerDeceased?: boolean;
  litigationFlag?: boolean;
  litigationNote?: string;
  // Read from the tape only. The note wizard doesn't ask for them, so they aren't servicing keys.
  eNote?: boolean;
  eRegistryController?: string;
  eRegistryLocation?: string;
  eVaultProvider?: string;
};

// The servicing record's fields, in the order the note wizard and the tape mapping show them.
export const SERVICING_KEYS = [
  "loanNumber",
  "servicerName",
  "payString",
  "nextDueDate",
  "modified",
  "modificationDate",
  "lossMitigation",
  "bankruptcyChapter",
  "bankruptcyFiledAt",
  "foreclosureFiledAt",
  "valueType",
  "valueAsOf",
  "loanPurpose",
  "hoaLien",
  "taxDelinquent",
  "armIndex",
  "armMargin",
  "armNextReset",
  "creditScore",
  "creditScoreType",
  "creditScoreDate",
  "mersMin",
  "eNoteId",
  "originatingPlatform",
  "lossMitStage",
  "inheritedCovenants",
  "originatorLicense",
  "originalBalance",
  "escrowBalance",
  "arrearsAmount",
  "payoffAmount",
  "payoffAsOf",
  "balloonDate",
  "paymentType",
  "seniorLienBalance",
  "scraFlag",
  "borrowerDeceased",
  "litigationFlag",
  "litigationNote",
] as const satisfies readonly (keyof ServicingRecord)[];

// Tape v3's own keys, for the wizard's section and the tests.
export const RISK_KEYS = SERVICING_KEYS.slice(SERVICING_KEYS.indexOf("originalBalance"));

export type ServicingKey = (typeof SERVICING_KEYS)[number];

export const PAY_STRING_MAX = 48;

// Pay strings arrive as "000011", "CCCC3", "0,0,1" or "0 30 60 90". They're stored newest month first, one character
// a month: 0 paid on time, 1 to 9 months behind (9 is nine or more), X nothing due. Null when it can't be read.
export function parsePayString(raw: string) {
  const text = raw.trim().toUpperCase();
  if (!text) return null;
  const tokens = /[\s,;|/]/.test(text)
    ? text.split(/[\s,;|/]+/).filter(Boolean)
    : /^[0-9CX](-[0-9CX])+$/.test(text)
      ? text.split("-")
      : [text];
  let out = "";
  for (const part of tokens) {
    const token = part.replace(/\+$/, "");
    // Between separators, 30, 60 and 90 are days late. Run together, "30" is two months: 3 behind, then on time.
    if (tokens.length > 1 && /^(0|[1-9]\d*0)$/.test(token) && Number(token) % 30 === 0) {
      out += String(Math.min(9, Number(token) / 30));
      continue;
    }
    if (!/^[0-9CX]+$/.test(token)) return null;
    out += token.replace(/C/g, "0");
  }
  return out ? out.slice(0, PAY_STRING_MAX) : null;
}

// A spreadsheet stores 000011 as the number 11. When most of a column's pay strings share one length, that's the
// length a shorter all-digit value lost its leading zeros from.
export function payStringWidth(raws: string[]) {
  const counts = new Map<number, number>();
  for (const raw of raws) {
    const parsed = parsePayString(raw);
    if (parsed && parsed.length >= 6) counts.set(parsed.length, (counts.get(parsed.length) ?? 0) + 1);
  }
  let width = 0;
  let best = 0;
  for (const [length, count] of counts) {
    if (count > best) {
      best = count;
      width = length;
    }
  }
  return width;
}

export function restorePayString(raw: string, width: number) {
  const parsed = parsePayString(raw);
  if (parsed && width && /^\d+$/.test(raw.trim()) && parsed.length < width) return parsed.padStart(width, "0");
  return parsed;
}

// Months behind in the newest month of a pay string. X, nothing due, counts as current.
export function payStringMonths(payString: string | null | undefined) {
  const latest = payString?.[0];
  if (!latest) return null;
  return latest === "X" ? 0 : Number(latest);
}

const YES = new Set(["y", "yes", "true", "t", "1", "x"]);
const NO = new Set(["n", "no", "false", "f", "0", "none"]);

export function parseYesNo(raw: string) {
  const key = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (YES.has(key)) return true;
  if (NO.has(key)) return false;
  return null;
}

// "13", "Ch 13", "Chapter 13" and "BK13" all read as 13.
export function parseBankruptcyChapter(raw: string) {
  const key = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^(bk|bankruptcy)?(chapter|chap|ch)?/, "");
  return (BANKRUPTCY_CHAPTERS as readonly string[]).includes(key) ? (key as BankruptcyChapter) : null;
}

export function parseValueType(raw: string): ValueType | null {
  const key = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (!key) return null;
  if (key.includes("bpo") || key.includes("brokerprice") || key.includes("brokeropinion")) return "BPO";
  if (key.includes("avm") || key.includes("automated") || key.includes("zestimate")) return "AVM";
  if (key.includes("apprais")) return "APPRAISAL";
  if (key.includes("seller") || key.includes("owner") || key.includes("internal")) return "SELLER";
  return null;
}

export function parseLoanPurpose(raw: string): LoanPurpose | null {
  const key = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (!key) return null;
  // "No cash-out refi" is a rate-and-term refinance, so it's read before cash-out.
  if (key.includes("nocashout") || key.includes("limitedcashout") || key.includes("rateterm") || key.includes("rateandterm")) return "REFINANCE";
  if (key.includes("cashout")) return "CASH_OUT";
  if (key.includes("refi")) return "REFINANCE";
  if (key.includes("purch")) return "PURCHASE";
  if (key.includes("sellerfinanc") || key.includes("ownerfinanc") || key.includes("sellercarry")) return "SELLER_FINANCED";
  if (key.includes("business") || key === "commercial") return "BUSINESS";
  return null;
}

export function parseCreditScoreType(raw: string): CreditScoreType | null {
  const key = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key) return null;
  // Beacon and Empirica are the Equifax and TransUnion names for a FICO score.
  if (key.includes("fico") || key.includes("beacon") || key.includes("empirica")) return "FICO";
  if (key.includes("vantage") || /^vs[34]/.test(key)) return "VANTAGE";
  if (key === "other" || key === "othermodel") return "OTHER";
  return null;
}

// Servicers word the stage many ways. Anything else is read as an outcome, not a stage.
export function parseLossMitStage(raw: string): LossMitStage | null {
  const key = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (!key) return null;
  if (key === "requested" || key === "request" || key.includes("requestreceived") || key.includes("applicationreceived") || key.includes("appreceived") || key === "submitted" || key.includes("underreview")) return "REQUESTED";
  if (key.includes("optionsoffered") || key.includes("offered") || key.includes("solicited") || key.includes("trial")) return "OPTIONS_OFFERED";
  if (key === "decided" || key.includes("decision") || key === "approved" || key === "denied" || key === "declined" || key === "completed" || key === "closed") return "DECIDED";
  return null;
}

// A MERS MIN is 18 digits: a 7-digit organization ID, a 10-digit sequence and a check digit. Dashes and spaces are
// formatting. Null when it isn't 18 digits.
export function parseMersMin(raw: string) {
  const digits = raw.trim().replace(/[\s-]/g, "");
  return /^\d{18}$/.test(digits) ? digits : null;
}

export function parseCreditScore(raw: string) {
  const text = raw.trim().replace(/[,\s]/g, "");
  if (!/^\d+(\.0+)?$/.test(text)) return null;
  return Math.round(Number(text));
}

// "30-year fixed", "5/1 ARM", "IO" and "Fixed balloon" all read. The payment shape is read before the rate, so an
// interest-only ARM is interest-only and a fixed-rate balloon is a balloon.
export function parsePaymentType(raw: string): PaymentType | null {
  const key = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key) return null;
  // "IO", "IO ARM" and "Fixed IO", but not a word that only ends in io, such as portfolio.
  if (key.includes("interestonly") || /^io(arm|fixed|loan|\d|$)/.test(key) || /(fixed|arm)io$/.test(key)) return "INTEREST_ONLY";
  if (key.includes("balloon")) return "BALLOON";
  if (/arm$|arm\d|^\d+arm|^arm/.test(key) || key.includes("adjustable") || key.includes("variable") || key.includes("hybrid")) return "ARM";
  if (key.includes("fixed") || key === "frm" || key === "fix" || key.includes("fullyamortiz")) return "FIXED";
  if (key === "other") return "OTHER";
  return null;
}

// Registry IDs identify the borrower's loan as the loan number does, so they follow the street address. The
// originator's license can name the seller or a loan officer, so it follows the same rule.
export const IDENTITY_TERMS = ["mersMin", "eNoteId", "originatorLicense"] as const;

type TermsNote = {
  armIndex?: string | null;
  armMargin?: number | null;
  armNextReset?: Date | null;
  creditScore?: number | null;
  creditScoreType?: string | null;
  creditScoreDate?: Date | null;
  mersMin?: string | null;
  eNoteId?: string | null;
  originatingPlatform?: string | null;
  lossMitStage?: string | null;
  inheritedCovenants?: string | null;
  originatorLicense?: string | null;
  servicerSource?: string | null;
  servicerSourcedAt?: Date | null;
  eNote?: boolean | null;
  eRegistryController?: string | null;
  eRegistryLocation?: string | null;
  eVaultProvider?: string | null;
};

const exportDay = (date: Date | null | undefined) => (date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : "");

// The tape v2.1 columns of the tape export. `open` is whether this viewer may see the loan's street.
export function termsExportColumns(note: TermsNote, open: boolean) {
  return {
    armIndex: note.armIndex ?? "",
    armMargin: note.armMargin ?? "",
    armNextReset: exportDay(note.armNextReset),
    creditScore: note.creditScore ?? "",
    creditScoreType: note.creditScoreType ?? "",
    creditScoreDate: exportDay(note.creditScoreDate),
    mersMin: open ? note.mersMin ?? "" : "",
    eNoteId: open ? note.eNoteId ?? "" : "",
    originatingPlatform: note.originatingPlatform ?? "",
    lossMitStage: note.lossMitStage ?? "",
    inheritedCovenants: note.inheritedCovenants ?? "",
    originatorLicense: open ? note.originatorLicense ?? "" : "",
    servicerReport: note.servicerSource ?? "",
    servicerReportDate: exportDay(note.servicerSourcedAt),
    // An Org ID names the holder's MERS member, not the borrower, so these export either way. "isENote" rather than
    // "eNote", which an import reads as the eNote ID.
    isENote: note.eNote == null ? "" : note.eNote ? "yes" : "no",
    eRegistryController: note.eRegistryController ?? "",
    eRegistryLocation: note.eRegistryLocation ?? "",
    eVaultProvider: note.eVaultProvider ?? "",
  };
}

// The litigation note can name the borrower or the court case, so it follows the street address like the MIN.
export const IDENTITY_RISK = ["litigationNote"] as const;

type RiskNote = {
  originalBalance?: number | null;
  escrowBalance?: number | null;
  arrearsAmount?: number | null;
  payoffAmount?: number | null;
  payoffAsOf?: Date | null;
  balloonDate?: Date | null;
  paymentType?: string | null;
  seniorLienBalance?: number | null;
  scraFlag?: boolean | null;
  borrowerDeceased?: boolean | null;
  litigationFlag?: boolean | null;
  litigationNote?: string | null;
};

const exportFlag = (flag: boolean | null | undefined) => (flag == null ? "" : flag ? "yes" : "no");

// The tape v3 columns of the tape export. `open` is whether this viewer may see the loan's street.
export function riskExportColumns(note: RiskNote, open: boolean) {
  return {
    originalBalance: note.originalBalance ?? "",
    escrowBalance: note.escrowBalance ?? "",
    arrearsAmount: note.arrearsAmount ?? "",
    payoffAmount: note.payoffAmount ?? "",
    payoffAsOf: exportDay(note.payoffAsOf),
    balloonDate: exportDay(note.balloonDate),
    paymentType: note.paymentType ?? "",
    seniorLienBalance: note.seniorLienBalance ?? "",
    scra: exportFlag(note.scraFlag),
    borrowerDeceased: exportFlag(note.borrowerDeceased),
    litigation: exportFlag(note.litigationFlag),
    litigationNote: open ? note.litigationNote ?? "" : "",
  };
}
