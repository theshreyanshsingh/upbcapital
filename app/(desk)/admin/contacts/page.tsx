import Link from "next/link";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { prettyDate } from "@/lib/format";
import { roleLabel } from "@/lib/labels";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Contacts" };

export default async function ContactsPage() {
  await requireRole(["ADMIN"]);
  const [people, searches] = await Promise.all([
    prisma.user.findMany({
      where: { role: { in: ["BUYER", "INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER"] } },
      include: {
        inquiries: { take: 3, orderBy: { createdAt: "desc" }, include: { listing: { select: { title: true } } } },
        listings: { take: 3, orderBy: { createdAt: "desc" }, select: { id: true, title: true, status: true } },
        buyerProfile: { select: { status: true, entityName: true } },
        auditEvents: { take: 4, orderBy: { createdAt: "desc" } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.savedSearch.findMany({ where: { alertEnabled: true } }),
  ]);
  const demand = tally(searches);
  return (
    <div>
      <PageIntro
        eyebrow="Contacts"
        title="Buyers and sellers."
        lede="Every account on the desk, with the last listings, bids, and status changes attached."
      />
      <div className="mt-6 flex flex-wrap gap-4 text-[13px] font-medium">
        <a className="text-link" href="/api/admin/export?kind=users">Users CSV</a>
        <a className="text-link" href="/api/admin/export?kind=listings">Listings CSV</a>
        <a className="text-link" href="/api/admin/export?kind=notes">Notes CSV</a>
        <a className="text-link" href="/api/admin/export?kind=inquiries">Inquiries CSV</a>
      </div>
      <section className="mt-10">
        <p className="eyebrow">What saved searches want</p>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {demand.map((column) => (
            <article key={column.key} className="glass p-5">
              <p className="text-[13px] font-medium text-muted-foreground">{column.key}</p>
              <ul className="mt-3 space-y-2 text-sm">
                {column.rows.map((row) => (
                  <li key={row.label} className="flex justify-between gap-3">
                    <span className="text-foreground">{row.label}</span>
                    <span className="text-link">{row.count}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>
      <ul className="mt-10 divide-y divide-border border border-border rounded-xl">
        {people.map((person) => (
          <li key={person.id} className="px-5 py-5">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <p className="font-semibold tracking-tight text-2xl text-foreground">{person.name}</p>
                <p className="text-sm text-muted-foreground">{person.email}{person.companyName ? ` · ${person.companyName}` : ""}</p>
              </div>
              <p className="text-[13px] font-medium text-link">
                {roleLabel(person.role)} · {person.accountStatus.toLowerCase()}
                {person.role === "BUYER" ? ` · ${person.subscriptionTier === "PRO" ? "Pro" : "Free"}` : ""}
                {person.buyerProfile ? ` · file ${person.buyerProfile.status.toLowerCase()}` : ""}
              </p>
            </div>
            <div className="mt-3 grid gap-4 text-sm text-muted-foreground md:grid-cols-3">
              <div>
                <p className="text-xs font-medium">Listings</p>
                {person.listings.length === 0 && <p className="mt-1">None</p>}
                {person.listings.map((listing) => (
                  <p key={listing.id} className="mt-1"><Link className="text-foreground" href={`/admin/listings/${listing.id}`}>{listing.title}</Link></p>
                ))}
              </div>
              <div>
                <p className="text-xs font-medium">Bids and asks</p>
                {person.inquiries.length === 0 && <p className="mt-1">None</p>}
                {person.inquiries.map((inquiry) => (
                  <p key={inquiry.id} className="mt-1">{inquiry.type.toLowerCase()} · {inquiry.listing.title}</p>
                ))}
              </div>
              <div>
                <p className="text-xs font-medium">Recent changes</p>
                {person.auditEvents.length === 0 && <p className="mt-1">None yet</p>}
                {person.auditEvents.map((event) => (
                  <p key={event.id} className="mt-1">{event.action.toLowerCase()} · {prettyDate(event.createdAt)}</p>
                ))}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function tally(searches: { filters: unknown }[]) {
  const keys = [
    ["state", "State"],
    ["paymentStatus", "Performance"],
    ["lienPosition", "Lien"],
  ] as const;
  return keys.map(([key, label]) => {
    const counts = new Map<string, number>();
    for (const search of searches) {
      const filters = (search.filters ?? {}) as Record<string, string>;
      const raw = filters[key] || "Any";
      const value = raw === "Any" ? "Any" : key === "state" ? raw.toUpperCase() : raw.replaceAll("_", " ").toLowerCase();
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ label: name, count }));
    return { key: label, rows: rows.length ? rows : [{ label: "No saved searches", count: 0 }] };
  });
}
