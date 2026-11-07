import Link from "next/link";
import { acceptInvitation } from "@/actions/invites";
import { Logo } from "@/components/logo";
import { Notice } from "@/components/notice";
import { SubmitButton } from "@/components/submit-button";
import { q } from "@/lib/format";

// The token is in this page's URL, so it must not travel in a Referer header.
export const metadata = { title: "Set your password", referrer: "no-referrer" as const };

export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = q(params, "token") ?? "";
  return (
    <main id="desk" className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-16">
      <Logo />
      <p className="eyebrow mt-12">Invitation</p>
      <h1 className="mt-3 font-semibold tracking-tight text-[28px] text-foreground">Set your password.</h1>
      <p className="mt-4 text-sm text-muted-foreground">The desk set up your account. Choose a password to open it. Next you set up two-step sign-in, as every account does.</p>
      <div className="mt-8">
        <Notice error={q(params, "error")} />
      </div>
      {token ? (
        <form action={acceptInvitation} className="mt-6 space-y-4">
          <input type="hidden" name="token" value={token} />
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
          <SubmitButton className="h-11 w-full text-[13px] font-medium" pendingLabel="Opening…">Open my account</SubmitButton>
        </form>
      ) : (
        <p className="mt-6 text-sm text-muted-foreground">
          This link is missing its token. Ask the desk to send the invitation again.
        </p>
      )}
    </main>
  );
}
