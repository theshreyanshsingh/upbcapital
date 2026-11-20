import Link from "next/link";
import { notFound } from "next/navigation";
import { keepWatchingValuation } from "@/actions/note-watch";
import { PublicPage } from "@/components/public-page";
import { SubmitButton } from "@/components/submit-button";
import { getCurrentUser } from "@/lib/auth";
import { money, prettyDate, q } from "@/lib/format";
import { INDICATIVE_DISCLAIMER } from "@/lib/indicative";
import { canWatch, defaultLabel, MAX_LABEL, watchableValuation } from "@/lib/note-watch";
import { safeNoticeText } from "@/lib/notice-text";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Your valuation", robots: { index: false } };
export const dynamic = "force-dynamic";

// The range a request was given. It shows the figures and their basis only, never the loans or who asked.
export default async function ValuationResultPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const [request, user] = await Promise.all([
    prisma.valuationRequest.findUnique({ where: { id }, select: { id: true, loans: true, upb: true, lowPrice: true, highPrice: true, basis: true, status: true, deskNote: true, createdAt: true, updatedAt: true, tapeKey: true } }),
    getCurrentUser().catch(() => null),
  ]);
  if (!request || request.lowPrice == null || request.highPrice == null) notFound();
  // Note watch takes one typed loan. Only a seller signed in with the request's own email sees the loan's form.
  const single = request.loans === 1 && !request.tapeKey;
  const watchable = single && user && canWatch(user) ? await watchableValuation(user, request.id) : null;
  const watchError = safeNoticeText(q(query, "error"));
  const back = encodeURIComponent(`/sell/value/${request.id}#watch`);
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
        {/* The request's id goes along, so the new account picks it up when it signs up with the same email. */}
        <Link href={user ? "/seller" : `/signup?valuation=${encodeURIComponent(request.id)}`} className="inline-flex h-11 items-center rounded-lg bg-primary px-5 text-[13px] font-medium text-primary-foreground">
          {user ? "Go to your desk" : "Create a seller account"}
        </Link>
        <Link href="/fees" className="inline-flex h-11 items-center text-[13px] font-medium text-muted-foreground">What a sale costs</Link>
      </div>
      {single && (!user || canWatch(user)) && (
        <section id="watch" className="glass scroll-mt-6 p-5 md:p-6" aria-labelledby="watch-heading">
          <h2 id="watch-heading" className="eyebrow">Keep watching this note</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Not ready to sell? Once a month the desk reads this note&apos;s range again, counts the buyers whose boxes fit it, and emails you what changed. List it in one step when you&apos;re ready.
          </p>
          {watchError && <p role="alert" className="mt-3 rounded-xl border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">{watchError}</p>}
          {watchable ? (
            <form action={keepWatchingValuation} className="mt-4 space-y-3">
              <input type="hidden" name="valuationId" value={request.id} />
              <label className="block">
                <span className="text-[13px] text-muted-foreground">Label, only you see it</span>
                <input name="label" required maxLength={MAX_LABEL} defaultValue={defaultLabel(watchable.loan)} className="desk-input mt-2" />
              </label>
              <SubmitButton className="h-11 w-full px-5 text-[13px] font-medium sm:w-auto" pendingLabel="Reading…">Keep watching this note</SubmitButton>
            </form>
          ) : user ? (
            <p className="mt-3 text-sm text-muted-foreground">This valuation was sent from another email, so it can&apos;t join this account. Add the note on <Link href="/seller/watch" className="text-link">Note watch</Link> instead.</p>
          ) : (
            <div className="mt-4 flex flex-wrap items-center gap-4">
              {/* The same carry as the signup link above, and back here to finish. */}
              <Link href={`/signup?valuation=${encodeURIComponent(request.id)}&next=${back}`} className="inline-flex h-11 items-center rounded-lg bg-primary px-5 text-[13px] font-medium text-primary-foreground">
                Create a seller account to watch it
              </Link>
              <Link href={`/login?next=${back}`} className="inline-flex h-11 items-center text-[13px] font-medium text-link">Sign in</Link>
            </div>
          )}
        </section>
      )}
    </PublicPage>
  );
}
