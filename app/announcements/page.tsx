import Link from "next/link";
import { joinDealList } from "@/actions/announcements";
import { Notice } from "@/components/notice";
import { PublicPage } from "@/components/public-page";
import { SubmitButton } from "@/components/submit-button";
import { getCurrentUser } from "@/lib/auth";
import { q } from "@/lib/format";

export const metadata = {
  title: "Deal announcements",
  description: "New mortgage notes on UPB Capital, by email, when the desk announces them.",
};
export const dynamic = "force-dynamic";

export default async function DealListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [user, params] = await Promise.all([getCurrentUser(), searchParams]);
  return (
    <PublicPage
      authed={Boolean(user)}
      title="New notes, by email."
      lede="When the desk has new listings to show, it sends a short announcement. Each one names the city, lien, performance and a UPB band. The file opens on the desk."
    >
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      {user ? (
        <div className="glass p-6">
          <p className="text-sm leading-relaxed text-muted-foreground">
            You are signed in. Turn on deal announcements under <Link href="/account/notifications" className="text-link">Notices</Link>.
          </p>
        </div>
      ) : (
        <form action={joinDealList} className="glass grid gap-4 p-6 sm:grid-cols-2">
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Name</span>
            <input name="name" autoComplete="name" maxLength={120} className="desk-input mt-2" />
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Email</span>
            <input name="email" type="email" required autoComplete="email" maxLength={254} className="desk-input mt-2" />
          </label>
          {/* Left empty by people. A bot that fills it is turned away. */}
          <label className="hidden" aria-hidden="true">
            Website
            <input name="website" tabIndex={-1} autoComplete="off" />
          </label>
          <div className="sm:col-span-2">
            <SubmitButton className="h-11 px-6 text-[13px] font-medium" pendingLabel="Sending…">Join the list</SubmitButton>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              We send a link to confirm the address first. Every announcement has a one-click way out. We count opens and clicks, as the{" "}
              <Link href="/privacy" className="text-link">privacy policy</Link> says.
            </p>
          </div>
        </form>
      )}
      <p className="text-sm text-muted-foreground">
        <Link href="/open" className="text-link">See what is live now</Link>
      </p>
    </PublicPage>
  );
}
