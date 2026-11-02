import Link from "next/link";
import { PageIntro } from "@/components/page-intro";
import { StatusPill } from "@/components/status-pill";
import { requireRole } from "@/lib/auth";
import { deskSearch } from "@/lib/desk-search";
import { prettyDate, q } from "@/lib/format";
import { roleLabel } from "@/lib/labels";

export const metadata = { title: "Search" };

export default async function DeskSearchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireRole(["ADMIN"]);
  const term = q(await searchParams, "q");
  const found = await deskSearch(term);
  return (
    <div>
      <PageIntro eyebrow="Search" title="Find anything on the desk." lede="Accounts, listings, borrowers, closings, and leads, by name, email, company, title, or record id." />
      <form action="/admin/search" role="search" className="flex max-w-xl gap-2">
        <input name="q" type="search" defaultValue={term} aria-label="Search the desk" placeholder="Name, email, company, title, borrower, or id" className="desk-input" autoFocus />
        <button type="submit" className="h-11 shrink-0 rounded-lg bg-primary px-4 text-[13px] font-medium text-primary-foreground">Search</button>
      </form>
      {term && !found && <p className="mt-6 text-sm text-muted-foreground">Type at least two characters.</p>}
      {found && found.total === 0 && <p className="mt-6 text-sm text-muted-foreground">Nothing on the desk matches “{found.term}”.</p>}
      {found && found.total > 0 && (
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <Group title="Accounts" empty={!found.users.length}>
            {found.users.map((user) => (
              <li key={user.id}>
                <Link href={`/admin/users?q=${encodeURIComponent(user.email)}`} className="text-foreground hover:underline">{user.name}</Link>
                <p className="text-xs text-muted-foreground">{user.email} · {roleLabel(user.role)}{user.companyName ? ` · ${user.companyName}` : ""} · {user.accountStatus.toLowerCase()}</p>
              </li>
            ))}
          </Group>
          <Group title="Listings" empty={!found.listings.length}>
            {found.listings.map((listing) => (
              <li key={listing.id} className="flex items-start justify-between gap-3">
                <Link href={`/admin/listings/${listing.id}`} className="text-foreground hover:underline">{listing.title}</Link>
                <StatusPill status={listing.status} />
              </li>
            ))}
          </Group>
          <Group title="Borrowers and addresses" empty={!found.borrowerNotes.length}>
            {found.borrowerNotes.map((note, index) => (
              <li key={`${note.listingId}-${index}`}>
                <Link href={`/admin/listings/${note.listingId}`} className="text-foreground hover:underline">{note.borrowerName || "Unnamed borrower"}</Link>
                <p className="text-xs text-muted-foreground">{note.city}, {note.state} · {note.listing.title} · {note.listing.status.toLowerCase()}</p>
              </li>
            ))}
          </Group>
          <Group title="Closings" empty={!found.closings.length}>
            {found.closings.map((closing) => (
              <li key={closing.id}>
                <Link href={`/closings/${closing.id}`} className="text-foreground hover:underline">{closing.listing.title}</Link>
                <p className="text-xs text-muted-foreground">{closing.status.toLowerCase()} · opened {prettyDate(closing.openedAt)}</p>
              </li>
            ))}
          </Group>
          <Group title="Leads" empty={!found.leads.length}>
            {found.leads.map((lead) => (
              <li key={lead.id}>
                <Link href="/admin/leads" className="text-foreground hover:underline">{lead.name}</Link>
                <p className="text-xs text-muted-foreground">{lead.email} · {lead.status.toLowerCase()}</p>
              </li>
            ))}
          </Group>
        </div>
      )}
    </div>
  );
}

function Group({ title, empty, children }: { title: string; empty: boolean; children: React.ReactNode }) {
  if (empty) return null;
  return (
    <section className="border border-border p-5 rounded-xl">
      <p className="eyebrow">{title}</p>
      <ul className="mt-3 space-y-3 text-sm">{children}</ul>
    </section>
  );
}
