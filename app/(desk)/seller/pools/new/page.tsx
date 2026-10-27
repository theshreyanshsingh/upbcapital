import { PageIntro } from "@/components/page-intro";
import { TapeWizard } from "@/components/tape-wizard";
import { requireRole } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { redirect } from "next/navigation";

export const metadata = { title: "Upload a tape" };

export default async function NewPoolPage() {
  const user = await requireRole(["INSTITUTIONAL_SELLER", "ADMIN"]);
  if (user.role === "INSTITUTIONAL_SELLER" && user.accountStatus !== "APPROVED") {
    redirect("/seller?error=Your institutional account is still in review.");
  }
  const settings = await getSettings();
  return (
    <div>
      <PageIntro
        eyebrow="Institutional tape"
        title="Bring the whole pool."
        lede="Upload a CSV or Excel tape, map the columns, and send the pool to review. The template includes three fictional loans you can use to try the mapper."
      />
      <TapeWizard premiumBps={settings.buyerPremiumBps} commissionBps={settings.sellerCommissionBps} />
    </div>
  );
}
