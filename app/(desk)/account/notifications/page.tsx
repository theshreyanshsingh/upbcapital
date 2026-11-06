import Link from "next/link";
import { saveNotificationPrefs } from "@/actions/prefs";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { PushControl } from "@/components/pwa";
import { SubmitButton } from "@/components/submit-button";
import { requireUser } from "@/lib/auth";
import { q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { pushPublicKey } from "@/lib/push";

export const metadata = { title: "Notices" };

export default async function NotificationPrefsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const [prefs, devices] = await Promise.all([
    prisma.user.findUnique({
      where: { id: user.id },
      select: { notifyEmail: true, notifyInApp: true, digest: true, dealAlerts: true, marketDispatch: true, role: true },
    }),
    prisma.pushSubscription.count({ where: { userId: user.id } }),
  ]);
  return (
    <div className="max-w-xl">
      <PageIntro
        eyebrow="Notices"
        title="How the desk reaches you."
        lede="Email and the in-app list can be turned off separately. Buyers with a buy box can take a daily or weekly digest of new matches. The desk sends that digest from analytics."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <form action={saveNotificationPrefs} className="glass mt-8 space-y-5 p-6">
        <label className="flex items-center gap-3 text-sm text-foreground">
          <input type="checkbox" name="notifyEmail" value="on" defaultChecked={prefs?.notifyEmail ?? true} />
          Email
        </label>
        <label className="flex items-center gap-3 text-sm text-foreground">
          <input type="checkbox" name="notifyInApp" value="on" defaultChecked={prefs?.notifyInApp ?? true} />
          In-app notices
        </label>
        {prefs?.role === "BUYER" && (
          <label className="flex items-start gap-3 text-sm text-foreground">
            <input type="checkbox" name="dealAlerts" value="on" defaultChecked={prefs.dealAlerts !== false} className="mt-1" />
            <span>Desk picks: listings and bid deadlines the desk sends you because they fit a buy box</span>
          </label>
        )}
        <div>
          <label className="flex items-start gap-3 text-sm text-foreground">
            <input type="checkbox" name="marketDispatch" value="on" defaultChecked={prefs?.marketDispatch === true} className="mt-1" />
            <span>
              Monthly market dispatch: agency and HUD sale results, what closed on UPB and what is on the book, on the first of each month
              <span className="mt-1 block text-xs text-muted-foreground">Market data, not advice. It follows the email setting above.</span>
            </span>
          </label>
          <Link href="/market" className="ml-7 mt-1 inline-block text-xs font-medium text-link">Read this month&apos;s issue</Link>
        </div>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Match digest</span>
          <select name="digest" defaultValue={prefs?.digest || "WEEKLY"} className="desk-input mt-2" aria-label="Digest frequency">
            <option value="WEEKLY">Weekly</option>
            <option value="DAILY">Daily</option>
            <option value="OFF">Off</option>
          </select>
        </label>
        <SubmitButton className="h-11 text-[13px] font-medium">Save preferences</SubmitButton>
      </form>
      <section aria-labelledby="push-heading" className="glass mt-6 space-y-3 p-6">
        <h2 id="push-heading" className="text-[15px] font-semibold tracking-tight text-foreground">Push notices</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Push goes to this device only, so turn it on in each browser or phone where you want it. The lock screen shows what happened, such as
          &ldquo;Offer accepted&rdquo;, and never a name, address or amount. Sign-in codes are never pushed.
        </p>
        <PushControl publicKey={pushPublicKey()} devices={devices} />
      </section>
    </div>
  );
}
