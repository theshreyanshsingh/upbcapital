import Link from "next/link";
import { SignupForm } from "@/components/auth-forms";
import { Logo } from "@/components/logo";

export const metadata = { title: "Request access" };

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const lead = typeof params.lead === "string" ? params.lead : "";
  const email = typeof params.email === "string" ? params.email : "";
  const referral = typeof params.ref === "string" ? params.ref : typeof params.referral === "string" ? params.referral : "";
  return (
    <main id="desk" className="mx-auto max-w-4xl px-5 py-16">
      <Logo />
      <p className="eyebrow mt-12">Request access</p>
      <h1 className="mt-3 max-w-xl font-semibold tracking-tight text-[28px] text-foreground">Tell the desk which seat you want.</h1>
      <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
        Buyers, institutions, and brokers are approved by the desk before they can bid, upload a tape, or file for someone else. Individual note sellers can file their own loan immediately. The listing still waits on review.
      </p>
      <div className="mt-10">
        <SignupForm lead={lead} email={email} referral={referral} />
      </div>
      <p className="mt-8 text-sm text-muted-foreground">
        Already known here? <Link href="/login" className="text-link">Sign in</Link>
      </p>
    </main>
  );
}
