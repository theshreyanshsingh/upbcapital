"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth";
import { coverBidLabel, readAgencySale, saleLabel } from "@/lib/dispatch";
import { prisma } from "@/lib/prisma";

function back(message: string, kind: "notice" | "error", anchor = ""): never {
  redirect(`/admin/market?${kind}=${encodeURIComponent(message)}${anchor}`);
}

function fieldsOf(formData: FormData) {
  return (name: string) => String(formData.get(name) ?? "").trim();
}

// The desk enters a published agency or HUD sale, or corrects one. Results go in as cover bids.
export async function saveAgencySale(formData: FormData) {
  const actor = await requireRole(["ADMIN"]);
  const read = readAgencySale(fieldsOf(formData));
  if (!read.ok) back(read.error, "error", "#add-sale");
  const sale = read.value;
  const id = String(formData.get("id") || "").trim();
  if (id) {
    const existing = await prisma.agencySale.findUnique({ where: { id }, select: { id: true } });
    if (!existing) back("That sale is no longer on file.", "error");
    await prisma.agencySale.update({ where: { id }, data: sale });
  }
  const saved = id ? { id } : await prisma.agencySale.create({ data: { ...sale, createdById: actor.id }, select: { id: true } });
  await audit(actor.id, id ? "AGENCY_SALE_UPDATE" : "AGENCY_SALE_ADD", "agencySale", saved.id, `${saleLabel(sale)}; ${coverBidLabel(sale)}`);
  revalidatePath("/admin/market");
  revalidatePath("/market");
  back(id ? "The sale is updated." : "The sale is on the calendar.", "notice");
}

export async function removeAgencySale(formData: FormData) {
  const actor = await requireRole(["ADMIN"]);
  const id = String(formData.get("id") || "").trim();
  const existing = id ? await prisma.agencySale.findUnique({ where: { id } }) : null;
  if (!existing) back("That sale is no longer on file.", "error");
  await prisma.agencySale.delete({ where: { id: existing.id } });
  await audit(actor.id, "AGENCY_SALE_REMOVE", "agencySale", existing.id, `${saleLabel(existing)}; ${coverBidLabel(existing)}`);
  revalidatePath("/admin/market");
  revalidatePath("/market");
  back("The sale is removed from the calendar and the dispatch.", "notice");
}
