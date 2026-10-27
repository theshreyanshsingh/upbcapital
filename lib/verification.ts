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

export const ACCREDITATION_TEXT =
  "I certify that I am an accredited investor, or that I am signing for an entity that is an accredited investor, as that term is used in Rule 501 of Regulation D. I understand this desk does not verify that certification with a third party in this version.";
