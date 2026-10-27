import { saveNotificationPrefs } from "@/actions/prefs";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireUser } from "@/lib/auth";
import { q } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Notices" };

export default async function NotificationPrefsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const prefs = await prisma.user.findUnique({
    where: { id: user.id },
    select: { notifyEmail: true, notifyInApp: true, digest: true },
  });
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
    </div>
  );
}
