import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { Menu } from "lucide-react";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

const links = [
  { href: "/#book", label: "The book" },
  { href: "/sell", label: "Sell a note" },
  { href: "/learn", label: "Learn" },
  { href: "/faq", label: "FAQ" },
  { href: "/blog", label: "Journal" },
];

export function MarketingHeader({ authed }: { authed: boolean }) {
  return (
    <header className="fixed inset-x-0 top-0 z-40 border-b border-border bg-card/55 backdrop-blur-xl">
      <div className="mx-auto flex h-20 max-w-6xl items-center justify-between px-5">
        <Logo />
        <nav className="hidden items-center gap-8 md:flex">
          {links.map((link) => (
            <Link key={link.href} href={link.href} className="text-[13px] font-medium text-muted-foreground transition hover:text-foreground">
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="hidden items-center gap-3 md:flex">
          {authed ? (
            <Button render={<Link href="/marketplace" />} className="h-10 px-4 text-[13px] font-medium">
              Enter the desk
            </Button>
          ) : (
            <>
              <Button variant="ghost" render={<Link href="/login" />} className="h-10 px-3 text-[13px] font-medium">
                Sign in
              </Button>
              <Button render={<Link href="/signup" />} className="h-10 px-4 text-[13px] font-medium">
                Request access
              </Button>
            </>
          )}
        </div>
        <Sheet>
          <SheetTrigger className="inline-flex size-10 items-center justify-center border border-border md:hidden rounded-lg" aria-label="Open menu">
            <Menu className="size-4" />
          </SheetTrigger>
          <SheetContent side="right" className="bg-card">
            <div className="mt-10 flex flex-col gap-5 px-2">
              {links.map((link) => (
                <Link key={link.href} href={link.href} className="font-semibold tracking-tight text-3xl text-foreground">
                  {link.label}
                </Link>
              ))}
              <Link href={authed ? "/marketplace" : "/login"} className="mt-4 text-[13px] font-medium text-link">
                {authed ? "Enter the desk" : "Sign in"}
              </Link>
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
            A South Florida desk for mortgage notes. Demo listings, borrowers, and documents are fictional.
          </p>
        </div>
        <div className="flex gap-8 text-[13px] font-medium text-muted-foreground">
          <Link href="/login" className="hover:text-foreground">Sign in</Link>
          <Link href="/signup" className="hover:text-foreground">Request access</Link>
          {desk && <a href={`mailto:${desk}`} className="hover:text-foreground">{desk}</a>}
        </div>
      </div>
    </footer>
  );
}
