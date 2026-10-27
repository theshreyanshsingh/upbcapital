import { redirect } from "next/navigation";
import { markBrokerWelcomed } from "@/actions/broker";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Welcome" };

export default async function BrokerWelcomePage() {
  const user = await requireRole(["BROKER"]);
  const profile = await prisma.brokerProfile.findUnique({ where: { userId: user.id } });
  if (!profile?.company || !profile.states) redirect("/broker/onboarding");
  if (user.accountStatus !== "APPROVED") redirect("/broker");
  if (profile.welcomedAt) redirect("/broker");
  const first = user.name.split(" ")[0];
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-xl flex-col justify-center py-8">
      <p className="eyebrow">The seat is open</p>
      <div className="draw-line mt-6 h-px w-24 bg-primary rounded-lg" />
      <h1 className="rise mt-6 font-semibold tracking-tight text-[28px] leading-none text-foreground">{first}.</h1>
      <p className="rise rise-1 mt-6 text-base leading-relaxed text-muted-foreground">
        The desk approved {profile.company}. You can file a note or a tape for a seller, and a buyer who uses your code is tied to you.
      </p>
      <ul className="rise rise-2 mt-8 space-y-3 text-sm text-foreground/90">
        <li>Fees are a share of the premium and the commission, or a flat amount the desk sets for you.</li>
        <li>They post when a file closes, and they stay owed until the desk marks them paid.</li>
        <li>If you are the buyer or the seller on that trade, the fee is withheld.</li>
      </ul>
      <form action={markBrokerWelcomed} className="rise rise-3 mt-10">
        <button type="submit" className="min-h-12 w-full bg-primary px-6 text-[13px] font-medium text-primary-foreground sm:w-auto rounded-lg">
          Open my desk
        </button>
      </form>
    </div>
  );
}
