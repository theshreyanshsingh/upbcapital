import Link from "next/link";
import { headers } from "next/headers";
import QRCode from "qrcode";
import { EarningsChart } from "@/components/broker-chart";
import { ReferralKit } from "@/components/broker-share";
import { requireRole } from "@/lib/auth";
import { brokerGate, brokerRoleLabel, feeMonths, portraitSrc } from "@/lib/broker-fees";
import { money, num } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

export const metadata = { title: "Broker desk" };

export default async function BrokerHome() {
  const user = await requireRole(["BROKER"]);
  const profile = await prisma.brokerProfile.findUnique({ where: { userId: user.id } });
  const next = brokerGate({ accountStatus: user.accountStatus, profile });
  if (next) redirect(next);

  const [listings, fees, buyers] = await Promise.all([
    prisma.listing.findMany({
      where: { brokerId: user.id },
      include: { notes: true },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.brokerFee.findMany({
      where: { brokerId: user.id },
      include: { closing: { include: { listing: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.user.findMany({ where: { referredById: user.id }, orderBy: { createdAt: "desc" } }),
  ]);

  const earned = fees.reduce((sum, fee) => sum + fee.amountCents, 0);
  const pending = fees.filter((fee) => fee.status === "OWED").reduce((sum, fee) => sum + fee.amountCents, 0);
  const paid = fees.filter((fee) => fee.status === "PAID").reduce((sum, fee) => sum + fee.amountCents, 0);
  const open = listings.filter((listing) => listing.status !== "SOLD" && listing.status !== "REJECTED");
  const pipeline = open.reduce((sum, listing) => sum + listing.notes.reduce((inner, note) => inner + num(note.askingPrice), 0), 0);
  const months = feeMonths(fees.map((fee) => ({ at: fee.createdAt, amountCents: fee.amountCents, status: fee.status })));
  const approved = user.accountStatus === "APPROVED";
  const headerStore = await headers();
  const proto = headerStore.get("x-forwarded-proto") || "http";
  const host = headerStore.get("host");
  const origin = host ? `${proto}://${host}` : "";
  const code = user.referralCode || "";
  const url = code ? `${origin}/signup?ref=${code}` : "";
  const svg = url
    ? (await QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#111111", light: "#ffffff" }, width: 180 })).replace(/<\?xml[^>]*>/, "")
    : "";
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const columns = [
    { id: "review", label: "With the desk", hint: "Filed, not live yet.", statuses: ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED"] },
    { id: "live", label: "On the book", hint: "Buyers can open it.", statuses: ["APPROVED"] },
    { id: "contract", label: "In contract", hint: "A price is accepted.", statuses: ["PENDING"] },
    { id: "closed", label: "Closed", hint: "The fee is on the books.", statuses: ["SOLD"] },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Broker desk</p>
          <h1 className="rise mt-3 font-semibold tracking-tight text-3xl text-foreground">{greeting}, {user.name.split(" ")[0]}.</h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
            {profile?.company ? `${profile.company}. ` : ""}
            Fees are a share of the desk’s premium and commission, posted when a file closes.
          </p>
        </div>
        <Link href="/broker/deals/new" className="inline-flex min-h-12 items-center bg-primary px-5 text-[13px] font-medium text-primary-foreground rounded-lg">
          File a deal
        </Link>
      </div>

      {!approved && (
        <section className="rise mt-8 border border-link/40 bg-link/10 p-5 md:p-6 rounded-xl">
          <p className="eyebrow">In review</p>
          <p className="mt-2 font-semibold tracking-tight text-3xl text-foreground">The desk has your seat.</p>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
            You can finish the profile. Deals and the referral link wait until the seat is approved. The welcome is the first thing you will see after that.
          </p>
          {!profile?.w9Key && <p className="mt-3 text-sm text-foreground">Add a W-9 before the first deal. The public page stays down until approval.</p>}
        </section>
      )}

      <section className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <FeeCard k="Earned" v={money(earned / 100)} hint="Paid and still owed." delay="" />
        <FeeCard k="Pending" v={money(pending / 100)} hint="Owed, not sent." delay="rise-1" />
        <FeeCard k="Paid" v={money(paid / 100)} hint="Marked paid by the desk." delay="rise-2" />
        <FeeCard k="Pipeline" v={money(pipeline)} hint={`${open.length} open file${open.length === 1 ? "" : "s"}.`} delay="rise-3" />
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,0.7fr)]">
        <div className="glass p-5 md:p-6">
          <div className="flex items-baseline justify-between gap-3">
            <p className="eyebrow">Earnings</p>
            <a href="/api/broker/statement" className="text-[13px] font-medium text-link">Download statement</a>
          </div>
          <div className="mt-4">
            <EarningsChart months={months} />
          </div>
        </div>
        <div className="glass p-5 md:p-6">
          <p className="eyebrow">Introductions</p>
          {approved && url ? (
            <>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">A buyer who signs up with this link is yours. The referral fee posts at their close, unless you are already the broker on that file.</p>
              <div className="mt-5">
                <ReferralKit url={url} code={code} svg={svg} />
              </div>
              <Link href={`/brokers/${code}`} className="mt-4 inline-block text-[13px] font-medium text-link">Public profile</Link>
            </>
          ) : (
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">The link and the code appear when the desk approves you. Until then an introduction is not tied to this seat.</p>
          )}
        </div>
      </section>

      <section className="mt-10">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="eyebrow">Pipeline</p>
            <h2 className="mt-2 font-semibold tracking-tight text-lg text-foreground">Where each file sits.</h2>
          </div>
        </div>
        <div className="mt-5 flex snap-x gap-3 overflow-x-auto pb-2 md:grid md:grid-cols-4 md:overflow-visible">
          {columns.map((column) => {
            const cards = listings.filter((listing) => column.statuses.includes(listing.status));
            return (
              <div key={column.id} className="w-[78vw] shrink-0 snap-start border border-border bg-card p-3 sm:w-72 md:w-auto rounded-xl">
                <p className="text-[13px] font-medium text-link">{column.label}</p>
                <p className="mt-1 text-xs text-muted-foreground">{column.hint}</p>
                <ul className="mt-4 space-y-3">
                  {cards.length === 0 && <li className="border border-dashed border-border px-3 py-6 text-sm text-muted-foreground rounded-xl">Nothing in this column.</li>}
                  {cards.map((listing) => {
                    const ask = listing.notes.reduce((sum, note) => sum + num(note.askingPrice), 0);
                    return (
                      <li key={listing.id}>
                        <Link href={`/broker/deals/${listing.id}`} className="block border border-border bg-card/60 p-4 transition hover:border-link/50 rounded-xl">
                          <p className="text-xs font-medium text-link">{brokerRoleLabel(listing.brokerRole)}</p>
                          <p className="mt-2 font-semibold tracking-tight text-2xl leading-tight text-foreground">{listing.title}</p>
                          <p className="mt-2 text-sm text-muted-foreground">{listing.clientSellerName}</p>
                          <p className="mt-3 font-semibold tracking-tight text-xl text-foreground">{money(ask)}</p>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mt-10 grid gap-4 lg:grid-cols-2">
        <div className="glass p-5 md:p-6">
          <p className="eyebrow">Referred buyers</p>
          <ul className="mt-4 divide-y divide-border">
            {buyers.length === 0 && <li className="py-6 text-sm text-muted-foreground">No buyer has used your code yet. The QR is the shortest way to hand it over.</li>}
            {buyers.map((buyer) => (
              <li key={buyer.id} className="flex items-baseline justify-between gap-3 py-3">
                <div>
                  <p className="text-foreground">{buyer.name}</p>
                  <p className="text-xs text-muted-foreground">{buyer.email}</p>
                </div>
                <p className="text-[13px] font-medium text-link">{buyer.accountStatus.toLowerCase()}</p>
              </li>
            ))}
          </ul>
        </div>
        <div className="glass p-5 md:p-6">
          <div className="flex items-center gap-4">
            <Portrait userId={user.id} name={user.name} portraitKey={profile?.portraitKey || ""} />
            <div>
              <p className="eyebrow">Profile</p>
              <p className="mt-1 font-semibold tracking-tight text-3xl text-foreground">{profile?.company}</p>
              <p className="mt-1 text-sm text-muted-foreground">{profile?.states}</p>
            </div>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{profile?.bio || "Add a short bio so the public page has something to say."}</p>
          <div className="mt-4 flex flex-wrap gap-4 text-[13px] font-medium">
            <Link href="/broker/profile" className="text-link">Edit profile</Link>
            {profile?.w9Name ? <span className="text-muted-foreground">W-9 · {profile.w9Name}</span> : <Link href="/broker/onboarding" className="text-link">Add a W-9</Link>}
          </div>
        </div>
      </section>
    </div>
  );
}

function FeeCard({ k, v, hint, delay }: { k: string; v: string; hint: string; delay: string }) {
  return (
    <div className={`glass rise p-5 ${delay}`}>
      <p className="eyebrow">{k}</p>
      <p className="mt-3 font-semibold tracking-tight text-3xl text-foreground">{v}</p>
      <p className="mt-2 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function Portrait({ userId, name, portraitKey }: { userId: string; name: string; portraitKey: string }) {
  const src = portraitSrc(userId, portraitKey);
  if (!src) {
    return <div className="grid size-16 place-items-center border border-link/40 font-semibold tracking-tight text-2xl text-link rounded-lg">{name.split(" ").map((part) => part[0]).slice(0, 2).join("")}</div>;
  }
  return (
    // Portraits are same-origin files or an API route.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" className="size-16 object-cover" />
  );
}
