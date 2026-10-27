"use server";

import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { SOUTH_FLORIDA_COSTS } from "@/lib/rehab";
import { prisma } from "@/lib/prisma";

async function admin() {
  return requireRole(["ADMIN"]);
}

export async function ensureUnitCosts() {
  const count = await prisma.unitCost.count();
  if (count > 0) return;
  await prisma.unitCost.createMany({
    data: SOUTH_FLORIDA_COSTS.map((row) => ({ ...row, region: "South Florida" })),
  });
}

function back(holdingId: string, notice: string) {
  redirect(`/admin/book/${holdingId}?notice=${notice}`);
}

export async function openEstimate(formData: FormData) {
  await admin();
  const holdingId = String(formData.get("holdingId") || "");
  await prisma.rehabEstimate.upsert({
    where: { holdingId },
    create: { holdingId },
    update: {},
  });
  back(holdingId, "rehab");
}

export async function saveEstimate(formData: FormData) {
  await admin();
  const holdingId = String(formData.get("holdingId") || "");
  const dollars = (name: string) => Number(String(formData.get(name) || "").replace(/[$,\s]/g, ""));
  const arv = dollars("arv");
  const monthlyHold = dollars("monthlyHold");
  const monthlyRent = dollars("monthlyRent");
  const holdingMonths = Number(formData.get("holdingMonths") || 6);
  const expenseRatio = Number(formData.get("expenseRatio") || 35);
  const exitPath = formData.get("exitPath") === "RENTAL" ? "RENTAL" : "RESALE";
  if (![arv, monthlyHold, monthlyRent].every((value) => Number.isFinite(value) && value >= 0)) {
    redirect(`/admin/book/${holdingId}?error=Check the rehab numbers.`);
  }
  await prisma.rehabEstimate.upsert({
    where: { holdingId },
    create: { holdingId, arv, monthlyHold, monthlyRent, holdingMonths, expenseRatio, exitPath },
    update: { arv, monthlyHold, monthlyRent, holdingMonths, expenseRatio, exitPath },
  });
  back(holdingId, "rehab");
}

export async function addRehabLine(formData: FormData) {
  await admin();
  const holdingId = String(formData.get("holdingId") || "");
  const estimate = await prisma.rehabEstimate.findUnique({ where: { holdingId } });
  if (!estimate) redirect(`/admin/book/${holdingId}?error=Open the estimator first.`);
  const quantity = Number(formData.get("quantity") || 0);
  const unitCostCents = Math.round(Number(formData.get("unitCost") || 0) * 100);
  const trade = String(formData.get("trade") || "").trim();
  if (!trade || quantity <= 0 || unitCostCents < 0) redirect(`/admin/book/${holdingId}?error=A line needs a trade, a quantity, and a unit cost.`);
  await prisma.rehabLine.create({
    data: {
      estimateId: estimate.id,
      room: String(formData.get("room") || "").trim(),
      trade,
      quantity,
      unitCostCents,
      note: String(formData.get("note") || "").trim(),
    },
  });
  back(holdingId, "rehab");
}

export async function addContractorBid(formData: FormData) {
  await admin();
  const holdingId = String(formData.get("holdingId") || "");
  const estimate = await prisma.rehabEstimate.findUnique({ where: { holdingId } });
  if (!estimate) redirect(`/admin/book/${holdingId}?error=Open the estimator first.`);
  const amount = Number(String(formData.get("amount") || "").replace(/[$,\s]/g, ""));
  const contractor = String(formData.get("contractor") || "").trim();
  if (!contractor || !Number.isFinite(amount) || amount <= 0) redirect(`/admin/book/${holdingId}?error=Name the contractor and the bid.`);
  await prisma.contractorBid.create({
    data: { estimateId: estimate.id, contractor, amount, days: Number(formData.get("days") || 0), note: String(formData.get("note") || "") },
  });
  back(holdingId, "rehab");
}

export async function selectContractor(formData: FormData) {
  await admin();
  const holdingId = String(formData.get("holdingId") || "");
  const bidId = String(formData.get("bidId") || "");
  const bid = await prisma.contractorBid.findUnique({ where: { id: bidId }, include: { estimate: true } });
  if (!bid || bid.estimate.holdingId !== holdingId) redirect(`/admin/book/${holdingId}`);
  await prisma.contractorBid.updateMany({ where: { estimateId: bid.estimateId }, data: { selected: false } });
  await prisma.contractorBid.update({ where: { id: bid.id }, data: { selected: true } });
  back(holdingId, "rehab");
}

export async function addDraw(formData: FormData) {
  await admin();
  const holdingId = String(formData.get("holdingId") || "");
  const estimate = await prisma.rehabEstimate.findUnique({ where: { holdingId } });
  if (!estimate) redirect(`/admin/book/${holdingId}?error=Open the estimator first.`);
  const percent = Number(formData.get("percent") || 0);
  const label = String(formData.get("label") || "").trim();
  if (!label || percent <= 0 || percent > 100) redirect(`/admin/book/${holdingId}?error=A draw needs a name and a percent.`);
  await prisma.rehabDraw.create({ data: { estimateId: estimate.id, label, percent } });
  back(holdingId, "rehab");
}

export async function fundDraw(formData: FormData) {
  await admin();
  const holdingId = String(formData.get("holdingId") || "");
  const id = String(formData.get("id") || "");
  await prisma.rehabDraw.update({ where: { id }, data: { fundedAt: new Date() } });
  back(holdingId, "rehab");
}

export async function saveUnitCost(formData: FormData) {
  await admin();
  const trade = String(formData.get("trade") || "").trim();
  const unit = String(formData.get("unit") || "").trim();
  const cost = Number(String(formData.get("cost") || "").replace(/[$,\s]/g, ""));
  if (!trade || !unit || !Number.isFinite(cost) || cost < 0) redirect("/admin/costs?error=Enter a trade, a unit, and a cost.");
  await prisma.unitCost.upsert({
    where: { region_trade_unit: { region: "South Florida", trade, unit } },
    create: { region: "South Florida", trade, unit, costCents: Math.round(cost * 100) },
    update: { costCents: Math.round(cost * 100) },
  });
  redirect("/admin/costs?notice=cost");
}
