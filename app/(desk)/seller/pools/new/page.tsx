import { PageIntro } from "@/components/page-intro";
import { TapeWizard } from "@/components/tape-wizard";
import { requireRole } from "@/lib/auth";
import { tapeProgram } from "@/lib/flow-programs";
import { q } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { redirect } from "next/navigation";

export const metadata = { title: "Upload a tape" };

export default async function NewPoolPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireRole(["INSTITUTIONAL_SELLER", "ADMIN"]);
  if (user.role === "INSTITUTIONAL_SELLER" && user.accountStatus !== "APPROVED") {
    redirect("/seller?error=Your institutional account is still in review.");
  }
  const settings = await getSettings();
  // A tape for a forward-flow programme, from its page. Only the seller's own open programme takes it.
  const flowId = q(await searchParams, "flow");
  const program = flowId ? await tapeProgram(user.id, flowId) : null;
  if (flowId && !program) redirect("/seller/flow?error=That programme isn't taking tranches.");
  return (
    <div>
      <PageIntro
        eyebrow="Institutional tape"
        title="Bring the whole pool."
        lede="Upload a CSV or Excel tape, map the columns, and send the pool to review. The template includes three fictional loans you can use to try the mapper."
      />
      {program && <p className="mb-6 max-w-2xl text-sm text-foreground">This tape becomes the next tranche of {program.name}. The confirm step flags loans outside its criteria.</p>}
      <TapeWizard premiumBps={settings.buyerPremiumBps} commissionBps={settings.sellerCommissionBps} flow={program ? { id: program.id, name: program.name } : undefined} />
    </div>
  );
}
