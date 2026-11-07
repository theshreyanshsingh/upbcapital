"use server";

import { redirect } from "next/navigation";
import { requireDesk } from "@/lib/staff";
import { prisma } from "@/lib/prisma";
import { investorAllocationBlock, screenInBackground, screenInvestor } from "@/lib/screening";

function money(raw: FormDataEntryValue | null) {
  const value = Number(String(raw || "").replace(/[$,\s]/g, ""));
  return Number.isFinite(value) ? value : NaN;
}

export async function addInvestor(formData: FormData) {
  await requireDesk("deskBook", "/admin/capital");
  const name = String(formData.get("name") || "").trim();
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const entity = String(formData.get("entity") || "").trim();
  if (name.length < 2 || !email.includes("@")) redirect("/admin/capital?error=Name and email are required.");
  await prisma.investor.create({ data: { name, email, entity } });
  // Tied to this investor, so a match holds their allocations. Each allocation screens again before money moves.
  screenInBackground(() => screenInvestor({ name, email, entity }));
  redirect("/admin/capital?notice=capital");
}

export async function addCommitment(formData: FormData) {
  await requireDesk("deskBook", "/admin/capital");
  const investorId = String(formData.get("investorId") || "");
  const amount = money(formData.get("amount"));
  const note = String(formData.get("note") || "").trim().slice(0, 300);
  if (!(amount > 0)) redirect("/admin/capital?error=Enter a commitment.");
  await prisma.commitment.create({ data: { investorId, amount, note } });
  redirect("/admin/capital?notice=capital");
}

export async function allocateCapital(formData: FormData) {
  await requireDesk("deskBook", "/admin/capital");
  const investorId = String(formData.get("investorId") || "");
  const holdingId = String(formData.get("holdingId") || "");
  const amount = money(formData.get("amount"));
  if (!(amount > 0)) redirect("/admin/capital?error=Enter an allocation.");
  const [investor, holding] = await Promise.all([
    prisma.investor.findUnique({ where: { id: investorId }, include: { commitments: true, allocations: true } }),
    prisma.deskHolding.findUnique({ where: { id: holdingId }, include: { allocations: true } }),
  ]);
  if (!investor || !holding) redirect("/admin/capital?error=Investor or note is missing.");
  const committed = investor.commitments.reduce((sum, row) => sum + Number(row.amount), 0);
  const called = investor.allocations.reduce((sum, row) => sum + Number(row.amount), 0);
  const assigned = holding.allocations.reduce((sum, row) => sum + Number(row.amount), 0);
  if (called + amount > committed + 0.01) redirect("/admin/capital?error=That call is larger than the open commitment.");
  if (assigned + amount > Number(holding.costBasis) + 0.01) redirect("/admin/capital?error=Allocations cannot exceed the cost of the note.");
  const blocked = await investorAllocationBlock(investor);
  if (blocked) redirect(`/admin/capital?error=${encodeURIComponent(blocked)}`);
  await prisma.capitalAllocation.create({ data: { investorId, holdingId, amount } });
  redirect("/admin/capital?notice=capital");
}
