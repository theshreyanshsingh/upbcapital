import Link from "next/link";
import { resetPassword } from "@/actions/password";
import { Logo } from "@/components/logo";
import { Notice } from "@/components/notice";
import { SubmitButton } from "@/components/submit-button";
import { q } from "@/lib/format";

// The token is in this page's URL, so it must not travel in a Referer header.
export const metadata = { title: "Choose a password", referrer: "no-referrer" as const };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = q(params, "token") ?? "";
  return (
    <main id="desk" className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-16">
      <Logo />
      <p className="eyebrow mt-12">Password</p>
      <h1 className="mt-3 font-semibold tracking-tight text-[28px] text-foreground">Choose a new password.</h1>
      <p className="mt-4 text-sm text-muted-foreground">Saving it signs every device out.</p>
      <div className="mt-8">
        <Notice error={q(params, "error")} />
      </div>
      {token ? (
        <form action={resetPassword} className="mt-6 space-y-4">
          <input type="hidden" name="token" value={token} />
          <label className="block">
            <span className="text-[13px] text-muted-foreground">New password</span>
            <input name="password" type="password" autoComplete="new-password" minLength={8} aria-label="New password" className="desk-input mt-2" required />
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Same password again</span>
            <input name="confirm" type="password" autoComplete="new-password" minLength={8} aria-label="Confirm new password" className="desk-input mt-2" required />
          </label>
          <SubmitButton className="h-11 w-full text-[13px] font-medium">Save password</SubmitButton>
        </form>
      ) : (
        <p className="mt-6 text-sm text-muted-foreground">
          This link is missing its token. <Link href="/login/forgot" className="text-link">Ask for a new one.</Link>
        </p>
      )}
    </main>
  );
}
