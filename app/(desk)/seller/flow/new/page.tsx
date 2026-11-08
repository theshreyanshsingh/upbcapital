import Link from "next/link";
import { FlowProgramForm } from "@/components/flow-program-form";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { CADENCES, FIRST_LOOK_HOURS } from "@/lib/flow-programs";

export const metadata = { title: "Start a programme" };

export default async function NewFlowProgramPage() {
  const user = await requireRole(["INSTITUTIONAL_SELLER"]);
  return (
    <div className="max-w-2xl">
      <PageIntro
        eyebrow="Forward flow"
        title="Start a programme."
        lede="Set the cadence, the loans the programme takes, how long committed buyers see each tranche first, and the terms they accept. It goes to the desk for approval when you send it."
      />
      {user.accountStatus !== "APPROVED" ? (
        <p className="text-sm text-foreground">
          Your institutional account is still in review. You can start a programme once the desk approves it. <Link href="/seller" className="text-link">Back to your desk</Link>.
        </p>
      ) : (
        <FlowProgramForm cadences={CADENCES} hours={FIRST_LOOK_HOURS} />
      )}
    </div>
  );
}
