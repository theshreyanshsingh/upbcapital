import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function DeskLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const unread = await prisma.notification.count({
    where: { readAt: null, OR: [{ userId: user.id }, { toEmail: user.email }] },
  });
  return (
    <AppShell
      user={{
        name: user.name,
        email: user.email,
        role: user.role,
        tier: user.subscriptionTier,
        unread,
      }}
    >
      {children}
    </AppShell>
  );
}
