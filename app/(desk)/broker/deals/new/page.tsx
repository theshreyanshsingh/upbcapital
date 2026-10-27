import { redirect } from "next/navigation";
import { BrokerWizard } from "@/components/broker-wizard";
import { requireRole } from "@/lib/auth";
import { brokerGate } from "@/lib/broker-fees";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "File a deal" };

export default async function NewBrokerDealPage() {
  const user = await requireRole(["BROKER"]);
  const profile = await prisma.brokerProfile.findUnique({ where: { userId: user.id } });
  const next = brokerGate({ accountStatus: user.accountStatus, profile: profile ? { ...profile, welcomedAt: profile.welcomedAt ?? new Date() } : null });
  if (next === "/broker/onboarding") redirect(next);
  if (user.accountStatus !== "APPROVED") redirect("/broker");
  if (!profile?.w9Key) redirect("/broker/onboarding");
  return <BrokerWizard licensed={Boolean(profile.licenseNumber)} />;
}
