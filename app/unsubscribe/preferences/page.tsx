import { savePreferences, stopEverything } from "@/actions/unsubscribe";
import { Logo } from "@/components/logo";
import { SubmitButton } from "@/components/submit-button";
import { maskEmail } from "@/lib/announcements";
import { q } from "@/lib/format";
import { mailingsFor, preferenceAddress } from "@/lib/unsubscribe";

export const metadata = { title: "Email preferences", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

// Public, so it works from any inbox without signing in. The signed link opens one address's mailings: the page shows
// that address, masked in case the link was forwarded, and the names of the lists it gets, and nothing else about the
// account. Opening it changes nothing; only the buttons do.
export default async function PreferencesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const token = q(params, "token");
  const email = await preferenceAddress(token);
  const mailings = email ? await mailingsFor(email) : [];
  const done = q(params, "done");
  return (
    <main id="desk" className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-[460px]">
        <Logo />
        <p className="eyebrow mt-6">Email preferences</p>
        {!email ? (
          <>
            <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-foreground">This link doesn&apos;t work.</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              It may be cut short or changed, or the account now uses another address. Use the unsubscribe link in a recent email again.
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-foreground">Mail to {maskEmail(email)}</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Choose what UPB sends to this address. Mail about your bids, closings and account still comes, since it is about deals you are in.
            </p>
            {done === "saved" && <p role="status" className="mt-4 rounded-xl border border-link/25 bg-link/5 px-4 py-3 text-sm text-foreground">Saved.</p>}
            {done === "stopped" && <p role="status" className="mt-4 rounded-xl border border-link/25 bg-link/5 px-4 py-3 text-sm text-foreground">Everything below is off.</p>}
            {mailings.length === 0 ? (
              <p className="mt-5 text-sm leading-relaxed text-muted-foreground">This address gets none of UPB&apos;s mailings.</p>
            ) : (
              <>
                <form action={savePreferences} className="glass mt-5 space-y-4 p-5">
                  <input type="hidden" name="token" value={token} />
                  <fieldset className="space-y-3">
                    <legend className="sr-only">Mailings</legend>
                    {mailings.map((mailing) => (
                      <label key={mailing.key} className="flex items-start gap-3 text-sm text-foreground">
                        <input type="checkbox" name="on" value={mailing.key} defaultChecked={mailing.on} className="mt-1" />
                        <span>{mailing.label}</span>
                      </label>
                    ))}
                  </fieldset>
                  <SubmitButton className="h-11 px-5 text-[13px] font-medium" pendingLabel="Saving…">Save</SubmitButton>
                </form>
                <form action={stopEverything} className="mt-4">
                  <input type="hidden" name="token" value={token} />
                  <SubmitButton variant="outline" className="h-11 px-5 text-[13px] font-medium" pendingLabel="Stopping…">Stop everything</SubmitButton>
                </form>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
