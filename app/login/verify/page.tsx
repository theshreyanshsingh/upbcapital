import { sendEmailCode, verifyLoginTotp } from "@/actions/security";
import { prisma } from "@/lib/prisma";
import { Logo } from "@/components/logo";
import { Notice } from "@/components/notice";
import { SubmitButton } from "@/components/submit-button";
import { pendingUserId } from "@/lib/auth";
import { q } from "@/lib/format";
import { redirect } from "next/navigation";

export const metadata = { title: "Verify" };

export default async function VerifyLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const pending = await pendingUserId();
  if (!pending) redirect("/login");
  const account = await prisma.user.findUnique({ where: { id: pending }, select: { emailOtpFallback: true } });
  const params = await searchParams;
  return (
    <main id="desk" className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-16">
      <Logo />
      <p className="eyebrow mt-12">Second factor</p>
      <h1 className="mt-3 font-semibold tracking-tight text-[28px] text-foreground">Enter the code.</h1>
      <p className="mt-4 text-sm text-muted-foreground">The authenticator on this account refreshes every thirty seconds.</p>
      <div className="mt-8">
        <Notice notice={q(params, "notice")} error={q(params, "error")} />
      </div>
      <form action={verifyLoginTotp} className="mt-6 space-y-4">
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Code</span>
          <input name="code" inputMode="numeric" autoComplete="one-time-code" aria-label="Authenticator code" className="desk-input mt-2" required />
        </label>
        <SubmitButton className="h-11 w-full text-[13px] font-medium">Continue</SubmitButton>
      </form>
      {account?.emailOtpFallback && (
        <form action={sendEmailCode} className="mt-4">
          <SubmitButton variant="outline" className="h-11 w-full text-[13px] font-medium">Email me a code</SubmitButton>
        </form>
      )}
      <p className="mt-4 text-sm text-muted-foreground">A recovery code works here too, once.</p>
    </main>
  );
}
