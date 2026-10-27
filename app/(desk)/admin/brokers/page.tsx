import Link from "next/link";
import { saveBrokerFeeOverride, setBrokerStatus } from "@/actions/broker";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { bpsToPercent } from "@/lib/money";
import { q } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Brokers" };

export default async function AdminBrokersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole(["ADMIN"]);
  const params = await searchParams;
  const brokers = await prisma.user.findMany({
    where: { role: "BROKER" },
    include: { brokerProfile: true, _count: { select: { brokeredListings: true, referrals: true } } },
    orderBy: { createdAt: "desc" },
  });
  return (
    <div>
      <PageIntro
        eyebrow="Brokers"
        title="Seats that bring paper."
        lede="Approve a broker before they can file or take a referral. A fee override replaces the desk default for that seat only. The default lives on the fee schedule."
      />
      <div className="mt-4 flex flex-wrap gap-4 text-[13px] font-medium">
        <Link href="/admin/payouts" className="text-link">Payout queue</Link>
        <Link href="/admin/settings" className="text-link">Fee schedule</Link>
      </div>
      <div className="mt-4">
        <Notice notice={q(params, "notice")} error={q(params, "error")} />
      </div>
      <ul className="mt-6 space-y-4">
        {brokers.length === 0 && <li className="text-sm text-muted-foreground">No broker seats yet.</li>}
        {brokers.map((broker) => {
          const profile = broker.brokerProfile;
          const brokerValue = profile?.brokerFeeBasis === "FLAT"
            ? ((profile.brokerFeeCents || 0) / 100).toFixed(2)
            : profile?.brokerFeeBasis === "PERCENT"
              ? String(bpsToPercent(profile.brokerFeeBps || 0))
              : "";
          const affiliateValue = profile?.affiliateFeeBasis === "FLAT"
            ? ((profile.affiliateFeeCents || 0) / 100).toFixed(2)
            : profile?.affiliateFeeBasis === "PERCENT"
              ? String(bpsToPercent(profile.affiliateFeeBps || 0))
              : "";
          return (
            <li key={broker.id} className="glass p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold tracking-tight text-3xl text-foreground">{broker.name}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{profile?.company || "No company yet"} · {broker.email}</p>
                  <p className="mt-2 text-sm text-foreground/80">
                    {profile?.licenseType || "No license type"}{profile?.licenseNumber ? ` · ${profile.licenseNumber}` : " · license optional"}
                    {" · "}{profile?.states || "No states"}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {broker._count.brokeredListings} files · {broker._count.referrals} introductions · W-9 {profile?.w9Name ? "on file" : "missing"}
                    {profile?.payoutNote ? ` · ${profile.payoutNote}` : ""}
                  </p>
                </div>
                <p className="text-[13px] font-medium text-link">{broker.accountStatus.toLowerCase()}</p>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {(["APPROVED", "PENDING", "REJECTED"] as const).filter((status) => status !== broker.accountStatus).map((status) => (
                  <form key={status} action={setBrokerStatus}>
                    <input type="hidden" name="userId" value={broker.id} />
                    <input type="hidden" name="status" value={status} />
                    <SubmitButton className="h-10 text-[13px] font-medium" variant={status === "APPROVED" ? "default" : "outline"}>
                      {status === "APPROVED" ? "Approve" : status === "PENDING" ? "Hold" : "Decline"}
                    </SubmitButton>
                  </form>
                ))}
                {broker.accountStatus === "APPROVED" && broker.referralCode && (
                  <Link href={`/brokers/${broker.referralCode}`} className="inline-flex h-10 items-center px-3 text-[13px] font-medium text-link">Public page</Link>
                )}
              </div>
              {profile && (
                <form action={saveBrokerFeeOverride} className="mt-5 grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
                  <input type="hidden" name="userId" value={broker.id} />
                  <FeeField label="Broker fee override" basisName="brokerFeeBasis" valueName="brokerFeeValue" basis={profile.brokerFeeBasis || ""} value={brokerValue} />
                  <FeeField label="Affiliate fee override" basisName="affiliateFeeBasis" valueName="affiliateFeeValue" basis={profile.affiliateFeeBasis || ""} value={affiliateValue} />
                  <div className="sm:col-span-2">
                    <SubmitButton className="h-10 text-[13px] font-medium">Save override</SubmitButton>
                  </div>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FeeField({ label, basisName, valueName, basis, value }: { label: string; basisName: string; valueName: string; basis: string; value: string }) {
  return (
    <fieldset>
      <legend className="text-[13px] text-muted-foreground">{label}</legend>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <select name={basisName} defaultValue={basis} className="desk-input" aria-label={`${label} basis`}>
          <option value="">Desk default</option>
          <option value="PERCENT">Percent</option>
          <option value="FLAT">Flat dollars</option>
        </select>
        <input name={valueName} defaultValue={value} className="desk-input" aria-label={`${label} amount`} placeholder="Amount" />
      </div>
    </fieldset>
  );
}
