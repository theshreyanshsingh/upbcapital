"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { guardDesk } from "@/lib/staff";
import { emailYearStatement, readReceiptSplit } from "@/lib/portfolio-tax";
import { consumeRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";

function amountOf(formData: FormData) {
  const value = Number(String(formData.get("amount") || "").replace(/[$,\s]/g, ""));
  return Number.isFinite(value) ? value : NaN;
}

export async function logBuyerPayment(formData: FormData) {
  const user = await requireRole(["BUYER", "ADMIN"]);
  const holdingId = String(formData.get("holdingId") || "");
  guardDesk(user, "closings", "/buyer/portfolio");
  const holding = await prisma.buyerHolding.findUnique({ where: { id: holdingId } });
  if (!holding || (user.role !== "ADMIN" && holding.userId !== user.id)) {
    redirect("/buyer/portfolio?error=That note is not on your book.");
  }
  const paidOn = String(formData.get("paidOn") || "");
  const memo = String(formData.get("memo") || "").trim().slice(0, 240);
  // The split is optional. Without it the year-end statement estimates one from the loan and says so.
  const read = readReceiptSplit({
    amount: String(formData.get("amount") || ""),
    principal: String(formData.get("principal") || ""),
    interest: String(formData.get("interest") || ""),
    fees: String(formData.get("fees") || ""),
    escrow: String(formData.get("escrow") || ""),
  });
  if (read.error !== null) redirect(`/buyer/portfolio?error=${encodeURIComponent(read.error)}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) redirect("/buyer/portfolio?error=Amount and date are required.");
  await prisma.cashReceipt.create({
    data: { buyerHoldingId: holdingId, amount: read.amount, paidOn: new Date(`${paidOn}T00:00:00Z`), memo, source: "MANUAL", ...(read.split ?? {}) },
  });
  revalidatePath("/buyer/portfolio");
  redirect("/buyer/portfolio?notice=payment");
}

export async function addOwnedNote(formData: FormData) {
  const user = await requireRole(["BUYER"]);
  const title = String(formData.get("title") || "").trim();
  const cost = amountOf(formData);
  const upb = Number(String(formData.get("upb") || "").replace(/[$,\s]/g, ""));
  const yieldRaw = String(formData.get("underwrittenYield") || "").trim();
  const underwrittenYield = yieldRaw ? Number(yieldRaw) : null;
  const acquired = String(formData.get("acquiredAt") || "");
  if (title.length < 3 || !(cost > 0) || !(upb > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(acquired)) {
    redirect("/buyer/portfolio?error=Title, cost, UPB, and a date are required.");
  }
  if (underwrittenYield != null && (!Number.isFinite(underwrittenYield) || underwrittenYield < 0 || underwrittenYield > 80)) {
    redirect("/buyer/portfolio?error=Keep the underwritten yield between 0 and 80.");
  }
  await prisma.buyerHolding.create({
    data: {
      userId: user.id,
      title,
      costBasis: cost,
      upb,
      underwrittenYield,
      acquiredAt: new Date(`${acquired}T00:00:00Z`),
    },
  });
  redirect("/buyer/portfolio?notice=owned");
}

export async function setBuyerHoldingStatus(formData: FormData) {
  const user = await requireRole(["BUYER", "ADMIN"]);
  const id = String(formData.get("id") || "");
  const status = String(formData.get("status") || "");
  if (!["CURRENT", "WATCH", "RESOLVED"].includes(status)) redirect("/buyer/portfolio?error=Unknown status.");
  guardDesk(user, "closings", "/buyer/portfolio");
  const holding = await prisma.buyerHolding.findUnique({ where: { id } });
  if (!holding || (user.role !== "ADMIN" && holding.userId !== user.id)) redirect("/buyer/portfolio");
  await prisma.buyerHolding.update({ where: { id }, data: { status: status as "CURRENT" } });
  redirect("/buyer/portfolio?notice=owned");
}

// The year-end statement by email, with the PDF attached. A few an hour is plenty for a buyer's own inbox.
export async function emailStatement(formData: FormData) {
  const user = await requireRole(["BUYER"]);
  const year = Number(String(formData.get("year") || ""));
  if (!(await consumeRateLimit(`statement-mail:${user.id}`, 5, 60 * 60 * 1000))) {
    redirect("/buyer/portfolio?error=That statement was sent a few times already. Try again in an hour.");
  }
  const sent = await emailYearStatement(user, year);
  if (sent.error !== null) redirect(`/buyer/portfolio?error=${encodeURIComponent(sent.error)}`);
  redirect(`/buyer/portfolio?notice=${encodeURIComponent(`Your ${year} statement is on its way to your email.`)}`);
}
