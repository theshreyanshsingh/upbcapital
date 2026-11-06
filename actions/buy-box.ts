"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { parseList } from "@/lib/buy-box";
import { rescoreBox } from "@/lib/matching";
import { prisma } from "@/lib/prisma";
import { LIEN_POSITIONS, PAYMENT_STATUSES, US_STATES } from "@/lib/labels";
import { isPro } from "@/lib/settings";
import { currentRate, readStandingRule } from "@/lib/standing-bids";

function optionalNumber(formData: FormData, key: string) {
  const raw = String(formData.get(key) || "").replace(/[$,%\s]/g, "");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export async function saveBuyBox(formData: FormData) {
  const user = await requireRole(["BUYER"]);
  const name = String(formData.get("name") || "").trim();
  if (name.length < 2 || name.length > 80) redirect("/buyer/buy-box?error=Name the box.");
  const states = parseList(String(formData.get("states") || "")).filter((state) => (US_STATES as readonly string[]).includes(state));
  const liens = LIEN_POSITIONS.map((item) => item.value).filter((value) => formData.get(`lien_${value}`) === "on");
  const statuses = PAYMENT_STATUSES.map((item) => item.value).filter((value) => formData.get(`status_${value}`) === "on");
  const data = {
    name,
    states: states.join(","),
    liens: liens.join(","),
    statuses: statuses.join(","),
    upbMin: optionalNumber(formData, "upbMin"),
    upbMax: optionalNumber(formData, "upbMax"),
    priceMin: optionalNumber(formData, "priceMin"),
    priceMax: optionalNumber(formData, "priceMax"),
    maxPriceToUpb: optionalNumber(formData, "maxPriceToUpb"),
    targetYield: optionalNumber(formData, "targetYield"),
    active: true,
  };
  const constrained = data.states || data.liens || data.statuses || data.upbMin != null || data.upbMax != null || data.priceMin != null || data.priceMax != null || data.maxPriceToUpb != null || data.targetYield != null;
  if (!constrained) redirect("/buyer/buy-box?error=Set at least one limit so the box can score paper.");
  const id = String(formData.get("id") || "");
  const box = id
    ? await prisma.buyBox.updateMany({ where: { id, userId: user.id }, data })
    : null;
  const saved = box && box.count
    ? await prisma.buyBox.findFirst({ where: { id, userId: user.id } })
    : await prisma.buyBox.create({ data: { ...data, userId: user.id } });
  if (!saved) redirect("/buyer/buy-box?error=That box is not yours.");
  await rescoreBox(saved.id);
  revalidatePath("/admin/queue");
  redirect("/buyer/buy-box?notice=box");
}

// The box's standing price rule. Saving it reprices every open match on the box, and withdraws an invite the desk
// sent at a figure that moved.
export async function saveStandingRule(formData: FormData) {
  const user = await requireRole(["BUYER"]);
  const id = String(formData.get("id") || "");
  const box = await prisma.buyBox.findFirst({ where: { id, userId: user.id, active: true } });
  if (!box) redirect("/buyer/buy-box?error=That box is not yours.");
  const rule = readStandingRule(
    {
      basis: String(formData.get("bidBasis") || ""),
      percent: String(formData.get("bidPercent") || ""),
      cap: String(formData.get("bidCap") || ""),
      target: String(formData.get("targetYield") || ""),
      spread: String(formData.get("bidSpread") || ""),
    },
    box,
    isPro(user),
  );
  if (rule.error !== null) redirect(`/buyer/buy-box?error=${encodeURIComponent(rule.error)}`);
  const saved = await prisma.buyBox.updateMany({ where: { id, userId: user.id, active: true }, data: rule.data });
  if (saved.count !== 1) redirect("/buyer/buy-box?error=That box was retired a moment ago.");
  await rescoreBox(id, { quiet: true });
  revalidatePath("/buyer/buy-box");
  // A spread rule saved before the desk has a rate prices nothing yet, and says so.
  const waiting = rule.data.bidBasis === "SPREAD" && !(await currentRate());
  const done = !rule.data.standingBids
    ? "Standing bids are off for this box."
    : waiting
      ? "The spread rule is saved. It prices once the desk enters a 10-year rate. Nothing binds until you confirm a bid."
      : "The standing price is saved, and open matches are repriced. Nothing binds until you confirm a bid.";
  redirect(`/buyer/buy-box?notice=${encodeURIComponent(done)}`);
}

export async function retireBuyBox(formData: FormData) {
  const user = await requireRole(["BUYER"]);
  const id = String(formData.get("id") || "");
  await prisma.buyBox.updateMany({ where: { id, userId: user.id }, data: { active: false } });
  await prisma.listingMatch.deleteMany({ where: { buyBoxId: id, userId: user.id } });
  revalidatePath("/buyer/buy-box");
  redirect("/buyer/buy-box?notice=box");
}
