"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { guardDesk } from "@/lib/staff";
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
  if (user.id !== closing.listing.sellerId && user.id !== inquiry?.buyerId && !funder) guardDesk(user, "closings", `/closings/${closingId}`);
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
  const day = (raw: string) => (raw ? (/^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00Z`) : undefined) : null);
  const boardedAt = day(boarded);
  // The servicers send these letters. Recording the dates lets the closing room show the 15-day clocks as met.
  const goodbyeSentAt = day(String(formData.get("goodbyeSentAt") || ""));
  const helloSentAt = day(String(formData.get("helloSentAt") || ""));
  if (boardedAt === undefined || goodbyeSentAt === undefined || helloSentAt === undefined) {
    redirect(`/closings/${closingId}?error=${encodeURIComponent("Enter dates as year, month, and day.")}`);
  }
  const fields = { servicerName, contactEmail, loanNumber, notes, boardedAt, goodbyeSentAt, helloSentAt };
  await prisma.servicerBoarding.upsert({
    where: { closingId },
    update: fields,
    create: { closingId, ...fields },
  });
  revalidatePath(`/closings/${closingId}`);
  redirect(`/closings/${closingId}?notice=boarded`);
}
