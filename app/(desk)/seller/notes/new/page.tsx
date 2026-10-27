import { NoteWizard } from "@/components/note-wizard";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { bpsToPercent } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "List a note" };

export default async function NewNotePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER", "ADMIN"]);
  const settings = await getSettings();
  const params = await searchParams;
  const leadId = typeof params.lead === "string" ? params.lead : "";
  const lead = leadId ? await prisma.sellerLead.findUnique({ where: { id: leadId } }) : null;
  const owned = lead && (lead.userId === user.id || lead.email.toLowerCase() === user.email.toLowerCase()) ? lead : null;
  return (
    <div>
      <PageIntro
        eyebrow="New note"
        title="File a single loan."
        lede={`At today's schedule the desk keeps ${bpsToPercent(settings.sellerCommissionBps).toFixed(2)}% of the accepted price. The price step shows your estimated net before you send it.`}
      />
      <NoteWizard
        mode="create"
        premiumBps={settings.buyerPremiumBps}
        commissionBps={settings.sellerCommissionBps}
        leadId={owned?.id}
        initial={owned ? {
          city: owned.city,
          state: owned.state,
          lienPosition: owned.lienPosition,
          paymentStatus: owned.paymentStatus,
          upb: String(Number(owned.upb)),
          estimatedValue: String(Number(owned.estimatedValue)),
          interestRate: String(Number(owned.interestRate)),
          monthlyPi: String(Number(owned.monthlyPi)),
          askingPrice: String(Number(owned.indicativeHigh)),
          narrative: owned.note,
        } : undefined}
      />
    </div>
  );
}
