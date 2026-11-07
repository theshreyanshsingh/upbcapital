import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicPage } from "@/components/public-page";
import { getCurrentUser } from "@/lib/auth";
import { money, prettyDate } from "@/lib/format";
import { INDICATIVE_DISCLAIMER } from "@/lib/indicative";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Your valuation", robots: { index: false } };
export const dynamic = "force-dynamic";

// The range a request was given. It shows the figures and their basis only, never the loans or who asked.
export default async function ValuationResultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [request, user] = await Promise.all([
    prisma.valuationRequest.findUnique({ where: { id }, select: { id: true, loans: true, upb: true, lowPrice: true, highPrice: true, basis: true, status: true, deskNote: true, createdAt: true, updatedAt: true } }),
    getCurrentUser().catch(() => null),
  ]);
  if (!request || request.lowPrice == null || request.highPrice == null) notFound();
  const quoted = request.status === "QUOTED" || request.status === "LISTED";
  const share = (price: number) => (request.upb > 0 ? `${Math.round((price / request.upb) * 100)}%` : "");
  return (
    <PublicPage
      title={`${money(request.lowPrice)} to ${money(request.highPrice)}`}
      lede={`${quoted ? "The desk's range" : "The indicative range"} for ${request.loans === 1 ? "the loan" : `${request.loans} loans`} you sent, ${money(request.upb)} unpaid balance. That is ${share(request.lowPrice)} to ${share(request.highPrice)} of the balance.`}
      authed={Boolean(user)}
    >
      <section className="glass p-5 md:p-6" aria-labelledby="basis-heading">
        <h2 id="basis-heading" className="eyebrow">What it rests on</h2>
        {quoted && request.deskNote && <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{request.deskNote}</p>}
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{quoted ? `The desk's first read, on ${prettyDate(request.createdAt)}: ` : ""}{request.basis}</p>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{INDICATIVE_DISCLAIMER} A price is set only when buyers bid on a listing.</p>
      </section>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {quoted ? `The desk sent this range on ${prettyDate(request.updatedAt)}.` : "The desk has your request and will read what you sent. Expect an email with its own range."} To sell, the desk reviews the file and lists the loans for approved buyers.
      </p>
      <div className="flex flex-wrap gap-4">
        <Link href={user ? "/seller" : "/signup"} className="inline-flex h-11 items-center rounded-lg bg-primary px-5 text-[13px] font-medium text-primary-foreground">
          {user ? "Go to your desk" : "Create a seller account"}
        </Link>
        <Link href="/fees" className="inline-flex h-11 items-center text-[13px] font-medium text-muted-foreground">What a sale costs</Link>
      </div>
    </PublicPage>
  );
}
