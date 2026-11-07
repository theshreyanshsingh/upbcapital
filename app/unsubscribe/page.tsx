import Link from "next/link";
import { confirmUnsubscribe } from "@/actions/unsubscribe";
import { Logo } from "@/components/logo";
import { SubmitButton } from "@/components/submit-button";
import { q } from "@/lib/format";
import { categoryText, readUnsubscribeToken } from "@/lib/unsubscribe";

export const metadata = { title: "Unsubscribe", robots: { index: false, follow: false } };

// Public, so it works from any inbox without signing in. Opening the link changes nothing: a mail scanner follows
// links, so the setting turns off only on the button.
export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = q(params, "token") ?? "";
  const found = readUnsubscribeToken(token);
  const done = q(params, "done") === "1";
  const what = found ? categoryText(found) : "";
  return (
    <main id="desk" className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-[420px]">
        <Logo />
        <p className="eyebrow mt-6">Unsubscribe</p>
        {!found ? (
          <>
            <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-foreground">This link doesn&apos;t work.</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              It may be cut short or changed. Use the link in the email again, or sign in and change your notices.
            </p>
          </>
        ) : done ? (
          <>
            <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-foreground">You&apos;re unsubscribed.</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              You won&apos;t get {what} any more. Mail about your bids, closings and account still comes, since it is about deals you are in.
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-foreground">Stop {what}?</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              This turns off {what} only. Mail about your bids, closings and account still comes. You can turn it back on under Notices.
            </p>
            <form action={confirmUnsubscribe} className="mt-5">
              <input type="hidden" name="token" value={token} />
              <SubmitButton className="h-11 px-5 text-[13px] font-medium" pendingLabel="Unsubscribing…">Unsubscribe</SubmitButton>
            </form>
          </>
        )}
        <p className="mt-6 text-sm text-muted-foreground">
          <Link href="/account/notifications" className="text-link">Manage all notices</Link>
        </p>
      </div>
    </main>
  );
}
