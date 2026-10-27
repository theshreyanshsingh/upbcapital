import { startVendorKyc, submitVerification } from "@/actions/verification";
import { kycMode } from "@/lib/vendors";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { requireUser } from "@/lib/auth";
import { q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { ACCREDITATION_TEXT } from "@/lib/verification";
import { redirect } from "next/navigation";

export const metadata = { title: "Verification" };

const ENTITIES = [
  ["INDIVIDUAL", "Individual"],
  ["LLC", "Limited liability company"],
  ["TRUST", "Trust"],
  ["FUND", "Fund"],
  ["OTHER", "Other entity"],
] as const;

export default async function VerificationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  if (user.role !== "BUYER") redirect("/");
  const params = await searchParams;
  const profile = await prisma.buyerProfile.findUnique({ where: { userId: user.id } });
  return (
    <div className="max-w-2xl">
      <PageIntro
        eyebrow="Buyer file"
        title="Who is bidding."
        lede="Offers wait until the desk has an entity, a proof-of-funds file, and an accredited-investor certification. Account approval and this file are separate."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      {kycMode() !== "mock" && (
        <form action={startVendorKyc} className="mt-6 border border-border p-5 rounded-xl">
          <p className="eyebrow">Vendor file</p>
          <p className="mt-2 text-sm text-muted-foreground">Open {kycMode() === "persona" ? "Persona" : "Parallel Markets"} for identity or accreditation. The desk form below still accepts a proof file.</p>
          <SubmitButton className="mt-4 h-11 text-[13px] font-medium">Continue with {kycMode() === "persona" ? "Persona" : "Parallel"}</SubmitButton>
        </form>
      )}
      {profile && (
        <p className="mt-4 text-sm text-foreground">
          Status: {profile.status.replaceAll("_", " ").toLowerCase()}
          {profile.reviewerNote ? ` · ${profile.reviewerNote}` : ""}
        </p>
      )}
      {profile?.proofKey && (
        <a className="mt-3 inline-block text-sm text-link" href={`/api/verification/${user.id}`}>
          Download proof on file
        </a>
      )}
      <form action={submitVerification} className="mt-8 space-y-5 glass p-6">
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Entity</span>
          <select name="entityType" defaultValue={profile?.entityType || "INDIVIDUAL"} className="desk-input mt-2">
            {ENTITIES.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Legal name</span>
          <Input name="entityName" defaultValue={profile?.entityName} className="mt-2 h-11 bg-card" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Formed in</span>
          <Input name="jurisdiction" defaultValue={profile?.jurisdiction} placeholder="Florida" className="mt-2 h-11 bg-card" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Proof of funds</span>
          <input name="proof" type="file" className="mt-2 block text-sm text-muted-foreground" />
        </label>
        <label className="flex items-start gap-3 text-sm leading-relaxed text-muted-foreground">
          <input type="checkbox" name="accredited" value="yes" defaultChecked={profile?.accredited} className="mt-1" />
          <span>{ACCREDITATION_TEXT}</span>
        </label>
        <SubmitButton className="h-11 text-[13px] font-medium" pendingLabel="Sending…">
          Submit to the desk
        </SubmitButton>
      </form>
    </div>
  );
}
