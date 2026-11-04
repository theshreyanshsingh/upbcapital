export function canSubmitOffer(input: { role: string; accountStatus: string; verificationStatus: string | null }) {
  if (input.role === "ADMIN") return { ok: true as const };
  if (input.role !== "BUYER" || input.accountStatus !== "APPROVED") {
    return { ok: false as const, reason: "account" as const };
  }
  if (input.verificationStatus !== "APPROVED") {
    return { ok: false as const, reason: "verification" as const };
  }
  return { ok: true as const };
}

// A vendor result is identity only. The desk's approval stays the gate for offers, and no vendor step reopens a file
// the desk has approved or declined.
export const VENDOR_LOCKED = ["APPROVED", "REJECTED"] as const;

export function vendorBlocked(status: string | null | undefined) {
  if (status === "APPROVED") return "The desk already approved this file.";
  if (status === "REJECTED") return "The desk declined this file. Write the desk to reopen it.";
  return null;
}

export const ACCREDITATION_TEXT =
  "I certify that I am an accredited investor, or that I am signing for an entity that is an accredited investor, as that term is used in Rule 501 of Regulation D. I understand this desk does not verify that certification with a third party in this version.";
