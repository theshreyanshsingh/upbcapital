import type { Metadata, Viewport } from "next";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { CommandPalette } from "@/components/command-palette";
import { Pwa } from "@/components/pwa";
import { Shortcuts } from "@/components/shortcuts";
import { getCurrentUser } from "@/lib/auth";
import { paletteCommands } from "@/lib/command-search";
import { prisma } from "@/lib/prisma";
import { unset } from "@/lib/db-filters";

export const dynamic = "force-dynamic";

// Added to the home screen, the desk opens as its own app. The manifest is app/manifest.ts.
export const metadata: Metadata = {
  appleWebApp: { capable: true, title: "UPB Capital", statusBarStyle: "default" },
};

// The status bar matches the top bar (the page colour) in each system theme. The page runs under the notch and
// the home indicator, and the shell pads itself with the safe-area insets.
export const viewport: Viewport = {
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f5f2" },
    { media: "(prefers-color-scheme: dark)", color: "#12110f" },
  ],
};

export default async function DeskLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const unread = await prisma.notification.count({
    // By account only. A copy kept for an address with no account belongs to no one who signs up with it later.
    where: { userId: user.id, ...unset("readAt") },
  });
  // Pages and actions for this role. Records are searched through /api/command, scoped the same way.
  const palette = paletteCommands(user);
  return (
    <>
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
      <CommandPalette userKey={user.id} commands={palette.commands} placeholder={palette.placeholder} />
      <Shortcuts bindings={palette.shortcuts} />
      <Pwa unread={unread} />
    </>
  );
}
