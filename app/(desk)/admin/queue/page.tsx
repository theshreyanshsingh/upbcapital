import Link from "next/link";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { StatusPill } from "@/components/status-pill";
import { requireRole } from "@/lib/auth";
import { q } from "@/lib/format";
import { prisma } from "@/lib/prisma";

const TABS = [
  { id: "review", label: "Needs the desk", statuses: ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED"] },
  { id: "live", label: "Live", statuses: ["APPROVED"] },
  { id: "contract", label: "In contract", statuses: ["PENDING"] },
  { id: "sold", label: "Sold", statuses: ["SOLD"] },
  { id: "declined", label: "Declined", statuses: ["REJECTED"] },
] as const;

export const metadata = { title: "Review queue" };

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole(["ADMIN"]);
  const params = await searchParams;
  const tab = TABS.find((item) => item.id === q(params, "tab")) ?? TABS[0];
  const listings = await prisma.listing.findMany({
    where: { status: { in: [...tab.statuses] } },
    include: { seller: true, broker: true, notes: true, inquiries: true, _count: { select: { matches: true } } },
    orderBy: { updatedAt: "desc" },
  });
  return (
    <div>
      <PageIntro eyebrow="Review" title="The queue." lede="Nothing reaches buyers until the desk releases it." />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <div className="mt-6 flex flex-wrap gap-2">
        {TABS.map((item) => (
          <Link key={item.id} href={`/admin/queue?tab=${item.id}`} className={`border px-3 py-2 text-[13px] font-medium ${item.id === tab.id ? "border-link text-link" : "border-border text-muted-foreground"}`}>
            {item.label}
          </Link>
        ))}
      </div>
      <ul className="mt-6 divide-y divide-border border border-border rounded-xl">
        {listings.length === 0 && <li className="px-5 py-8 text-sm text-muted-foreground">Nothing in this column.</li>}
        {listings.map((listing) => (
          <li key={listing.id}>
            <Link href={`/admin/listings/${listing.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-5 hover:bg-muted/60">
              <div>
                <p className="font-semibold tracking-tight text-2xl text-foreground">{listing.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {listing.seller.companyName || listing.seller.name}
                  {listing.broker ? ` · via ${listing.broker.name}` : ""}
                  {" · "}{listing.kind === "POOL" ? `${listing.notes.length} loans` : listing.notes[0]?.city} · {listing.inquiries.length} inquiries · {listing._count.matches} buy-box matches
                </p>
              </div>
              <StatusPill status={listing.status} />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
