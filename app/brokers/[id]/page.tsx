import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Logo } from "@/components/logo";
import { getCurrentUser } from "@/lib/auth";
import { brokerRoleLabel, portraitSrc, splitStates } from "@/lib/broker-fees";
import { money, num } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const broker = await findBroker(id);
  if (!broker) return { title: "Broker" };
  return { title: `${broker.name} · ${broker.brokerProfile?.company || "Broker"}`, description: broker.brokerProfile?.bio || undefined };
}

async function findBroker(id: string) {
  return prisma.user.findFirst({
    where: {
      role: "BROKER",
      accountStatus: "APPROVED",
      OR: [{ id }, { referralCode: id.toUpperCase() }],
    },
    include: {
      brokerProfile: true,
      brokeredListings: {
        where: { status: "SOLD" },
        include: { notes: { select: { city: true, state: true, askingPrice: true } } },
        orderBy: { soldAt: "desc" },
      },
    },
  });
}

export default async function PublicBrokerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const broker = await findBroker(id);
  if (!broker?.brokerProfile) notFound();
  const profile = broker.brokerProfile;
  const viewer = await getCurrentUser();
  const volume = broker.brokeredListings.reduce((sum, listing) => sum + Number(listing.salePrice || 0), 0);
  const states = splitStates(profile.states);
  const src = portraitSrc(broker.id, profile.portraitKey);
  const cities = broker.brokeredListings
    .map((listing) => listing.notes[0]?.city)
    .filter((city): city is string => Boolean(city))
    .slice(0, 4);

  return (
    <main id="desk" className="mx-auto max-w-5xl px-5 py-8 md:py-16">
      <Logo />
      <div className="mt-10 grid items-start gap-8 md:mt-16 md:grid-cols-[minmax(0,280px)_minmax(0,1fr)] md:gap-14">
        <div className="rise mx-auto w-full max-w-xs md:mx-0">
          <div className="aspect-[3/4] overflow-hidden border border-link/35 bg-card rounded-xl">
            {src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={src} alt={`Portrait of ${broker.name}`} className="h-full w-full object-cover" />
            ) : (
              <div className="grid h-full place-items-center font-semibold tracking-tight text-7xl text-link">{initials(broker.name)}</div>
            )}
          </div>
        </div>
        <div>
          <p className="eyebrow">{profile.company}</p>
          <h1 className="rise mt-3 font-semibold tracking-tight text-5xl leading-none text-foreground sm:text-6xl md:text-7xl">{broker.name}</h1>
          <div className="draw-line mt-6 h-px w-24 bg-primary rounded-lg" />
          {profile.licenseType || profile.licenseNumber ? (
            <p className="mt-6 inline-flex border border-link/50 px-3 py-2 text-[13px] font-medium text-foreground rounded-xl">
              {[profile.licenseType, profile.licenseNumber].filter(Boolean).join(" · ")}
            </p>
          ) : (
            <p className="mt-6 inline-flex border border-border px-3 py-2 text-[13px] font-medium text-muted-foreground rounded-xl">Referring affiliate</p>
          )}
          <p className="mt-6 max-w-xl text-base leading-relaxed text-foreground/85">{profile.bio || `${broker.name} brings mortgage notes to the UPB Capital desk.`}</p>
          <div className="mt-6 flex flex-wrap gap-2">
            {states.map((state) => (
              <span key={state} className="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground">{state}</span>
            ))}
          </div>
          <dl className="mt-8 grid grid-cols-2 gap-3 sm:max-w-md">
            <div className="border border-border p-4 rounded-xl">
              <dt className="text-xs font-medium text-muted-foreground">Deals closed</dt>
              <dd className="mt-2 font-semibold tracking-tight text-4xl text-foreground">{broker.brokeredListings.length}</dd>
            </div>
            <div className="border border-border p-4 rounded-xl">
              <dt className="text-xs font-medium text-muted-foreground">Closed volume</dt>
              <dd className="mt-2 font-semibold tracking-tight text-4xl text-foreground">{money(volume)}</dd>
            </div>
          </dl>
          {cities.length > 0 && (
            <p className="mt-4 text-sm text-muted-foreground">Recent closes in {cities.join(", ")}.</p>
          )}
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href={`/signup?ref=${broker.referralCode || ""}`} className="inline-flex min-h-12 items-center justify-center bg-primary px-5 text-[13px] font-medium text-primary-foreground rounded-lg">
              Open a buyer seat
            </Link>
            {viewer?.id === broker.id && (
              <Link href="/broker/profile" className="inline-flex min-h-12 items-center justify-center border border-border px-5 text-[13px] font-medium text-foreground rounded-lg">
                Edit profile
              </Link>
            )}
          </div>
        </div>
      </div>
      {broker.brokeredListings.length > 0 && (
        <section className="mt-14 md:mt-20">
          <p className="eyebrow">Closed with the desk</p>
          <ul className="mt-4 divide-y divide-border border-y border-border">
            {broker.brokeredListings.map((listing) => (
              <li key={listing.id} className="flex flex-wrap items-baseline justify-between gap-2 py-4">
                <div>
                  <p className="font-semibold tracking-tight text-2xl text-foreground">{listing.notes[0]?.city || listing.title}{listing.notes[0]?.state ? `, ${listing.notes[0].state}` : ""}</p>
                  <p className="text-xs font-medium text-muted-foreground">{brokerRoleLabel(listing.brokerRole)}</p>
                </div>
                <p className="font-semibold tracking-tight text-2xl text-foreground">{money(Number(listing.salePrice || listing.notes.reduce((sum, note) => sum + num(note.askingPrice), 0)))}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="mt-16 text-[13px] font-medium text-muted-foreground">UPB Capital · a private note desk</p>
    </main>
  );
}

function initials(name: string) {
  return name.split(" ").map((part) => part[0]).slice(0, 2).join("").toUpperCase();
}
