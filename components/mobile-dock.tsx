"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BellRing, Ellipsis, Lock, LogOut, Search, XIcon, type LucideIcon } from "lucide-react";
import { logout } from "@/actions/auth";
import { ThemeToggle } from "@/components/theme-toggle";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { SheetHandle } from "@/components/ui/sheet-handle";
import { active, dockFor, initials, tabActive, type NavItem, type ShellUser } from "@/components/desk-nav";
import { roleLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";

// The tab bar for phones and tablets (below 1024px, where the sidebar takes over): the four places this role goes
// most, and More for everything else. It sits above the home indicator, and --dock in globals.css tells the rest
// of the page how tall it is.
export function MobileDock({ user, items }: { user: ShellUser; items: NavItem[] }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  // The sheet opens with focus on its header, so the desk search field doesn't raise the keyboard.
  const header = useRef<HTMLDivElement>(null);
  // A tapped tab lights at once, before its page arrives. Any change of address (the tap landing, Back, a link in
  // the page) clears it, so from then on the bar follows the address alone.
  const [tapped, setTapped] = useState<string | null>(null);
  const [seenPath, setSeenPath] = useState(path);
  if (seenPath !== path) {
    setSeenPath(path);
    setTapped(null);
  }
  const tabs = dockFor(user);
  const isOn = (href: string) => (tapped ? tapped === href : tabActive(path, href));
  const onTab = tabs.some((tab) => isOn(tab.href));
  const rest = items.filter((item) => !tabs.some((tab) => tab.href === item.href));
  return (
    <nav
      data-slot="dock"
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border/70 bg-background/88 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl supports-backdrop-filter:bg-background/72 lg:hidden print:hidden"
    >
      <ul className="mx-auto grid h-15 max-w-lg grid-cols-5 pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
        {tabs.map((tab) => (
          <li key={tab.href}>
            <DockTab item={tab} on={isOn(tab.href)} onTap={() => setTapped(tab.href)} />
          </li>
        ))}
        <li>
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger className={cn(tabClass, !onTab && "text-foreground")}>
              <span className={cn(pillClass, !onTab && "bg-link/12")}>
                <Ellipsis className={cn("size-[22px]", !onTab && "text-link")} strokeWidth={!onTab ? 2.2 : 1.8} />
              </span>
              <span>More</span>
            </SheetTrigger>
            <SheetContent
              side="bottom"
              showCloseButton={false}
              initialFocus={header}
              className="max-h-[88dvh] gap-0 rounded-t-[22px] border-border bg-sidebar p-0 pb-[env(safe-area-inset-bottom)] sm:mx-auto sm:max-w-lg sm:border-x"
            >
              <SheetHandle>
                <div ref={header} tabIndex={-1} className="flex items-center gap-3 px-5 pt-3 pb-4 outline-none">
                  <span className="grid size-11 shrink-0 place-items-center rounded-full bg-card text-[13px] font-semibold text-foreground ring-1 ring-border">
                    {initials(user.name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <SheetTitle className="truncate text-[15px] leading-5">{user.name}</SheetTitle>
                    <SheetDescription className="truncate text-[13px] leading-5">
                      {roleLabel(user.role)}
                      {user.role === "BUYER" ? ` · ${user.tier === "PRO" ? "Pro" : "Free"}` : ""} · {user.email}
                    </SheetDescription>
                  </div>
                  <SheetClose
                    aria-label="Close"
                    className="grid size-10 shrink-0 place-items-center rounded-full bg-card text-muted-foreground ring-1 ring-border transition-[scale] duration-(--dur-1) active:scale-95"
                  >
                    <XIcon className="size-[18px]" />
                  </SheetClose>
                </div>
              </SheetHandle>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-1 pb-5">
                {user.role === "ADMIN" && <DeskSearch />}
                <MoreSections items={rest} path={path} onPick={() => setOpen(false)} />
                <section aria-label="Account" className="mt-5 overflow-hidden rounded-2xl bg-card ring-1 ring-border">
                  <ThemeToggle className="min-h-12 rounded-none px-3.5" />
                  <SheetRow href="/account/notifications" icon={BellRing} label="Notice settings" onPick={() => setOpen(false)} />
                  <SheetRow href="/account/security" icon={Lock} label="Security" onPick={() => setOpen(false)} />
                  <form action={logout}>
                    <button type="submit" className="flex min-h-12 w-full items-center gap-3 border-t border-border px-3.5 text-left text-[15px] text-foreground active:bg-hover">
                      <LogOut className="size-[18px] text-muted-foreground" /> Sign out
                    </button>
                  </form>
                </section>
              </div>
            </SheetContent>
          </Sheet>
        </li>
      </ul>
    </nav>
  );
}

// Keyboard focus shows the global ring, inset inside the tab by a rule in globals.css.
const tabClass =
  "group flex h-full w-full flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] leading-4 font-medium text-muted-foreground select-none focus-visible:text-foreground";
const pillClass =
  "relative grid h-8 w-14 place-items-center rounded-full transition-[background-color,scale] duration-(--dur-1) ease-(--ease-standard) group-active:scale-90";

function DockTab({ item, on, onTap }: { item: NavItem; on: boolean; onTap: () => void }) {
  const Icon = item.icon;
  const count = item.count ? (item.count > 99 ? "99+" : String(item.count)) : null;
  return (
    <Link
      href={item.href}
      onClick={(event) => {
        // A click that opens a new tab or window leaves this page where it is, so it lights nothing.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        onTap();
      }}
      aria-current={on ? "page" : undefined}
      className={cn(tabClass, on && "text-foreground")}
    >
      <span className={cn(pillClass, on && "bg-link/12")}>
        <Icon className={cn("size-[21px]", on && "text-link")} strokeWidth={on ? 2.2 : 1.8} />
        {count && (
          <span className="figure absolute -top-0.5 right-2 min-w-[18px] rounded-full bg-link px-1 text-center text-[10px] leading-[18px] font-semibold text-background ring-2 ring-background">
            {count}
            <span className="sr-only"> unread</span>
          </span>
        )}
      </span>
      <span className="max-w-full truncate px-0.5">{item.short ?? item.label}</span>
    </Link>
  );
}

// Everything that isn't a tab, by section, as two columns of large tiles.
function MoreSections({ items, path, onPick }: { items: NavItem[]; path: string; onPick: () => void }) {
  const sections: { label: string; items: NavItem[] }[] = [];
  for (const item of items) {
    const label = item.section ?? "";
    const found = sections.find((section) => section.label === label);
    if (found) found.items.push(item);
    else sections.push({ label, items: [item] });
  }
  return (
    <>
      {sections.map((section) => (
        <section key={section.label || "main"} aria-label={section.label || "Go to"} className="mt-4 first:mt-0">
          {section.label && <h2 className="px-1 pb-2 text-[12px] leading-4 font-semibold tracking-[0.06em] text-faint uppercase">{section.label}</h2>}
          <ul className="grid grid-cols-2 gap-2">
            {section.items.map((item) => {
              const on = active(path, item.href);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onPick}
                    aria-current={on ? "page" : undefined}
                    className={cn(
                      "flex min-h-12 items-center gap-2.5 rounded-xl bg-card px-3 text-[14px] leading-5 font-medium text-foreground ring-1 ring-border transition-[scale,background-color] duration-(--dur-1) active:scale-[0.97] active:bg-hover",
                      on && "ring-link/60",
                    )}
                  >
                    <Icon className={cn("size-[18px] shrink-0", on ? "text-link" : "text-muted-foreground")} />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.count ? <span className="figure rounded-full bg-link/10 px-1.5 text-[11px] leading-[18px] font-semibold text-link">{item.count}</span> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}

function SheetRow({ href, icon: Icon, label, onPick }: { href: string; icon: LucideIcon; label: string; onPick: () => void }) {
  return (
    <Link href={href} onClick={onPick} className="flex min-h-12 items-center gap-3 border-t border-border px-3.5 text-[15px] text-foreground active:bg-hover">
      <Icon className="size-[18px] text-muted-foreground" /> {label}
    </Link>
  );
}

// The desk's record search, by name, email, loan number or address. In the More sheet (below 1024px) it is a
// finger tall; on any touch screen its text is 16px, so iOS doesn't zoom in. In the sidebar it is the compact field.
export function DeskSearch() {
  return (
    <form action="/admin/search" role="search" className="mb-3 px-0.5 max-lg:mb-4 max-lg:px-0">
      <label className="field-shell flex h-8 items-center gap-2 rounded-lg border border-input bg-field px-2.5 text-sm transition-colors focus-within:border-ring max-lg:h-11 max-lg:rounded-xl max-lg:text-base pointer-coarse:text-base">
        <Search className="size-3.5 shrink-0 text-muted-foreground max-lg:size-4" />
        <input name="q" type="search" placeholder="Search the desk" aria-label="Search the desk" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint" />
      </label>
    </form>
  );
}
