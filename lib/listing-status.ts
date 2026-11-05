// Which desk decision applies from each listing status. A sold or in-contract listing can't be approved back
// onto the book, and nothing goes into contract without first being live. A withdrawn listing takes no desk
// decision at all: the seller took it off the book and its bids were declined, so putting it back would sell
// something the seller no longer offers. A relist starts again as a copy the desk reviews.
const ALLOWED: Record<string, readonly string[]> = {
  UNDER_REVIEW: ["SUBMITTED", "CHANGES_REQUESTED"],
  APPROVE: ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "REJECTED"],
  REQUEST_CHANGES: ["SUBMITTED", "UNDER_REVIEW", "APPROVED"],
  REJECT: ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED"],
  MARK_PENDING: ["APPROVED"],
  MARK_SOLD: ["APPROVED", "PENDING"],
};

export function deskDecisionAllowed(action: string, status: string) {
  return ALLOWED[action]?.includes(status) ?? false;
}

// The statuses a seller or filing broker can withdraw from. In contract and sold are spoken for, and a pool with
// one loan in contract is refused separately, because its listing stays live.
export const WITHDRAWABLE = ["SUBMITTED", "UNDER_REVIEW", "APPROVED", "CHANGES_REQUESTED", "REJECTED"] as const;

export function listingWithdrawBlock(status: string, openClosings: number) {
  if (status === "WITHDRAWN") return "This listing is already withdrawn.";
  if (status === "SOLD") return "This listing is sold, so it can't be withdrawn.";
  if (status === "PENDING" || openClosings > 0) return "A closing is open on this listing. It can't be withdrawn until that closing finishes or is canceled.";
  if (!(WITHDRAWABLE as readonly string[]).includes(status)) return "This listing can't be withdrawn.";
  return null;
}

// What each desk review entry says to the seller or broker reading it.
const REVIEW_LABELS: Record<string, string> = {
  COMMENT: "Note",
  UNDER_REVIEW: "In review",
  APPROVE: "Approved",
  REJECT: "Declined",
  REQUEST_CHANGES: "Changes requested",
  MARK_PENDING: "In contract",
  MARK_SOLD: "Sold",
  EDIT: "Edited by the desk",
  WITHDRAW: "Withdrawn",
  RESUBMIT: "Resubmitted",
};

export function reviewLabel(action: string) {
  return REVIEW_LABELS[action] ?? action.replaceAll("_", " ").toLowerCase();
}
