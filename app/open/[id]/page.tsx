import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ComplianceNote } from "@/components/compliance-note";
import { MarketingFooter, MarketingHeader } from "@/components/marketing";
import { getCurrentUser } from "@/lib/auth";
import { labelOf } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { upbBucket } from "@/lib/strata";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const listing = await prisma.listing.findUnique({
    where: { id },
    include: { notes: { take: 1 } },
  });
  const note = listing?.notes[0];
  if (!listing || !note || !["APPROVED", "PENDING"].includes(listing.status)) {
    return { title: "Listing" };
  }
  const title = `${note.city}, ${note.state} ${labelOf("payment", note.paymentStatus).toLowerCase()} note`;
  return {
    title,
    description: `An anonymized ${labelOf("lien", note.lienPosition).toLowerCase()} mortgage note in ${note.city}, ${note.state}. Unpaid principal is in the ${upbBucket(Number(note.upb))} band.`,
  };
}

export default async function OpenListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [user, listing] = await Promise.all([
    getCurrentUser(),
    prisma.listing.findUnique({ where: { id }, include: { notes: true, seller: true } }),
  ]);
  if (!listing || !["APPROVED", "PENDING"].includes(listing.status) || listing.notes.length === 0) notFound();
  const note = [...listing.notes].sort((a, b) => Number(b.upb) - Number(a.upb))[0];
  const upb = listing.notes.reduce((sum, row) => sum + Number(row.upb), 0);
  const states = [...new Set(listing.notes.map((row) => row.state))].join(", ");
  return (
    <div>
      <MarketingHeader authed={Boolean(user)} />
      <main id="desk" className="mx-auto max-w-3xl px-5 pb-24 pt-32">
        <p className="eyebrow">{listing.kind === "POOL" ? "Pool" : "Note"} · {listing.status === "PENDING" ? "In contract" : "Live"}</p>
        <h1 className="mt-4 font-semibold tracking-tight text-5xl text-foreground md:text-6xl">{note.city}, {note.state}</h1>
        <p className="mt-6 text-lg leading-relaxed text-muted-foreground">
          {listing.kind === "POOL"
            ? `${listing.notes.length} loans across ${states}. The largest unpaid principal sits in the ${upbBucket(upb)} band for the pool.`
            : `A ${labelOf("lien", note.lienPosition).toLowerCase()} ${labelOf("payment", note.paymentStatus).toLowerCase()} note. Unpaid principal is in the ${upbBucket(Number(note.upb))} band.`}
        </p>
        <dl className="mt-8 grid gap-px bg-muted sm:grid-cols-2">
          <Fact k="Performance" v={labelOf("payment", note.paymentStatus)} />
          <Fact k="Lien" v={labelOf("lien", note.lienPosition)} />
          <Fact k="Collateral" v={labelOf("property", note.propertyType)} />
          <Fact k="UPB band" v={upbBucket(listing.kind === "POOL" ? upb : Number(note.upb))} />
        </dl>
        <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
          Street, borrower, ZIP, and price stay on the desk. Sign in to underwrite the file.
        </p>
        <ComplianceNote states={listing.notes.map((row) => row.state)} sellerFinanced={listing.sellerFinanced} sellerRole={listing.seller.role} />
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href={user ? `/marketplace/${listing.id}` : "/login"} className="inline-flex h-11 items-center bg-primary px-5 text-[13px] font-medium text-primary-foreground rounded-lg">
            {user ? "Open on the desk" : "Sign in"}
          </Link>
          {!user && (
            <Link href="/signup" className="inline-flex h-11 items-center border border-link/40 px-5 text-[13px] font-medium text-link rounded-lg">
              Request access
            </Link>
          )}
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="bg-card px-4 py-3">
      <dt className="text-xs font-medium text-muted-foreground">{k}</dt>
      <dd className="mt-1 text-foreground">{v}</dd>
    </div>
  );
}
