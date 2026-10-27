import { BrokerOnboarding } from "@/components/broker-onboarding";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Broker profile" };

export default async function BrokerProfilePage() {
  const user = await requireRole(["BROKER"]);
  const profile = await prisma.brokerProfile.findUnique({ where: { userId: user.id } });
  return (
    <div>
      <p className="eyebrow mb-6">Edit the public page</p>
      <BrokerOnboarding
        start={0}
        draft={{
          userId: user.id,
          name: user.name,
          company: profile?.company || "",
          licenseType: profile?.licenseType || "",
          licenseNumber: profile?.licenseNumber || "",
          states: profile?.states || "",
          payoutNote: profile?.payoutNote || "",
          bio: profile?.bio || "",
          portraitKey: profile?.portraitKey || "",
          w9Name: profile?.w9Name || "",
        }}
      />
    </div>
  );
}
