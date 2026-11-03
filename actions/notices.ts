"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { PAYMENT_POLICIES } from "@/lib/borrower-notices";
import { prisma } from "@/lib/prisma";

const DAY = 24 * 60 * 60 * 1000;

function dateField(formData: FormData, key: string) {
  const raw = String(formData.get(key) || "");
  if (!raw) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00Z`) : undefined;
}

// The sale notice is the new owner's, so its buyer side and the desk keep these fields. The desk is the owner
// on a desk purchase.
export async function saveBorrowerNotices(formData: FormData) {
  const user = await requireUser();
  const closingId = String(formData.get("closingId") || "");
  const closing = await prisma.closing.findUnique({ where: { id: closingId }, include: { funders: true } });
  if (!closing) redirect("/closings");
  const back = `/closings/${closingId}`;
  const fail = (message: string) => redirect(`${back}?error=${encodeURIComponent(message)}`);
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, select: { buyerId: true } }) : null;
  const buyerSide = user.id === inquiry?.buyerId || closing.funders.some((funder) => funder.userId === user.id);
  if (user.role !== "ADMIN" && !buyerSide) fail("The new owner or the desk keeps the sale notice.");
  if (closing.status === "CANCELED") fail("This closing was canceled.");

  const transferAt = dateField(formData, "transferAt");
  const sentAt = dateField(formData, "ownerNoticeSentAt");
  if (transferAt === undefined || sentAt === undefined) fail("Enter dates as year, month, and day.");
  if (sentAt && sentAt.getTime() > Date.now() + DAY) fail("The sent date can't be in the future.");
  const purpose = String(formData.get("loanPurpose") || "");
  if (purpose && purpose !== "CONSUMER" && purpose !== "BUSINESS") fail("Choose the loan purpose.");
  const policy = String(formData.get("paymentPolicy") || "");
  if (policy && !(policy in PAYMENT_POLICIES)) fail("Choose a partial payment policy.");
  const ownerContact = String(formData.get("ownerContact") || "").trim().slice(0, 500);
  const recordingNote = String(formData.get("recordingNote") || "").trim().slice(0, 300);

  await prisma.closing.update({
    where: { id: closingId },
    data: {
      transferAt,
      loanPurpose: purpose || null,
      paymentPolicy: policy || null,
      ownerContact: ownerContact || null,
      recordingNote: recordingNote || null,
      ownerNoticeSentAt: sentAt,
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
      sentAt ? `sale notice sent ${sentAt.toISOString().slice(0, 10)}` : "sale notice not sent",
    ].join(" · "),
  );
  revalidatePath(back);
  redirect(`${back}?notice=notices`);
}
