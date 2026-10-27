import Link from "next/link";
import { notFound } from "next/navigation";
import { Logo } from "@/components/logo";
import { money } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Indicative range" };

export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lead = await prisma.sellerLead.findUnique({ where: { id } });
  if (!lead) notFound();
  return (
    <main id="desk" className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-5 py-16">
      <Logo />
      <p className="eyebrow mt-12">Indicative range</p>
      <h1 className="mt-3 font-semibold tracking-tight text-5xl text-foreground md:text-6xl">
        {money(Number(lead.indicativeLow))} – {money(Number(lead.indicativeHigh))}
      </h1>
      <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">{lead.basis} This is not a bid and not a commitment to buy.</p>
      <dl className="mt-8 grid gap-3 text-sm sm:grid-cols-2">
        <div><dt className="text-[13px] text-muted-foreground">Unpaid principal</dt><dd className="mt-1 text-foreground">{money(Number(lead.upb))}</dd></div>
        <div><dt className="text-[13px] text-muted-foreground">Collateral</dt><dd className="mt-1 text-foreground">{lead.city ? `${lead.city}, ` : ""}{lead.state}</dd></div>
      </dl>
      <div className="mt-10 flex flex-wrap gap-4">
        <Link href={`/signup?lead=${lead.id}&email=${encodeURIComponent(lead.email)}`} className="inline-flex h-11 items-center bg-primary px-5 text-[13px] font-medium text-primary-foreground rounded-lg">
          Create an account to list it
        </Link>
        <Link href="/sell" className="inline-flex h-11 items-center text-[13px] font-medium text-muted-foreground">
          Start over
        </Link>
      </div>
    </main>
  );
}
