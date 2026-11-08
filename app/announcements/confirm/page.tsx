import Link from "next/link";
import { confirmDealList } from "@/actions/announcements";
import { Logo } from "@/components/logo";
import { Notice } from "@/components/notice";
import { SubmitButton } from "@/components/submit-button";
import { subscriberByToken } from "@/lib/announcements";
import { q } from "@/lib/format";

export const metadata = { title: "Confirm the deal list", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

// Opening the link changes nothing: a mail scanner follows links, so the address joins only on the button.
export default async function ConfirmDealListPage({
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
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">It may be cut short or changed. Sign up again to get a new one.</p>
          </>
        ) : done || (found.confirmed && !found.left) ? (
          <>
            <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-foreground">You&apos;re on the list.</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              {found.email} gets the desk&apos;s deal announcements. Each email has a link to leave.
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-foreground">Confirm {found.email}?</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">The desk sends new listings to this address when it announces them. You can leave from any announcement.</p>
            <form action={confirmDealList} className="mt-5">
              <input type="hidden" name="token" value={token} />
              <SubmitButton className="h-11 px-5 text-[13px] font-medium" pendingLabel="Confirming…">Confirm</SubmitButton>
            </form>
          </>
        )}
        <p className="mt-6 text-sm text-muted-foreground">
          <Link href="/open" className="text-link">See what is live now</Link>
        </p>
      </div>
    </main>
  );
}
