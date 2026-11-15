import { submitClosingReview } from "@/actions/content";
import { Logo } from "@/components/logo";
import { SubmitButton } from "@/components/submit-button";
import { q } from "@/lib/format";
import { safeNoticeText } from "@/lib/notice-text";
import { monthYear, REVIEW_MAX, REVIEW_MIN, REVIEW_TERMS, reviewForm } from "@/lib/reviews";

export const metadata = { title: "Review your trade", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

// The form a buyer or seller reaches from the review request, after their closing and its post-closing file are
// complete. No sign-in: the signed link is the permission. Text only, no stars and no rating (lib/reviews.ts).
export default async function ReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const token = q(params, "token");
  const form = await reviewForm(token);
  const error = q(params, "error") ? (safeNoticeText(q(params, "error")) ?? "That didn't go through. Try again.") : "";
  const thanks = q(params, "done") === "1" || form.state === "done";
  return (
    <main id="desk" className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-[520px]">
        <Logo />
        <p className="eyebrow mt-6">Review your trade</p>
        {thanks ? (
          <>
            <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-foreground">Thank you.</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">The desk has your review. It reads each one before choosing which to publish, and never changes the words.</p>
          </>
        ) : form.state === "ok" ? (
          <>
            <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-foreground">How did the trade go?</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              A few lines in your own words on how your {form.side === "BUYER" ? "purchase" : "sale"} on UPB went{form.closedAt ? `, the trade that closed in ${monthYear(form.closedAt)}` : ""}. There are no stars and no ratings.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-foreground">{REVIEW_TERMS}</p>
            {error && <p role="alert" className="mt-4 rounded-xl border border-bad/30 bg-bad/10 px-4 py-3 text-sm text-bad">{error}</p>}
            <form action={submitClosingReview} className="glass mt-5 space-y-4 p-5">
              <input type="hidden" name="token" value={token} />
              <label className="block">
                <span className="text-[13px] text-muted-foreground">Your review, {REVIEW_MIN} to {REVIEW_MAX} characters</span>
                <textarea name="review" required minLength={REVIEW_MIN} maxLength={REVIEW_MAX} className="desk-input mt-2 min-h-32" />
              </label>
              <SubmitButton className="h-11 px-5 text-[13px] font-medium" pendingLabel="Sending…">Send the review</SubmitButton>
            </form>
          </>
        ) : (
          <>
            <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-foreground">{form.state === "expired" ? "This link has expired." : "This link doesn't work."}</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              {form.state === "expired" ? "Review links work for a while after the trade closes, and this one has run out. Thank you all the same." : "It may be cut short or changed. Use the link in the email again."}
            </p>
          </>
        )}
      </div>
    </main>
  );
}
