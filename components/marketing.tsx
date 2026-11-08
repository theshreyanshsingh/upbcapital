import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { isReleaseBuild } from "@/lib/deploy";
import { Menu } from "lucide-react";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

const links = [
  { href: "/#how", label: "How it works" },
  { href: "/open", label: "Listings" },
  { href: "/sell", label: "Sell a note" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/learn", label: "Learn" },
  { href: "/faq", label: "FAQ" },
  { href: "/blog", label: "Journal" },
];

export function MarketingHeader({ authed }: { authed: boolean }) {
  return (
    <header className="fixed inset-x-0 top-0 z-40 border-b border-border/80 bg-background/80 backdrop-blur-md supports-backdrop-filter:bg-background/70">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 md:h-[4.5rem]">
        <Logo />
        <nav className="hidden items-center gap-8 md:flex">
          {links.map((link) => (
            <Link key={link.href} href={link.href} className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="hidden items-center gap-3 md:flex">
          {authed ? (
            <Button nativeButton={false} render={<Link href="/marketplace" />} className="h-10 rounded-xl px-4 text-sm font-medium">
              Enter the desk
            </Button>
          ) : (
            <>
              <Button variant="ghost" nativeButton={false} render={<Link href="/login" />} className="h-10 rounded-xl px-3.5 text-sm font-medium">
                Sign in
              </Button>
              <Button nativeButton={false} render={<Link href="/signup" />} className="h-10 rounded-xl px-4 text-sm font-medium">
                Request access
              </Button>
            </>
          )}
        </div>
        <Sheet>
          <SheetTrigger className="inline-flex size-10 items-center justify-center rounded-lg border border-border bg-card text-foreground shadow-card transition-colors hover:bg-hover md:hidden" aria-label="Open menu">
            <Menu className="size-4" />
          </SheetTrigger>
          <SheetContent side="right" className="bg-card">
            <div className="mt-10 flex flex-col gap-5 px-2">
              {links.map((link) => (
                <Link key={link.href} href={link.href} className="font-display text-[1.875rem] leading-tight font-medium tracking-[-0.015em] text-foreground">
                  {link.label}
                </Link>
              ))}
              <Link href={authed ? "/marketplace" : "/login"} className="mt-4 text-[15px] font-medium text-link">
                {authed ? "Enter the desk" : "Sign in"}
              </Link>
              {!authed && (
                <Link href="/signup" className="inline-flex h-12 items-center justify-center rounded-xl bg-primary px-5 text-[15px] font-medium text-primary-foreground shadow-card transition-colors hover:bg-primary/88">
                  Request access
                </Link>
              )}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}

export function MarketingFooter() {
  const desk = process.env.DESK_EMAIL?.trim();
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-5 py-12 md:flex-row md:items-end md:justify-between">
        <div>
          <Logo />
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted-foreground">
            A South Florida desk for mortgage notes.{isReleaseBuild(process.env) ? "" : " Demo listings, borrowers, and documents are fictional."}
          </p>
        </div>
        <div className="flex flex-wrap gap-x-8 gap-y-3 text-sm font-medium text-muted-foreground">
          <Link href="/login" className="transition-colors hover:text-foreground">Sign in</Link>
          <Link href="/signup" className="transition-colors hover:text-foreground">Request access</Link>
          <Link href="/open" className="transition-colors hover:text-foreground">Listings</Link>
          <Link href="/announcements" className="transition-colors hover:text-foreground">Deal announcements</Link>
          <Link href="/results" className="transition-colors hover:text-foreground">Results</Link>
          <Link href="/fees" className="transition-colors hover:text-foreground">Fees</Link>
          <Link href="/servicers" className="transition-colors hover:text-foreground">Servicers</Link>
          <Link href="/terms" className="transition-colors hover:text-foreground">Terms</Link>
          <Link href="/privacy" className="transition-colors hover:text-foreground">Privacy</Link>
          <Link href="/security" className="transition-colors hover:text-foreground">Security</Link>
          <Link href="/tape-standard" className="transition-colors hover:text-foreground">Tape standard</Link>
          {desk && <a href={`mailto:${desk}`} className="transition-colors hover:text-foreground">{desk}</a>}
        </div>
      </div>
    </footer>
  );
}
