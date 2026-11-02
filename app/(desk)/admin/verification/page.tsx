import { reviewVerification } from "@/actions/verification";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { isoDate, money, prettyDate, q } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Verification" };

export default async function AdminVerificationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole(["ADMIN"]);
  const params = await searchParams;
  const profiles = await prisma.buyerProfile.findMany({ include: { user: true }, orderBy: { updatedAt: "desc" } });
  return (
    <div>
      <PageIntro eyebrow="Buyer files" title="Accreditation and proof of funds." lede="An approved account can browse. An approved file can offer." />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <ul className="mt-8 space-y-4">
        {profiles.length === 0 && <li className="text-sm text-muted-foreground">No buyer files yet.</li>}
        {profiles.map((profile) => (
          <li key={profile.userId} className="glass p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <p className="font-semibold tracking-tight text-3xl text-foreground">{profile.entityName || profile.user.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {profile.user.email} · {profile.entityType.toLowerCase()} · {profile.jurisdiction} · {profile.accredited ? "self-certified accredited" : "not certified"}
                </p>
              </div>
              <p className="text-[13px] font-medium text-link">{profile.status.replaceAll("_", " ").toLowerCase()}</p>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Submitted {prettyDate(profile.submittedAt)}</p>
            <p className="mt-1 text-sm text-foreground">
              {profile.proofVerifiedAt && profile.proofAmount != null
                ? `Verified funds ${money(profile.proofAmount)} through ${prettyDate(profile.proofExpiresAt)}${profile.proofExpiresAt && profile.proofExpiresAt.getTime() < Date.now() ? " · expired" : ""}`
                : profile.proofAmount != null
                  ? `Buyer states ${money(profile.proofAmount)} · not verified yet`
                  : "No funds amount stated"}
            </p>
            {profile.proofKey && (
              <a className="mt-3 inline-block text-sm text-link" href={`/api/verification/${profile.userId}`}>Download proof</a>
            )}
            <form action={reviewVerification} className="mt-4 space-y-3">
              <input type="hidden" name="userId" value={profile.userId} />
              <input name="reviewerNote" placeholder="Note to the buyer" className="desk-input" />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="text-[13px] text-muted-foreground">Funds the proof supports</span>
                  <input name="proofAmount" inputMode="decimal" defaultValue={profile.proofAmount ?? ""} className="desk-input mt-2" aria-label="Verified funds amount" />
                </label>
                <label className="block">
                  <span className="text-[13px] text-muted-foreground">Good through</span>
                  <input name="proofExpiresAt" type="date" defaultValue={isoDate(profile.proofExpiresAt) ?? ""} className="desk-input mt-2" aria-label="Proof of funds expiry" />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">Needed to approve. With no date, the proof is good for 90 days. Bids whose all-in runs above it are flagged on the bid sheet.</p>
              <div className="flex flex-wrap gap-2">
                <button type="submit" name="decision" value="APPROVED" className="h-9 bg-primary px-3 text-[13px] font-medium text-primary-foreground rounded-lg">Approve</button>
                <button type="submit" name="decision" value="CHANGES_REQUESTED" className="h-9 border border-border px-3 text-[13px] font-medium text-foreground rounded-lg">Request changes</button>
                <button type="submit" name="decision" value="REJECTED" className="h-9 px-3 text-[13px] font-medium text-bad">Decline</button>
              </div>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
