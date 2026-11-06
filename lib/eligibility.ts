import { prettyDate } from "@/lib/format";

// The buyer-eligibility screen. A federal notice on non-performing loans against one- and two-unit homes, an
// acknowledgement for a buyer who says they control 350 or more homes, and a Maryland licensing prompt. Each one
// informs and is logged. None refuses a buyer; the acknowledgement only has to be given before a bid. All the
// wording waits on counsel, as does the reading of the law behind it.

export const ROAD_THRESHOLD = 350;

// One-unit homes on the tape. The tape doesn't record units, so a duplex filed as multifamily is missed.
// Counsel: confirm whether two-unit homes need their own property type.
const ONE_TWO_UNIT = new Set(["SFR", "CONDO", "TOWNHOUSE"]);

export const REO_STRATEGIES = [
  { value: "HOLD_TO_RENT", label: "Hold to rent" },
  { value: "SELL", label: "Sell" },
  { value: "LOSS_MITIGATION", label: "Loss mitigation only" },
  { value: "NOT_SURE", label: "Not sure" },
] as const;

export function reoStrategyLabel(value: string | null | undefined) {
  return REO_STRATEGIES.find((option) => option.value === value)?.label ?? "Not answered";
}

export const ELIGIBILITY_INTRO = [
  // Counsel: the statute in one line, for the buyer file.
  "A federal law limits for-profit buyers that control 350 or more single-family homes, and the desk shows a notice on the listings it may reach.",
  "Your answers decide whether you see it. They never stop you bidding.",
].join(" ");

export const HOMES_HELP = [
  // Counsel: what counts toward the 350. Our reading is that investment control counts and debt holdings don't.
  "Count homes you and your affiliates own or control as investments. Notes you hold don't count.",
  "Enter 0 for none.",
].join(" ");

// The two answers from the buyer file form. A buyer with no homes enters 0.
export function readEligibility(homes: string, strategy: string): { error: string } | { error: null; homesControlled: number; reoStrategy: string } {
  const raw = homes.replace(/[,\s]/g, "");
  if (!/^\d{1,7}$/.test(raw)) return { error: "Enter how many single-family homes you and your affiliates control, as a whole number. Enter 0 for none." };
  if (!REO_STRATEGIES.some((option) => option.value === strategy)) return { error: "Choose what you do with homes taken by foreclosure." };
  return { error: null, homesControlled: Number(raw), reoStrategy: strategy };
}

export type EligibilityLoan = { state: string; propertyType: string; paymentStatus: string };
export type EligibilityBuyer = { entityType?: string | null; homesControlled?: number | null; reoStrategy?: string | null } | null | undefined;

// Counsel: confirm the notice should reach non-performing loans only, not sub-performing ones headed to foreclosure.
export function roadLoan(loan: EligibilityLoan) {
  return loan.paymentStatus === "NON_PERFORMING" && ONE_TWO_UNIT.has(loan.propertyType);
}

// What the screen shows this buyer for these loans. A viewer with no buyer file is treated as not a trust.
export function eligibilityFor(loans: EligibilityLoan[], buyer: EligibilityBuyer) {
  const road = loans.some(roadLoan);
  const homes = buyer?.homesControlled ?? null;
  const large = road && homes != null && homes >= ROAD_THRESHOLD;
  return {
    road,
    // The buyer says they are at or over the threshold, so they acknowledge the notice before bidding.
    acknowledge: large,
    holdToRent: large && buyer?.reoStrategy === "HOLD_TO_RENT",
    // The notice applies and the buyer hasn't answered, so they're asked to.
    unanswered: road && homes == null,
    homes,
    // Only a passive trust keeps Maryland's exemption, and the file can't say whether a trust is passive.
    maryland: loans.some((loan) => loan.state.trim().toUpperCase() === "MD") && buyer?.entityType !== "TRUST",
  };
}

export type Eligibility = ReturnType<typeof eligibilityFor>;

// An acknowledgement counts when it was given after the buyer's latest answers, so a changed answer asks again.
export function acknowledgementMissing(eligibility: Eligibility, acknowledgedAt: Date | null | undefined, answeredAt: Date | null | undefined) {
  if (!eligibility.acknowledge) return false;
  if (!acknowledgedAt) return true;
  return Boolean(answeredAt && acknowledgedAt.getTime() < answeredAt.getTime());
}

export const ROAD_HEADING = "ROAD to Housing Act notice";

export const ROAD_NOTICE = [
  "This listing includes a non-performing loan secured by a one- or two-unit home.",
  // Counsel: the statute's reach and its effective date.
  "From 7 January 2027, the ROAD to Housing Act bars a for-profit investor that controls 350 or more single-family homes from buying more one- and two-unit homes.",
  // Counsel: the foreclosure exemption as we read it.
  "A home taken by foreclosure is exempt only when it is taken for loss mitigation or servicing, not as a long-term investment.",
  // Counsel: our reading that a note purchase is outside the bar. Treasury has not written rules yet.
  "Buying a note does not appear to count as buying a home, and notes don't count toward the 350.",
  // Counsel: disclaimer.
  "This is general information, not legal advice. Ask your own counsel how it applies to you.",
];

export function roadAcknowledgement(homes: number) {
  return [
    `You told us you and your affiliates control ${homes.toLocaleString("en-US")} single-family homes.`,
    // Counsel: the buyer's acknowledgement, and the penalty it restates.
    "I have read this notice. I understand that if I take a home securing this loan by foreclosure and keep it as an investment, that may be barred, with a penalty of $1 million or three times the price, whichever is greater.",
  ];
}

// Counsel: the added caution for a buyer who holds foreclosed homes to rent.
export const ROAD_RENT = "You told us you hold foreclosed homes to rent. That use may fall outside the exemption.";

export const ROAD_UNANSWERED = "Tell us how many single-family homes you control in your buyer file, so the desk knows whether this notice applies to you.";

export const MARYLAND_HEADING = "Maryland licensing";

export const MARYLAND_PROMPT = [
  // Counsel: the Maryland change and its date.
  "On 1 July 2026 Maryland repealed the \"all purchasers\" exemption from its mortgage lender licensing laws. Only passive trusts keep an exemption.",
  // Counsel: who may need a license.
  "An individual, LLC, fund or other entity holding a Maryland loan may need a Maryland license. Check with your counsel before you bid.",
];

export const ACKNOWLEDGE_FIRST = "Read and acknowledge the ROAD Act notice on this listing before you bid.";

// The short form the bid confirmation adds, after the price and the terms.
export function confirmNotices(eligibility: Eligibility) {
  const lines: string[] = [];
  if (eligibility.road) {
    // Counsel: the notice in brief, for the bid confirmation.
    lines.push("Federal notice: from 7 January 2027 the ROAD to Housing Act bars investors with 350 or more single-family homes from buying more, and a home taken by foreclosure is exempt only for loss mitigation or servicing.");
  }
  if (eligibility.holdToRent) lines.push(ROAD_RENT);
  if (eligibility.maryland) {
    // Counsel: the Maryland prompt in brief.
    lines.push("Maryland: a buyer that isn't a passive trust may need a Maryland license to hold this loan.");
  }
  return lines;
}

// One line for the audit log: what this buyer was shown on this bid, and when they acknowledged.
export function eligibilityLog(eligibility: Eligibility, acknowledgedAt: Date | null | undefined) {
  const parts: string[] = [];
  if (eligibility.road) parts.push("ROAD notice shown");
  if (eligibility.acknowledge) parts.push(`${eligibility.homes} homes stated · acknowledged ${prettyDate(acknowledgedAt)}`);
  if (eligibility.holdToRent) parts.push("holds REO to rent");
  if (eligibility.unanswered) parts.push("homes not stated");
  if (eligibility.maryland) parts.push("Maryland prompt shown");
  return parts.join(" · ");
}
