"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BadgeCheck,
  Banknote,
  Bell,
  BellRing,
  BookOpen,
  Bot,
  Briefcase,
  Calculator,
  ChartColumn,
  ChevronsUpDown,
  ClipboardList,
  Code,
  Contact,
  CreditCard,
  FilePen,
  FilePlus,
  FileStack,
  FolderOpen,
  Gavel,
  Handshake,
  Inbox,
  Landmark,
  LayoutDashboard,
  Library,
  Lock,
  LogOut,
  Megaphone,
  Menu,
  Newspaper,
  Percent,
  ScrollText,
  Search,
  Star,
  Target,
  Upload,
  UserRound,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { logout } from "@/actions/auth";
import { OnboardingTour } from "@/components/tour";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { homeFor, roleLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";

export type ShellUser = {
  name: string;
  email: string;
  role: string;
  tier: string;
  unread: number;
};

type NavItem = { href: string; label: string; icon: LucideIcon; section?: string; count?: number };

function active(path: string, href: string) {
  if (href === "/seller" || href === "/admin" || href === "/marketplace" || href === "/buyer/subscription" || href === "/broker") {
    return path === href;
  }
  return path === href || path.startsWith(`${href}/`);
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

export function AppShell({ user, children }: { user: ShellUser; children: React.ReactNode }) {
  const items = navFor(user);
  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 flex-col border-r border-sidebar-border bg-sidebar px-3 pt-3.5 pb-3 md:flex">
        <div className="px-2 pt-1 pb-3">
          <Logo href={homeFor(user.role)} />
        </div>
        <SideNav items={items} />
        <Account user={user} />
      </aside>
      <div className="md:pl-72">
        <div className="sticky top-0 z-30 flex items-center justify-between border-b border-border bg-card px-4 py-3 md:hidden">
          <Logo href={homeFor(user.role)} />
          <Sheet>
            <SheetTrigger className="inline-flex size-9 items-center justify-center rounded-lg border border-border bg-card" aria-label="Open navigation">
              <Menu className="size-4" />
            </SheetTrigger>
            <SheetContent side="left" className="flex flex-col bg-sidebar px-3 pt-10 pb-3">
              <SideNav items={items} />
              <Account user={user} />
            </SheetContent>
          </Sheet>
        </div>
        <main id="desk" className="min-w-0 px-4 pt-5 pb-8 md:px-[22px] md:pt-[18px] md:pb-7">{children}</main>
        <OnboardingTour role={user.role} />
      </div>
    </div>
  );
}

function SideNav({ items }: { items: NavItem[] }) {
  const path = usePathname();
  const sections: { label: string; items: NavItem[] }[] = [];
  for (const item of items) {
    const label = item.section ?? "";
    const found = sections.find((section) => section.label === label);
    if (found) found.items.push(item);
    else sections.push({ label, items: [item] });
  }
  return (
    <nav className="mt-1 min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {sections.map((section) => (
        <div key={section.label || "main"} className={section.label ? "mt-4" : ""}>
          {section.label && <p className="px-2.5 pt-1 pb-1.5 text-xs text-faint">{section.label}</p>}
          {section.items.map((item) => {
            const on = active(path, item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "mb-0.5 flex min-h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] transition-colors",
                  on ? "bg-active font-semibold text-foreground" : "text-nav hover:bg-hover",
                )}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.count ? <span className="min-w-[18px] rounded-full bg-active px-1.5 py-px text-center text-[11px]">{item.count}</span> : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function Account({ user }: { user: ShellUser }) {
  const [open, setOpen] = useState(false);
  const dock = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!dock.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const plan = user.role === "BUYER" ? ` · ${user.tier === "PRO" ? "Pro" : "Free"}` : "";
  return (
    <div ref={dock} className="relative shrink-0 pt-2">
      {open && (
        <div className="absolute right-0 bottom-[58px] left-0 rounded-[14px] border border-border bg-popover p-1.5 shadow-[var(--shadow)]">
          <div className="flex items-center gap-2 p-2">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-bold text-foreground">{initials(user.name)}</span>
            <span className="min-w-0">
              <strong className="block truncate text-[13px]">{user.name}</strong>
              <em className="block truncate text-xs not-italic text-muted-foreground">{roleLabel(user.role)}{plan}</em>
            </span>
          </div>
          <ThemeToggle />
          <MenuLink href="/account/notifications" icon={BellRing} label="Notice settings" onPick={() => setOpen(false)} />
          <MenuLink href="/account/security" icon={Lock} label="Security" onPick={() => setOpen(false)} />
          <form action={logout}>
            <button type="submit" className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] hover:bg-hover">
              <LogOut className="size-[15px] text-muted-foreground" /> Sign out
            </button>
          </form>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-[10px] p-2 text-left hover:bg-hover"
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-[10px] font-bold text-foreground">{initials(user.name)}</span>
        <span className="min-w-0 flex-1">
          <strong className="block truncate text-[13px]">{user.name}</strong>
          <em className="block truncate text-xs not-italic text-muted-foreground">{user.email}</em>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </div>
  );
}

function MenuLink({ href, icon: Icon, label, onPick }: { href: string; icon: LucideIcon; label: string; onPick: () => void }) {
  return (
    <Link href={href} onClick={onPick} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-[13px] hover:bg-hover">
      <Icon className="size-[15px] text-muted-foreground" /> {label}
    </Link>
  );
}

function navFor(user: ShellUser): NavItem[] {
  const notices: NavItem = { href: "/notifications", label: "Notifications", icon: Bell, count: user.unread };
  if (user.role === "ADMIN") {
    return [
      { href: "/admin", label: "Revenue", icon: LayoutDashboard },
      notices,
      { href: "/inbox", label: "Inbox", icon: Inbox },
      { href: "/marketplace", label: "The book", icon: BookOpen },
      { href: "/admin/queue", label: "Review queue", icon: ClipboardList, section: "Desk" },
      { href: "/admin/offers", label: "Offers", icon: Handshake, section: "Desk" },
      { href: "/closings", label: "Closings", icon: FolderOpen, section: "Desk" },
      { href: "/admin/book", label: "Desk book", icon: Library, section: "Desk" },
      { href: "/admin/verification", label: "Buyer files", icon: BadgeCheck, section: "People" },
      { href: "/admin/users", label: "Accounts", icon: Users, section: "People" },
      { href: "/admin/brokers", label: "Brokers", icon: Briefcase, section: "People" },
      { href: "/admin/contacts", label: "Contacts", icon: Contact, section: "People" },
      { href: "/admin/leads", label: "Leads", icon: Megaphone, section: "People" },
      { href: "/admin/payouts", label: "Payouts", icon: Banknote, section: "Money" },
      { href: "/admin/capital", label: "Capital", icon: Landmark, section: "Money" },
      { href: "/admin/settings", label: "Fee schedule", icon: Percent, section: "Money" },
      { href: "/admin/costs", label: "Unit costs", icon: Calculator, section: "Money" },
      { href: "/admin/compliance", label: "Compliance", icon: Gavel, section: "Records" },
      { href: "/admin/filings", label: "Filings", icon: FileStack, section: "Records" },
      { href: "/admin/templates", label: "Forms", icon: FilePen, section: "Records" },
      { href: "/admin/audit", label: "Audit log", icon: ScrollText, section: "Records" },
      { href: "/admin/blog", label: "Journal", icon: Newspaper, section: "Records" },
      { href: "/admin/analytics", label: "Analytics", icon: ChartColumn, section: "Tools" },
      { href: "/admin/assistant", label: "Assistant", icon: Bot, section: "Tools" },
      { href: "/seller/api", label: "Seller API", icon: Code, section: "Tools" },
    ];
  }
  if (user.role === "BROKER") {
    return [
      { href: "/broker", label: "Desk", icon: LayoutDashboard },
      notices,
      { href: "/broker/deals/new", label: "File a deal", icon: FilePlus },
      { href: "/broker/profile", label: "Profile", icon: UserRound },
      { href: "/closings", label: "Closings", icon: FolderOpen },
      { href: "/inbox", label: "Inbox", icon: Inbox },
    ];
  }
  if (user.role === "BUYER") {
    return [
      { href: "/marketplace", label: "The book", icon: BookOpen },
      notices,
      { href: "/inbox", label: "Inbox", icon: Inbox },
      { href: "/buyer/favorites", label: "Favorites", icon: Star, section: "Deals" },
      { href: "/buyer/offers", label: "Inquiries", icon: Handshake, section: "Deals" },
      { href: "/buyer/groups", label: "Groups", icon: Users, section: "Deals" },
      { href: "/closings", label: "Closings", icon: FolderOpen, section: "Deals" },
      { href: "/buyer/portfolio", label: "Portfolio", icon: Wallet, section: "Deals" },
      { href: "/buyer/buy-box", label: "Buy box", icon: Target, section: "Account" },
      { href: "/buyer/alerts", label: "Alerts", icon: Search, section: "Account" },
      { href: "/buyer/verification", label: "Verification", icon: BadgeCheck, section: "Account" },
      { href: "/buyer/subscription", label: "Membership", icon: CreditCard, section: "Account" },
    ];
  }
  const items: NavItem[] = [
    { href: "/seller", label: "Desk", icon: LayoutDashboard },
    notices,
    { href: "/seller/notes/new", label: "List a note", icon: FilePlus },
    { href: "/inbox", label: "Inbox", icon: Inbox },
    { href: "/closings", label: "Closings", icon: FolderOpen },
  ];
  if (user.role === "INSTITUTIONAL_SELLER") {
    items.push({ href: "/seller/pools/new", label: "Upload a tape", icon: Upload });
    items.push({ href: "/seller/api", label: "Seller API", icon: Code });
  }
  return items;
}
