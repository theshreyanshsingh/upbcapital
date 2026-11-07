import {
  BadgeCheck,
  Banknote,
  Bell,
  BookOpen,
  Bot,
  Briefcase,
  Calculator,
  Scale,
  Building2,
  CalendarDays,
  ChartColumn,
  ClipboardList,
  Code,
  Contact,
  CreditCard,
  FilePen,
  FilePlus,
  FileStack,
  FolderOpen,
  Gavel,
  History,
  Handshake,
  Inbox,
  Landmark,
  LayoutDashboard,
  Library,
  Megaphone,
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
  Receipt,
  TrendingUp,
} from "lucide-react";
import type { DeskCapability } from "@/lib/desk-roles";

// The desk's navigation for each role: the sidebar on a wide screen, and the tab bar plus its More sheet on a phone.
export type ShellUser = {
  name: string;
  email: string;
  role: string;
  tier: string;
  unread: number;
  // A desk account's capabilities, from lib/desk-roles.ts. Missing shows every desk page.
  can?: readonly DeskCapability[];
};

// needs: a desk page that only writes, hidden from a role that can't use it. Pages that show records stay for all.
export type NavItem = { href: string; label: string; icon: LucideIcon; section?: string; count?: number; short?: string; needs?: DeskCapability };

export function active(path: string, href: string) {
  if (href === "/seller" || href === "/admin" || href === "/marketplace" || href === "/buyer/subscription" || href === "/broker") {
    return path === href;
  }
  return path === href || path.startsWith(`${href}/`);
}

// A detail page lights the tab it was opened from, so the tab bar keeps its place: a listing in the book, a
// seller's own listing on their desk, a listing under review in the queue, a broker's deal on theirs.
export function tabActive(path: string, href: string) {
  if (href === "/marketplace") return path === href || path.startsWith("/marketplace/");
  if (href === "/seller") return path === href || path.startsWith("/seller/listings/");
  if (href === "/admin/queue") return active(path, href) || path.startsWith("/admin/listings/");
  if (href === "/broker") return path === href || (path.startsWith("/broker/deals/") && path !== "/broker/deals/new");
  return active(path, href);
}

export function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

// The four places each role goes most, for the phone's tab bar. The fifth tab opens everything else.
export function dockFor(user: ShellUser): NavItem[] {
  const notices: NavItem = { href: "/notifications", label: "Notifications", short: "Notices", icon: Bell, count: user.unread };
  if (user.role === "ADMIN") {
    return [
      { href: "/admin", label: "Revenue", icon: LayoutDashboard },
      { href: "/admin/queue", label: "Review queue", short: "Queue", icon: ClipboardList },
      { href: "/admin/offers", label: "Offers", icon: Handshake },
      notices,
    ];
  }
  if (user.role === "BROKER") {
    return [
      { href: "/broker", label: "Desk", icon: LayoutDashboard },
      { href: "/broker/deals/new", label: "File a deal", short: "File", icon: FilePlus },
      { href: "/closings", label: "Closings", icon: FolderOpen },
      notices,
    ];
  }
  if (user.role === "BUYER") {
    return [
      { href: "/marketplace", label: "The book", short: "Book", icon: BookOpen },
      { href: "/buyer/offers", label: "Inquiries", icon: Handshake },
      { href: "/closings", label: "Closings", icon: FolderOpen },
      notices,
    ];
  }
  return [
    { href: "/seller", label: "Desk", icon: LayoutDashboard },
    user.role === "INSTITUTIONAL_SELLER"
      ? { href: "/seller/pools/new", label: "Upload a tape", short: "Upload", icon: Upload }
      : { href: "/seller/notes/new", label: "List a note", short: "List", icon: FilePlus },
    { href: "/closings", label: "Closings", icon: FolderOpen },
    notices,
  ];
}

export function navFor(user: ShellUser): NavItem[] {
  const notices: NavItem = { href: "/notifications", label: "Notifications", icon: Bell, count: user.unread };
  if (user.role === "ADMIN") {
    const items: NavItem[] = [
      { href: "/admin", label: "Revenue", icon: LayoutDashboard },
      notices,
      { href: "/inbox", label: "Inbox", icon: Inbox },
      { href: "/marketplace", label: "The book", icon: BookOpen },
      { href: "/admin/queue", label: "Review queue", icon: ClipboardList, section: "Desk" },
      { href: "/admin/offers", label: "Offers", icon: Handshake, section: "Desk" },
      { href: "/admin/events", label: "Events", icon: CalendarDays, section: "Desk" },
      { href: "/admin/market", label: "Agency sales", icon: Building2, section: "Desk" },
      { href: "/market", label: "Market dispatch", icon: TrendingUp, section: "Desk" },
      { href: "/closings", label: "Closings", icon: FolderOpen, section: "Desk" },
      { href: "/admin/book", label: "Desk book", icon: Library, section: "Desk" },
      { href: "/admin/verification", label: "Buyer files", icon: BadgeCheck, section: "People" },
      { href: "/admin/users", label: "Accounts", icon: Users, section: "People" },
      { href: "/admin/brokers", label: "Brokers", icon: Briefcase, section: "People" },
      { href: "/admin/contacts", label: "Contacts", icon: Contact, section: "People" },
      { href: "/admin/leads", label: "Leads", icon: Megaphone, section: "People" },
      { href: "/admin/valuations", label: "Valuations", icon: Scale, section: "People", needs: "sales" },
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
      { href: "/admin/jobs", label: "Jobs", icon: History, section: "Tools" },
      { href: "/admin/assistant", label: "Assistant", icon: Bot, section: "Tools", needs: "sales" },
      { href: "/seller/api", label: "Seller API", icon: Code, section: "Tools", needs: "admin" },
    ];
    const can = user.can;
    return can ? items.filter((item) => !item.needs || can.includes(item.needs)) : items;
  }
  if (user.role === "BROKER") {
    return [
      { href: "/broker", label: "Desk", icon: LayoutDashboard },
      notices,
      { href: "/broker/deals/new", label: "File a deal", icon: FilePlus },
      { href: "/broker/profile", label: "Profile", icon: UserRound },
      { href: "/closings", label: "Closings", icon: FolderOpen },
      { href: "/inbox", label: "Inbox", icon: Inbox },
      { href: "/market", label: "Market dispatch", icon: TrendingUp },
      { href: "/fees", label: "Fee schedule", icon: Receipt },
    ];
  }
  if (user.role === "BUYER") {
    return [
      { href: "/marketplace", label: "The book", icon: BookOpen },
      { href: "/events", label: "Events", icon: CalendarDays },
      { href: "/market", label: "Market dispatch", icon: TrendingUp },
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
      { href: "/fees", label: "Fee schedule", icon: Receipt, section: "Account" },
    ];
  }
  const items: NavItem[] = [
    { href: "/seller", label: "Desk", icon: LayoutDashboard },
    notices,
    { href: "/seller/notes/new", label: "List a note", icon: FilePlus },
    { href: "/inbox", label: "Inbox", icon: Inbox },
    { href: "/closings", label: "Closings", icon: FolderOpen },
    { href: "/market", label: "Market dispatch", icon: TrendingUp },
    { href: "/fees", label: "Fee schedule", icon: Receipt },
  ];
  if (user.role === "INSTITUTIONAL_SELLER") {
    items.push({ href: "/seller/pools/new", label: "Upload a tape", icon: Upload });
    items.push({ href: "/seller/api", label: "Seller API", icon: Code });
  }
  return items;
}
