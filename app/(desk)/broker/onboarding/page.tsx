import { BrokerOnboarding } from "@/components/broker-onboarding";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Broker onboarding" };

export default async function BrokerOnboardingPage() {
  const user = await requireRole(["BROKER"]);
  const profile = await prisma.brokerProfile.findUnique({ where: { userId: user.id } });
  const start = !profile?.company ? 0 : !profile.states ? 1 : !profile.w9Key ? 3 : !profile.payoutNote ? 4 : 5;
  return (
    <BrokerOnboarding
      start={start}
      draft={{
        userId: user.id,
        name: user.name,
        company: profile?.company || user.companyName || "",
        licenseType: profile?.licenseType || "",
        licenseNumber: profile?.licenseNumber || "",
        states: profile?.states || "",
        payoutNote: profile?.payoutNote || "",
        bio: profile?.bio || "",
        portraitKey: profile?.portraitKey || "",
        w9Name: profile?.w9Name || "",
      }}
    />
  );
}
