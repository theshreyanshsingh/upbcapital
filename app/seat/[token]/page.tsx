import type { Metadata } from "next";
import Link from "next/link";
import { acceptTeamInvite } from "@/actions/seats";
import { Logo } from "@/components/logo";
import { Notice } from "@/components/notice";
import { SubmitButton } from "@/components/submit-button";
import { q } from "@/lib/format";
import { SEAT_ROLE_HINTS, SEAT_ROLE_LABELS, openSeatInvite } from "@/lib/seats";

export const dynamic = "force-dynamic";

// The token is in this page's URL, so it must not travel in a Referer header, and the page stays out of search.
export const metadata: Metadata = { title: "Take your seat", referrer: "no-referrer", robots: { index: false, follow: false } };

// The link in a seat invitation. The invitee sets a name and password, and the seat opens. A link that is used,
// withdrawn, lapsed or unknown says only that, and names no firm.
export default async function SeatPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const invite = await openSeatInvite(token);
  return (
    <main id="desk" className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-16">
      <Logo />
      <p className="eyebrow mt-12">Seat invitation</p>
      {invite.state === "open" ? (
        <>
          <h1 className="mt-3 font-semibold tracking-tight text-[28px] text-foreground">A seat on {invite.firm}.</h1>
          <p className="mt-4 text-sm text-muted-foreground">
            You were invited as {invite.email}, with a {SEAT_ROLE_LABELS[invite.seatRole].toLowerCase()} seat: {SEAT_ROLE_HINTS[invite.seatRole].toLowerCase()} You sign in with your own password, and set up two-step sign-in next if the desk asks for it.
          </p>
          <div className="mt-8">
            <Notice error={q(query, "error")} />
          </div>
          <form action={acceptTeamInvite} className="mt-6 space-y-4">
            <input type="hidden" name="token" value={token} />
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Your name</span>
              <input name="name" defaultValue={invite.name} required minLength={2} maxLength={120} autoComplete="name" className="desk-input mt-2" />
            </label>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Password</span>
              <input name="password" type="password" autoComplete="new-password" minLength={8} aria-label="Password" className="desk-input mt-2" required />
            </label>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Same password again</span>
              <input name="confirm" type="password" autoComplete="new-password" minLength={8} aria-label="Confirm password" className="desk-input mt-2" required />
            </label>
            <label className="flex items-start gap-2 text-sm text-muted-foreground">
              <input type="checkbox" name="terms" value="yes" required className="mt-0.5 size-4 shrink-0 accent-link" />
              <span>
                I agree to the{" "}
                <Link href="/terms" target="_blank" className="text-link">Terms of use</Link>
                {" "}and{" "}
                <Link href="/privacy" target="_blank" className="text-link">Privacy policy</Link>.
              </span>
            </label>
            <SubmitButton className="h-11 w-full text-[13px] font-medium" pendingLabel="Opening…">Take the seat</SubmitButton>
          </form>
        </>
      ) : (
        <>
          <h1 className="mt-3 font-semibold tracking-tight text-[28px] text-foreground">This invitation isn&apos;t open.</h1>
          <p className="mt-4 text-sm text-muted-foreground">It may have been used, withdrawn or left past its seven days. Ask whoever invited you for a new link.</p>
          <Link href="/login" className="mt-8 inline-flex h-11 w-fit items-center border border-link/40 px-5 text-[13px] font-medium text-link rounded-lg">
            Sign in
          </Link>
        </>
      )}
    </main>
  );
}
