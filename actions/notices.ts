"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { guardDesk } from "@/lib/staff";
import {
  exemptionProblem,
  loansInScope,
  otherPurchasesOnUpb,
  PAYMENT_POLICIES,
  proofProblem,
  readExemption,
  readNoticeProof,
  transferDate,
} from "@/lib/borrower-notices";
import { closingLoans } from "@/lib/closing";
import { prisma } from "@/lib/prisma";

const DAY = 24 * 60 * 60 * 1000;

function dateField(formData: FormData, key: string) {
  const raw = String(formData.get(key) || "");
  if (!raw) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00Z`) : undefined;
}

// The sale notice is the new owner's, so its buyer side and the desk keep these fields. The desk is the owner
// on a desk purchase, and answers the same covered-person question for UPB.
export async function saveBorrowerNotices(formData: FormData) {
  const user = await requireUser();
  const closingId = String(formData.get("closingId") || "");
  const closing = await prisma.closing.findUnique({ where: { id: closingId }, include: { funders: true, listing: { select: { notes: { select: { id: true, occupancy: true, borrowerName: true } } } } } });
  if (!closing) redirect("/closings");
  const back = `/closings/${closingId}`;
  const fail = (message: string) => redirect(`${back}?error=${encodeURIComponent(message)}`);
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, select: { buyerId: true } }) : null;
  const buyerSide = user.id === inquiry?.buyerId || closing.funders.some((funder) => funder.userId === user.id);
  if (user.role !== "ADMIN" && !buyerSide) fail("The new owner or the desk keeps the sale notice.");
  if (!buyerSide) guardDesk(user, "closings", back);
  if (closing.status === "CANCELED") fail("This closing was canceled.");

  const transferAt = dateField(formData, "transferAt");
  const sentAt = dateField(formData, "ownerNoticeSentAt");
  if (transferAt === undefined || sentAt === undefined) fail("Enter dates as year, month, and day.");
  if (sentAt && sentAt.getTime() > Date.now() + DAY) fail("The sent date can't be in the future.");
  const purpose = String(formData.get("loanPurpose") || "");
  if (purpose && purpose !== "CONSUMER" && purpose !== "BUSINESS") fail("Choose the loan purpose.");
  const policy = String(formData.get("paymentPolicy") || "");
  if (policy && !Object.hasOwn(PAYMENT_POLICIES, policy)) fail("Choose a partial payment policy.");
  const ownerContact = String(formData.get("ownerContact") || "").trim().slice(0, 500);
  const recordingNote = String(formData.get("recordingNote") || "").trim().slice(0, 300);

  // The covered-person answer: yes, no, or not answered yet.
  const answer = String(formData.get("ownerOtherLoans") || "");
  if (answer && answer !== "yes" && answer !== "no") fail("Answer yes or no about other mortgage loans, or leave it unanswered.");
  const otherLoans = answer === "yes" ? true : answer === "no" ? false : null;
  const rawExemption = String(formData.get("ownerNoticeExemption") || "");
  const exemption = readExemption(rawExemption);
  if (rawExemption && !exemption) fail("Choose why no sale notice is owed, or that one is.");
  // A sent notice needs its proof of mailing. A notice that went out needs no exemption.
  const proof = readNoticeProof(formData.get("ownerNoticeProof"));
  const missing = proofProblem(sentAt, proof);
  if (missing) fail(missing);
  if (sentAt && exemption) fail("The sale notice is recorded as sent, so no exemption is needed. Clear one of them.");
  if (exemption === "ONE_LOAN") {
    const loansHere = loansInScope(closingLoans(closing, closing.listing.notes), purpose || closing.loanPurpose).length;
    const otherOnUpb = await otherPurchasesOnUpb(closing, inquiry?.buyerId ?? null, transferDate({ ...closing, transferAt: transferAt ?? null }));
    const problem = exemptionProblem(exemption, { otherLoans, otherOnUpb, loansHere });
    if (problem) fail(problem);
  }

  await prisma.closing.update({
    where: { id: closingId },
    data: {
      transferAt,
      loanPurpose: purpose || null,
      paymentPolicy: policy || null,
      ownerContact: ownerContact || null,
      recordingNote: recordingNote || null,
      ownerNoticeSentAt: sentAt,
      ownerNoticeProof: proof || null,
      ownerNoticeExemption: exemption,
      ownerOtherLoans: otherLoans,
    },
  });
  await audit(
    user.id,
    "BORROWER_NOTICES",
    "closing",
    closingId,
    [
      transferAt ? `transfer ${transferAt.toISOString().slice(0, 10)}` : "transfer at close",
      purpose ? purpose.toLowerCase() : "purpose from the tape",
      otherLoans === null ? "other loans unanswered" : `other loans in 12 months: ${otherLoans ? "yes" : "no"}`,
      sentAt ? `sale notice sent ${sentAt.toISOString().slice(0, 10)}, proof: ${proof}` : exemption ? `not owed: ${exemption}` : "sale notice not sent",
    ].join(" · "),
  );
  // The sale notice's trailing item follows this record: received when sent, not needed with an exemption.
  // lib/trailing-docs.ts.
  await import("@/lib/trailing-docs").then((docs) => docs.syncTrailingDocs(closingId));
  revalidatePath(back);
  redirect(`${back}?notice=notices`);
}
