import Link from "next/link";
import { requestPasswordReset } from "@/actions/password";
import { Logo } from "@/components/logo";
import { Notice } from "@/components/notice";
import { SubmitButton } from "@/components/submit-button";
import { q } from "@/lib/format";

export const metadata = { title: "Reset password" };

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return (
    <main id="desk" className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-16">
      <Logo />
      <p className="eyebrow mt-12">Password</p>
      <h1 className="mt-3 font-semibold tracking-tight text-[28px] text-foreground">Reset your password.</h1>
      <p className="mt-4 text-sm text-muted-foreground">Enter your email. If it has an account, a link good for one hour goes there.</p>
      <div className="mt-8">
        <Notice notice={q(params, "notice")} error={q(params, "error")} />
      </div>
      <form action={requestPasswordReset} className="mt-6 space-y-4">
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Email</span>
          <input name="email" type="email" autoComplete="email" aria-label="Email" className="desk-input mt-2" required />
        </label>
        <SubmitButton className="h-11 w-full text-[13px] font-medium">Send the link</SubmitButton>
      </form>
      <p className="mt-4 text-sm text-muted-foreground">
        <Link href="/login" className="text-link">Back to sign in</Link>
      </p>
    </main>
  );
}
