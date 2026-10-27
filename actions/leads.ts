"use server";

import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { indicativeQuote } from "@/lib/quote";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit } from "@/lib/rate-limit";
import { requestMeta } from "@/lib/request-meta";
import { LIEN_POSITIONS, PAYMENT_STATUSES, US_STATES } from "@/lib/labels";

function money(raw: FormDataEntryValue | null) {
  const value = Number(String(raw || "").replace(/[$,\s]/g, ""));
  return Number.isFinite(value) ? value : NaN;
}

export async function quoteLead(formData: FormData) {
  const meta = await requestMeta();
  if (!(await consumeRateLimit(`quote:${meta.ipAddress}`, 8, 60 * 60 * 1000))) {
    redirect("/sell?error=Too many quotes from this network. Wait and try again.");
  }
  const name = String(formData.get("name") || "").trim();
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const phone = String(formData.get("phone") || "").trim();
  const city = String(formData.get("city") || "").trim();
  const state = String(formData.get("state") || "").trim().toUpperCase();
  const lien = String(formData.get("lienPosition") || "");
  const status = String(formData.get("paymentStatus") || "");
  const upb = money(formData.get("upb"));
  const estimatedValue = money(formData.get("estimatedValue"));
  const interestRate = money(formData.get("interestRate"));
  const monthlyPi = money(formData.get("monthlyPi"));
  const note = String(formData.get("note") || "").trim().slice(0, 1000);
  if (name.length < 2 || !email.includes("@") || !(US_STATES as readonly string[]).includes(state)) {
    redirect("/sell?error=Name, email, and a US state are required.");
  }
  if (!LIEN_POSITIONS.some((item) => item.value === lien) || !PAYMENT_STATUSES.some((item) => item.value === status)) {
    redirect("/sell?error=Choose a lien and a payment status.");
  }
  if (!(upb > 0) || !(estimatedValue > 0) || !(interestRate >= 0) || interestRate > 40 || !(monthlyPi >= 0)) {
    redirect("/sell?error=UPB and value need to be greater than zero. Keep the rate under 40%.");
  }
  const comps = await prisma.note.findMany({
    where: { listing: { status: { in: ["APPROVED", "SOLD", "PENDING"] } }, state, paymentStatus: status as "PERFORMING" },
    select: { state: true, paymentStatus: true, upb: true, askingPrice: true },
    take: 40,
  });
  const quote = indicativeQuote(
    { state, paymentStatus: status, upb, estimatedValue, interestRate, monthlyPi },
    comps.map((row) => ({ state: row.state, paymentStatus: row.paymentStatus, upb: Number(row.upb), askingPrice: Number(row.askingPrice) })),
  );
  const lead = await prisma.sellerLead.create({
    data: {
      name,
      email,
      phone,
      city,
      state,
      lienPosition: lien as "FIRST",
      paymentStatus: status as "PERFORMING",
      upb,
      estimatedValue,
      interestRate,
      monthlyPi,
      indicativeLow: quote.low,
      indicativeHigh: quote.high,
      basis: quote.basis,
      note,
    },
  });
  redirect(`/sell/${lead.id}`);
}

export async function setLeadStatus(formData: FormData) {
  await requireRole(["ADMIN"]);
  const id = String(formData.get("id") || "");
  const status = String(formData.get("status") || "");
  if (!["NEW", "CONTACTED", "LISTING", "PASSED"].includes(status)) redirect("/admin/leads?error=Unknown status.");
  await prisma.sellerLead.update({ where: { id }, data: { status: status as "NEW" } });
  redirect("/admin/leads?notice=lead");
}
