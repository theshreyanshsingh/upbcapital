import type { Prisma } from "@prisma/client";
import Link from "next/link";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { money, prettyDate, q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { requireDesk } from "@/lib/staff";
import { VALUATION_STATUSES, statusLabel } from "@/lib/valuations";

export const metadata = { title: "Valuations" };

const FILTERS: { key: string; label: string; where: Prisma.ValuationRequestWhereInput }[] = [
  { key: "open", label: "Open", where: { status: { in: ["NEW", "QUOTED"] } } },
  ...VALUATION_STATUSES.map((status) => ({ key: status.toLowerCase(), label: statusLabel(status), where: { status } })),
  { key: "all", label: "All", where: {} },
];

export default async function ValuationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireDesk("sales", "/admin");
  const params = await searchParams;
  const filter = FILTERS.find((item) => item.key === q(params, "show")) ?? FILTERS[0];
  const [requests, waiting] = await Promise.all([
    prisma.valuationRequest.findMany({ where: filter.where, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.valuationRequest.count({ where: { status: "NEW" } }),
  ]);
  return (
    <div>
      <PageIntro
        eyebrow="Acquisitions"
        title="Valuation requests."
        lede="Sellers who sent a tape or a few loans from Value my loans. Each saw the instant range. Send your own range with a note, invite them to list, or close the request."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <nav aria-label="Filter requests" className="mt-2 flex flex-wrap gap-2">
        {FILTERS.map((item) => (
          <Link
            key={item.key}
            href={item.key === "open" ? "/admin/valuations" : `/admin/valuations?show=${item.key}`}
            aria-current={item.key === filter.key ? "page" : undefined}
            className={`rounded-full border px-3 py-1 text-[13px] ${item.key === filter.key ? "border-link bg-link/10 text-foreground" : "border-border text-muted-foreground"}`}
          >
            {item.label}
            {item.key === "new" && waiting ? ` · ${waiting}` : ""}
          </Link>
        ))}
      </nav>
      <ul className="mt-6 divide-y divide-border rounded-xl border border-border">
        {requests.length === 0 && <li className="px-5 py-10 text-sm text-muted-foreground">Nothing here. The public form is at /sell/value.</li>}
        {requests.map((request) => (
          <li key={request.id}>
            <Link href={`/admin/valuations/${request.id}`} className="grid gap-2 px-5 py-4 hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">
                  {request.name}
                  {request.company && request.company !== request.name ? <span className="text-muted-foreground"> · {request.company}</span> : null}
                </p>
                <p className="mt-0.5 truncate text-sm text-muted-foreground">
                  {request.email} · {request.loans === 1 ? "1 loan" : `${request.loans} loans`} · {money(request.upb)} UPB · {prettyDate(request.createdAt)}
                </p>
              </div>
              <div className="flex items-center gap-3 text-sm tabular-nums sm:justify-end">
                <span className="text-foreground">{request.lowPrice != null && request.highPrice != null ? `${money(request.lowPrice)} – ${money(request.highPrice)}` : "No range"}</span>
                <span className={`whitespace-nowrap text-[13px] font-medium ${request.status === "NEW" ? "text-link" : "text-muted-foreground"}`}>{statusLabel(request.status)}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
