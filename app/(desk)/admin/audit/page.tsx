import Link from "next/link";
import { PageIntro } from "@/components/page-intro";
import { auditFilterFrom, auditPage, auditQuery, auditVocabulary } from "@/lib/audit-log";
import { requireRole } from "@/lib/auth";
import { prettyDate, q } from "@/lib/format";
import { deskCan } from "@/lib/staff";

export const metadata = { title: "Audit log" };

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["ADMIN"]);
  const params = await searchParams;
  const filter = auditFilterFrom(params);
  const [{ events, total, page, pages }, vocabulary] = await Promise.all([auditPage(filter, Number(q(params, "page")) || 1), auditVocabulary()]);
  const query = auditQuery(filter);
  const filtered = Boolean(query);
  const pageHref = (target: number) => `/admin/audit${auditQuery(filter, target) ? `?${auditQuery(filter, target)}` : ""}`;
  return (
    <div>
      <PageIntro eyebrow="Audit" title="Every status change." lede="Review decisions, awards, closings, wires, confidentiality, verification, staff roles and bid terms, newest first. Dates are UTC." />
      <form action="/admin/audit" role="search" aria-label="Filter the audit log" className="mt-6 grid gap-3 border border-border p-4 rounded-xl sm:grid-cols-2 lg:grid-cols-3">
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Who</span>
          <input name="actor" defaultValue={filter.actor} placeholder="Name, email, account id or system" className="desk-input mt-1" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">What</span>
          <select name="action" defaultValue={filter.action} className="desk-input mt-1">
            <option value="">Any action</option>
            {vocabulary.actions.map((action) => <option key={action} value={action}>{action.replaceAll("_", " ").toLowerCase()}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Record type</span>
          <select name="entityType" defaultValue={filter.entityType} className="desk-input mt-1">
            <option value="">Any record</option>
            {vocabulary.entityTypes.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Record id</span>
          <input name="entityId" defaultValue={filter.entityId} placeholder="The full id" className="desk-input mt-1" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">From</span>
          <input name="from" type="date" defaultValue={filter.from} className="desk-input mt-1" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">To</span>
          <input name="to" type="date" defaultValue={filter.to} className="desk-input mt-1" />
        </label>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-3">
          <button type="submit" className="h-10 rounded-lg bg-primary px-4 text-[13px] font-medium text-primary-foreground">Filter</button>
          {filtered && <Link href="/admin/audit" className="text-[13px] font-medium text-link">Clear</Link>}
          {deskCan(user, "compliance") ? (
            <a href={`/api/admin/audit${query ? `?${query}` : ""}`} className="text-[13px] font-medium text-link">Download as CSV</a>
          ) : (
            <span className="text-xs text-muted-foreground">The CSV is for compliance and owners.</span>
          )}
        </div>
      </form>
      <p className="mt-4 text-sm text-muted-foreground tabular-nums">
        {total.toLocaleString("en-US")} event{total === 1 ? "" : "s"}{filtered ? " match" : ""}{pages > 1 ? ` · page ${page} of ${pages}` : ""}
      </p>
      <ul className="mt-3 divide-y divide-border border border-border rounded-xl">
        {events.length === 0 && <li className="px-5 py-8 text-sm text-muted-foreground">{filtered ? "Nothing in the log matches that filter." : "Nothing has been written to the log yet."}</li>}
        {events.map((event) => (
          <li key={event.id} className="grid gap-2 px-5 py-4 md:grid-cols-[180px_140px_1fr]">
            <p className="text-[13px] font-medium text-muted-foreground">
              {prettyDate(event.createdAt)} <span className="tabular-nums">{event.createdAt.toISOString().slice(11, 16)}</span>
            </p>
            <p className="text-[13px] font-medium text-link">{event.action.replaceAll("_", " ").toLowerCase()}</p>
            <p className="min-w-0 break-words text-sm text-foreground">
              {event.actor?.name ?? (event.actorId ? "Removed account" : "System")} ·{" "}
              <Link href={`/admin/audit?${new URLSearchParams({ entityType: event.entityType, entityId: event.entityId }).toString()}`} className="text-link">
                {event.entityType} {event.entityId.slice(-6)}
              </Link>
              {event.detail ? <span className="mt-1 block text-muted-foreground">{event.detail}</span> : null}
            </p>
          </li>
        ))}
      </ul>
      {pages > 1 && (
        <nav aria-label="Audit log pages" className="mt-4 flex flex-wrap items-center gap-3 text-[13px] font-medium">
          {page > 1 ? <Link href={pageHref(page - 1)} className="text-link">Newer</Link> : <span className="text-muted-foreground">Newer</span>}
          <span className="text-muted-foreground tabular-nums">Page {page} of {pages}</span>
          {page < pages ? <Link href={pageHref(page + 1)} className="text-link">Older</Link> : <span className="text-muted-foreground">Older</span>}
        </nav>
      )}
    </div>
  );
}
