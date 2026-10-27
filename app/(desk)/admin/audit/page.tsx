import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Audit log" };

export default async function AuditPage() {
  await requireRole(["ADMIN"]);
  const events = await prisma.auditEvent.findMany({
    include: { actor: { select: { name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take: 150,
  });
  return (
    <div>
      <PageIntro eyebrow="Audit" title="Every status change." lede="Review decisions, awards, closings, confidentiality, verification, and bid terms, newest first." />
      <ul className="mt-8 divide-y divide-border border border-border rounded-xl">
        {events.length === 0 && <li className="px-5 py-8 text-sm text-muted-foreground">Nothing has been written to the log yet.</li>}
        {events.map((event) => (
          <li key={event.id} className="grid gap-2 px-5 py-4 md:grid-cols-[180px_140px_1fr]">
            <p className="text-[13px] font-medium text-muted-foreground">{prettyDate(event.createdAt)}</p>
            <p className="text-[13px] font-medium text-link">{event.action.replaceAll("_", " ").toLowerCase()}</p>
            <p className="text-sm text-foreground">
              {event.actor?.name ?? "Desk"} · {event.entityType} {event.entityId.slice(-6)}
              {event.detail ? <span className="mt-1 block text-muted-foreground">{event.detail}</span> : null}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
