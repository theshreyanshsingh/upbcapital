// Which desk decision applies from each listing status. A sold or in-contract listing can't be approved back
// onto the book, and nothing goes into contract without first being live.
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
