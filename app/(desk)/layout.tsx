import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { unset } from "@/lib/db-filters";

export const dynamic = "force-dynamic";

export default async function DeskLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const unread = await prisma.notification.count({
    // By account only. A copy kept for an address with no account belongs to no one who signs up with it later.
    where: { userId: user.id, ...unset("readAt") },
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
