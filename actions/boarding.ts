"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function saveBoarding(formData: FormData) {
  const user = await requireUser();
  const closingId = String(formData.get("closingId") || "");
  const closing = await prisma.closing.findUnique({ where: { id: closingId }, include: { listing: true } });
  if (!closing) redirect("/closings");
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId } }) : null;
  const funder = await prisma.closingFunder.findUnique({ where: { closingId_userId: { closingId, userId: user.id } } });
  const allowed = user.role === "ADMIN" || user.id === closing.listing.sellerId || user.id === inquiry?.buyerId || Boolean(funder);
  if (!allowed) redirect("/closings");
  if (closing.status !== "COMPLETE" && user.role !== "ADMIN") {
    redirect(`/closings/${closingId}?error=${encodeURIComponent("Boarding opens after the file is closed.")}`);
  }
  const servicerName = String(formData.get("servicerName") || "").trim();
  const contactEmail = String(formData.get("contactEmail") || "").trim();
  const loanNumber = String(formData.get("loanNumber") || "").trim().slice(0, 40);
  const notes = String(formData.get("notes") || "").trim().slice(0, 2000);
  const boarded = String(formData.get("boardedAt") || "");
  if (servicerName.length < 2 || servicerName.length > 120) {
    redirect(`/closings/${closingId}?error=${encodeURIComponent("Name the servicer.")}`);
  }
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    redirect(`/closings/${closingId}?error=${encodeURIComponent("Enter a servicer email, or leave it blank.")}`);
  }
  const boardedAt = boarded ? new Date(`${boarded}T00:00:00Z`) : null;
  await prisma.servicerBoarding.upsert({
    where: { closingId },
    update: { servicerName, contactEmail, loanNumber, notes, boardedAt },
    create: { closingId, servicerName, contactEmail, loanNumber, notes, boardedAt },
  });
  revalidatePath(`/closings/${closingId}`);
  redirect(`/closings/${closingId}?notice=boarded`);
}
