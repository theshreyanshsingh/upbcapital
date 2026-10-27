"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { simulatedCheckout } from "@/lib/billing";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

async function requireApprovedBuyer() {
  const user = await requireUser();
  if (user.role !== "BUYER") redirect("/");
  if (user.accountStatus !== "APPROVED") redirect("/buyer/pending");
  return user;
}

export async function mockActivatePro() {
  if (!simulatedCheckout()) redirect("/buyer/subscription?error=Stripe is configured. Use checkout.");
  const user = await requireApprovedBuyer();
  const settings = await getSettings();
  const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  const useCredit = fresh.referralCredits > 0;
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        subscriptionTier: "PRO",
        subscriptionStatus: "ACTIVE",
        subscriptionComped: useCredit,
        subscriptionCurrentPeriodEnd: new Date(Date.now() + 30 * 86400000),
        ...(useCredit ? { referralCredits: { decrement: 1 } } : {}),
      },
    });
    if (!useCredit) {
      await tx.revenueEvent.create({
        data: {
          type: "SUBSCRIPTION",
          amountCents: settings.proMonthlyPriceCents,
          userId: user.id,
          mock: true,
          description: `Pro membership · ${user.name} (simulated checkout)`,
          externalId: `mock_${user.id}_${Date.now()}`,
        },
      });
    }
    if (fresh.referredById && !fresh.referralRewarded) {
      await tx.user.update({ where: { id: fresh.referredById }, data: { referralCredits: { increment: 1 } } });
      await tx.user.update({ where: { id: user.id }, data: { referralRewarded: true } });
    }
  });
  revalidatePath("/buyer/subscription");
  revalidatePath("/admin");
  redirect(`/buyer/subscription?notice=${useCredit ? "credit" : "pro"}`);
}

export async function mockCancelPro() {
  if (!simulatedCheckout()) redirect("/buyer/subscription?error=Manage this membership in Stripe.");
  const user = await requireApprovedBuyer();
  await prisma.user.update({
    where: { id: user.id },
    data: { subscriptionTier: "FREE", subscriptionStatus: "CANCELED", subscriptionComped: false },
  });
  revalidatePath("/buyer/subscription");
  revalidatePath("/admin");
  redirect("/buyer/subscription?notice=canceled");
}
