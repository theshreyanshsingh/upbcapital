import Link from "next/link";
import { leaveDealList } from "@/actions/announcements";
import { Logo } from "@/components/logo";
import { Notice } from "@/components/notice";
import { SubmitButton } from "@/components/submit-button";
import { subscriberByToken } from "@/lib/announcements";
import { q } from "@/lib/format";

export const metadata = { title: "Leave the deal list", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

// Public, so it works from any inbox without an account. As on the member unsubscribe page, only the button acts.
export default async function LeaveDealListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = q(params, "token") ?? "";
  const found = await subscriberByToken(token);
  const done = q(params, "done") === "1";
  return (
    <main id="desk" className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-[420px]">
        <Logo />
        <p className="eyebrow mt-6">Deal announcements</p>
        <Notice error={q(params, "error")} />
        {!found ? (
          <>
            <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-foreground">This link doesn&apos;t work.</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">It may be cut short or changed. Use the link in the email again.</p>
          </>
        ) : done || found.left ? (
          <>
            <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-foreground">You&apos;re off the list.</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{found.email} won&apos;t get deal announcements any more.</p>
          </>
        ) : (
          <>
            <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-foreground">Stop deal announcements?</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{found.email} comes off the list. You can sign up again at any time.</p>
            <form action={leaveDealList} className="mt-5">
              <input type="hidden" name="token" value={token} />
              <SubmitButton className="h-11 px-5 text-[13px] font-medium" pendingLabel="Leaving…">Leave the list</SubmitButton>
            </form>
          </>
        )}
        <p className="mt-6 text-sm text-muted-foreground">
          <Link href="/announcements" className="text-link">Deal announcements</Link>
        </p>
      </div>
    </main>
  );
}
