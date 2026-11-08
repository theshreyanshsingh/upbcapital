"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BellRing, ChevronsUpDown, Lock, LogOut, ScrollText, Search, type LucideIcon } from "lucide-react";
import { logout } from "@/actions/auth";
import { OnboardingTour } from "@/components/tour";
import { EmailConfirmBanner } from "@/components/email-confirm-banner";
import { Logo } from "@/components/logo";
import { DeskSearch, MobileDock } from "@/components/mobile-dock";
import { ThemeToggle } from "@/components/theme-toggle";
import { isMacLike, openCommandPalette } from "@/components/command-palette";
import { active, initials, navFor, type NavItem, type ShellUser } from "@/components/desk-nav";
import { homeFor, roleLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";

export type { ShellUser };

// termsDue: the account hasn't accepted the current terms and privacy policy. A slim line asks, and blocks nothing.
// emailDue: the address the account has yet to confirm, when the desk requires it.
export function AppShell({ user, termsDue = false, emailDue = null, children }: { user: ShellUser; termsDue?: boolean; emailDue?: string | null; children: React.ReactNode }) {
  const items = navFor(user);
  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 flex-col border-r border-sidebar-border bg-sidebar px-3 pt-3 pb-3 lg:flex print:hidden">
        <div className="flex h-11 items-center px-2 pb-1">
          <Logo href={homeFor(user.role)} />
        </div>
        <PaletteButton />
        {user.role === "ADMIN" && <DeskSearch />}
        <SideNav items={items} />
        <Account user={user} />
      </aside>
      <div className="lg:pl-72 print:pl-0">
        {/* Below 1024px (phones and tablets): the mark and search up top, and the tab bar below within reach of a
            thumb. The sidebar takes over from 1024px. */}
        <header data-slot="phone-header" className="sticky top-0 z-30 border-b border-border/70 bg-background/88 pt-[env(safe-area-inset-top)] backdrop-blur-xl supports-backdrop-filter:bg-background/72 lg:hidden print:hidden">
          <div className="flex h-13 items-center justify-between gap-3 pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))]">
            <Logo href={homeFor(user.role)} />
            <button
              type="button"
              onClick={openCommandPalette}
              aria-label="Search or jump to a page"
              className="inline-flex size-10 items-center justify-center rounded-full text-foreground transition-[background-color,scale] duration-(--dur-1) hover:bg-hover active:scale-95 active:bg-hover"
            >
              <Search className="size-5" />
            </button>
          </div>
        </header>
        {/* The page gutter is --gutter-l/-r, never less than the notch's inset in landscape. A full-bleed strip
            (sticky tabs, a swipe row) uses the bleed-x utility to reach the edges through it. */}
        <main
          id="desk"
          className="min-w-0 pt-5 pr-(--gutter-r) pb-[calc(var(--dock,0px)+2.5rem)] pl-(--gutter-l) [--gutter-l:max(1rem,env(safe-area-inset-left))] [--gutter-r:max(1rem,env(safe-area-inset-right))] md:pt-7 md:[--gutter-l:max(2rem,env(safe-area-inset-left))] md:[--gutter-r:max(2rem,env(safe-area-inset-right))] lg:pb-12 print:pb-0"
        >
          {termsDue && (
            <p role="status" className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-link/25 bg-link/5 px-3.5 py-2 text-[13px] text-foreground print:hidden">
              <ScrollText aria-hidden className="size-4 shrink-0 text-link" />
              <span>The terms of use and privacy policy need your acceptance.</span>
              <Link href="/terms#accept" className="font-medium text-link">Read and accept</Link>
            </p>
          )}
          {emailDue && <EmailConfirmBanner email={emailDue} />}
          {children}
        </main>
        <MobileDock user={user} items={items} />
        <OnboardingTour role={user.role} />
      </div>
    </div>
  );
}

// Opens the command palette. The shortcut hint reads ⌘K on a Mac and Ctrl K elsewhere, set after mount so the
// server render and the first client render agree.
function PaletteButton() {
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(isMacLike()), []);
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      className="field-shell mb-2 flex h-8 w-full items-center gap-2 rounded-lg border border-input bg-field px-2.5 text-left text-sm text-muted-foreground transition-colors hover:border-ring"
    >
      <Search className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">Search or jump to…</span>
      <kbd className="rounded border border-border px-1 text-[11px] text-muted-foreground">{mac ? "⌘K" : "Ctrl K"}</kbd>
    </button>
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
    <nav className="-mx-1 mt-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-2">
      {sections.map((section) => (
        <div key={section.label || "main"} className={section.label ? "mt-5" : ""}>
          {section.label && <p className="px-2.5 pb-1.5 text-[0.6875rem] leading-4 font-semibold tracking-[0.08em] text-faint uppercase">{section.label}</p>}
          {section.items.map((item) => {
            const on = active(path, item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "group relative mb-px flex min-h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors",
                  on
                    ? "bg-card font-medium text-foreground shadow-card ring-1 ring-sidebar-border"
                    : "text-nav hover:bg-hover hover:text-foreground",
                )}
              >
                {on && <span aria-hidden className="absolute inset-y-2 -left-1 w-[3px] rounded-full bg-link" />}
                <Icon className={cn("size-4 shrink-0 transition-colors", on ? "text-link" : "text-faint group-hover:text-muted-foreground")} />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.count ? <span className="figure min-w-5 rounded-full bg-link/10 px-1.5 text-center text-[11px] leading-[18px] font-semibold text-link">{item.count}</span> : null}
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
        <div className="absolute right-0 bottom-[58px] left-0 animate-in rounded-xl border border-border bg-popover p-1.5 shadow-float duration-(--dur-2) ease-(--ease-enter) fade-in-0 slide-in-from-bottom-1">
          <div className="flex items-center gap-2.5 p-2">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold text-foreground ring-1 ring-border">{initials(user.name)}</span>
            <span className="min-w-0">
              <strong className="block truncate text-sm font-semibold">{user.name}</strong>
              <em className="block truncate text-xs not-italic text-muted-foreground">{roleLabel(user.role)}{plan}</em>
            </span>
          </div>
          <div aria-hidden className="mx-1 my-1 h-px bg-border" />
          <ThemeToggle />
          <MenuLink href="/account/notifications" icon={BellRing} label="Notice settings" onPick={() => setOpen(false)} />
          <MenuLink href="/account/security" icon={Lock} label="Security" onPick={() => setOpen(false)} />
          {user.role !== "ADMIN" && user.role !== "BROKER" && <MenuLink href="/account/agreements" icon={ScrollText} label="Agreements" onPick={() => setOpen(false)} />}
          <form action={logout}>
            <button type="submit" className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-hover">
              <LogOut className="size-[15px] text-muted-foreground" /> Sign out
            </button>
          </form>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left transition-colors hover:bg-hover aria-expanded:bg-hover"
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-card text-[10px] font-semibold text-foreground ring-1 ring-border">{initials(user.name)}</span>
        <span className="min-w-0 flex-1">
          <strong className="block truncate text-[13px] font-semibold">{user.name}</strong>
          <em className="block truncate text-xs not-italic text-muted-foreground">{user.seat ? `${user.seat.firm} · signed in as ${user.seat.person}` : user.email}</em>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </div>
  );
}

function MenuLink({ href, icon: Icon, label, onPick }: { href: string; icon: LucideIcon; label: string; onPick: () => void }) {
  return (
    <Link href={href} onClick={onPick} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-sm transition-colors hover:bg-hover">
      <Icon className="size-[15px] text-muted-foreground" /> {label}
    </Link>
  );
}
