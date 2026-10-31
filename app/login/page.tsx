import Link from "next/link";
import { LoginPanel } from "@/components/auth-forms";
import { Logo } from "@/components/logo";
import { Notice } from "@/components/notice";
import { DEMO_EMAILS, DEMO_LOGINS, DEV_DEMO_PASSWORD, showDemoDesk } from "@/lib/deploy";
import { q } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const demoAccounts = await prisma.user.count({ where: { email: { in: DEMO_EMAILS } } }).catch(() => 0);
  const demo = showDemoDesk(process.env, demoAccounts) ? { password: DEV_DEMO_PASSWORD, accounts: DEMO_LOGINS } : undefined;
  return (
    <main id="desk" className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className={demo ? "w-full max-w-[720px]" : "w-full max-w-[380px]"}>
        <Logo />
        <p className="eyebrow mt-6">Sign in</p>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-foreground">The desk is expecting you.</h1>
        <div className="mt-5">
          <Notice notice={q(params, "notice")} error={q(params, "error")} />
        </div>
        <div className="mt-5">
          <LoginPanel next={q(params, "next")} demo={demo} />
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          <Link href="/login/forgot" className="text-link">Forgot your password?</Link>
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          No account yet? <Link href="/signup" className="text-link">Request access</Link>
        </p>
      </div>
    </main>
  );
}
