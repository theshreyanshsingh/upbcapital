import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { MarketingFooter, MarketingHeader } from "@/components/marketing";
import { getCurrentUser } from "@/lib/auth";
import { openInvite } from "@/lib/private-listings";

export const dynamic = "force-dynamic";

// The page names nothing about the listing, so a forwarded or guessed link tells its holder nothing.
export const metadata: Metadata = { title: "Invitation", robots: { index: false, follow: false } };

// The link in a private-sale invitation. The buyer it went to lands on the listing; anyone else is asked to sign in
// with that address and learns nothing about what it opens.
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await getCurrentUser();
  const opening = await openInvite(token, user);
  if (opening.state === "open") redirect(`/marketplace/${opening.listingId}`);
  const here = `/invite/${encodeURIComponent(token)}`;
  const copy =
    opening.state === "missing"
      ? { title: "This invitation isn't open.", body: "It may have been withdrawn, or the link is incomplete. Ask whoever sent it for a new one." }
      : opening.state === "mismatch"
        ? { title: "This invitation is for another address.", body: "Sign out, then sign in with the email address the invitation went to." }
        : {
            title: "You were invited to a private sale.",
            body: "Sign in with the email address the invitation went to, and it opens. New to UPB Capital? Request a buyer seat with that address, and you come back here. It opens once the desk approves your account.",
          };
  return (
    <div>
      <MarketingHeader authed={Boolean(user)} />
      <main id="desk" className="mx-auto max-w-xl px-5 pb-24 pt-32">
        <p className="eyebrow">Invitation</p>
        <h1 className="mt-4 font-semibold tracking-tight text-4xl text-foreground">{copy.title}</h1>
        <p className="mt-4 text-base leading-relaxed text-muted-foreground">{copy.body}</p>
        <div className="mt-8 flex flex-wrap gap-3">
          {opening.state === "signin" && (
            <>
              <Link href={`/login?next=${encodeURIComponent(here)}`} className="inline-flex h-11 items-center bg-primary px-5 text-[13px] font-medium text-primary-foreground rounded-lg">
                Sign in
              </Link>
              <Link href={`/signup?next=${encodeURIComponent(here)}`} className="inline-flex h-11 items-center border border-link/40 px-5 text-[13px] font-medium text-link rounded-lg">
                Request access
              </Link>
            </>
          )}
          {opening.state !== "signin" && (
            <Link href="/" className="inline-flex h-11 items-center border border-link/40 px-5 text-[13px] font-medium text-link rounded-lg">
              Return
            </Link>
          )}
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}
