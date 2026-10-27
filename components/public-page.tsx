import Link from "next/link";
import { MarketingFooter, MarketingHeader } from "@/components/marketing";

export function PublicPage({ title, lede, children }: { title: string; lede: string; children: React.ReactNode }) {
  return (
    <div>
      <MarketingHeader authed={false} />
      <main id="desk" className="mx-auto max-w-3xl px-5 pb-24 pt-32">
        <p className="eyebrow">The desk</p>
        <h1 className="mt-4 font-semibold tracking-tight text-5xl text-foreground sm:text-6xl">{title}</h1>
        <p className="mt-6 text-lg font-light leading-relaxed text-muted-foreground">{lede}</p>
        <div className="mt-10 space-y-6 text-base leading-relaxed text-foreground/90">{children}</div>
        <p className="mt-12 text-sm text-muted-foreground">
          <Link href="/learn" className="text-link">Education</Link>
          {" · "}
          <Link href="/faq" className="text-link">FAQ</Link>
          {" · "}
          <Link href="/blog" className="text-link">Journal</Link>
          {" · "}
          <Link href="/developers" className="text-link">API</Link>
        </p>
      </main>
      <MarketingFooter />
    </div>
  );
}
