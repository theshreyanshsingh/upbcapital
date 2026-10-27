import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Notice } from "@/components/notice";
import { requireRole } from "@/lib/auth";
import { brokerRoleLabel } from "@/lib/broker-fees";
import { money, num, prettyDate, q } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Deal" };

const TRACK = [
  { key: "filed", label: "Filed", detail: "The desk has the file and the authorization." },
  { key: "review", label: "Desk review", detail: "Nothing is live until this clears." },
  { key: "live", label: "On the book", detail: "Approved buyers can open it." },
  { key: "contract", label: "In contract", detail: "A price is accepted and a closing is open." },
  { key: "closed", label: "Closed", detail: "The fee is calculated and posted." },
] as const;

function stageIndex(status: string) {
  if (status === "SOLD") return 4;
  if (status === "PENDING") return 3;
  if (status === "APPROVED") return 2;
  if (status === "REJECTED") return 1;
  return 1;
}

export default async function BrokerDealPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["BROKER"]);
  const { id } = await params;
  const query = await searchParams;
  const listing = await prisma.listing.findUnique({
    where: { id },
    include: { notes: true, closings: { include: { brokerFees: true } } },
  });
  if (!listing || listing.brokerId !== user.id) notFound();
  const ask = listing.notes.reduce((sum, note) => sum + num(note.askingPrice), 0);
  const index = stageIndex(listing.status);
  const fees = listing.closings.flatMap((closing) => closing.brokerFees.filter((fee) => fee.brokerId === user.id));
  const declined = listing.status === "REJECTED";

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/broker" className="text-[13px] font-medium text-link">Back to the desk</Link>
      <div className="mt-6">
        <Notice notice={q(query, "notice")} error={q(query, "error")} />
      </div>
      <p className="eyebrow mt-6">{brokerRoleLabel(listing.brokerRole)}</p>
      <h1 className="mt-3 font-semibold tracking-tight text-3xl text-foreground">{listing.title}</h1>
      <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
        For {listing.clientSellerName}. {listing.clientRelationship}
      </p>
      <dl className="mt-6 grid gap-3 sm:grid-cols-3">
        <Stat k="Asking" v={money(ask)} />
        <Stat k="Loans" v={String(listing.notes.length)} />
        <Stat k="Filed" v={prettyDate(listing.submittedAt)} />
      </dl>
      {listing.summary && <p className="mt-6 text-sm leading-relaxed text-foreground/85">{listing.summary}</p>}

      <ol className="mt-10 space-y-0">
        {TRACK.map((step, stepIndex) => {
          const state = declined && stepIndex > 0 ? "wait" : stepIndex < index ? "done" : stepIndex === index ? "now" : "wait";
          return (
            <li key={step.key} className="grid grid-cols-[28px_minmax(0,1fr)] gap-4">
              <div className="flex flex-col items-center">
                <span className={`mt-1 size-3 rounded-full ${state === "wait" ? "bg-muted" : "bg-primary"} ${state === "now" ? "ring-4 ring-link/25" : ""}`} />
                {stepIndex < TRACK.length - 1 && <span className={`w-px flex-1 ${stepIndex < index ? "bg-link/70" : "bg-muted"}`} />}
              </div>
              <div className="pb-8">
                <p className={`font-semibold tracking-tight text-2xl ${state === "wait" ? "text-muted-foreground" : "text-foreground"}`}>{step.label}</p>
                <p className="mt-1 text-sm text-muted-foreground">{declined && stepIndex === 1 ? "The desk declined this file." : step.detail}</p>
              </div>
            </li>
          );
        })}
      </ol>

      <section className="glass p-5 md:p-6">
        <p className="eyebrow">Fee</p>
        {fees.length === 0 && <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Nothing is owed yet. The fee is calculated from the desk’s premium and commission when this file closes.</p>}
        <ul className="mt-3 space-y-3">
          {fees.map((fee) => (
            <li key={fee.id} className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-muted-foreground">{brokerRoleLabel(fee.role)} · {fee.status === "PAID" ? "Paid" : "Owed"}</span>
              <span className="font-semibold tracking-tight text-3xl text-foreground">{money(fee.amountCents / 100)}</span>
            </li>
          ))}
        </ul>
        {listing.authorizationName && <p className="mt-4 text-xs text-muted-foreground">Authorization on file · {listing.authorizationName}</p>}
      </section>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="border border-border px-4 py-3 rounded-xl">
      <dt className="text-xs font-medium text-muted-foreground">{k}</dt>
      <dd className="mt-1 font-semibold tracking-tight text-2xl text-foreground">{v}</dd>
    </div>
  );
}
