import Link from "next/link";
import { inviteListingBuyers, revokeListingInvite, setListingVisibility } from "@/actions/private-listings";
import { SubmitButton } from "@/components/submit-button";
import { prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { INVITES_AT_ONCE, isPrivateListing, listingInvites, sellerExclusions } from "@/lib/private-listings";

// Who sees a listing: everyone on the book, or only the buyers the seller invites. The seller, the filing broker and
// the desk set it, before or after go-live. The desk also reads the seller's excluded buyers here.
// readOnly is for a desk role outside sales: it reads the list, and the actions refuse it the change.
export async function PrivateSalePanel({ listingId, from, readOnly = false }: { listingId: string; from: "seller" | "broker" | "admin" | "resale"; readOnly?: boolean }) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, status: true, sellerId: true, visibility: true } });
  if (!listing) return null;
  const desk = from === "admin";
  const [invites, exclusions] = await Promise.all([listingInvites(listing.id), desk ? sellerExclusions(listing.sellerId) : Promise.resolve([])]);
  const hidden = isPrivateListing(listing);
  const open = ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED", "PENDING"].includes(listing.status);
  const editable = open && !readOnly;
  const live = invites.filter((invite) => !invite.revokedAt);
  const revoked = invites.filter((invite) => invite.revokedAt);
  const whose = desk ? "the seller" : "you";
  return (
    <section id="audience" aria-labelledby="audience-heading" className="mt-10 scroll-mt-6 border border-border p-5 rounded-xl">
      <p id="audience-heading" className="eyebrow">Audience</p>
      <p className="mt-2 text-sm text-foreground">
        {hidden
          ? `Private. Only the buyers ${whose === "you" ? "you invite" : "invited"}, the desk and ${whose} see this listing.`
          : "Public. Every approved buyer can find it on the book."}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        A private listing stays off the book, search, alerts, buy-box matches, sale-event pages, the public pages and results. Its price never shows in comps.
      </p>
      {editable && (
        <form action={setListingVisibility} className="mt-3">
          <input type="hidden" name="listingId" value={listing.id} />
          <input type="hidden" name="from" value={from} />
          <input type="hidden" name="visibility" value={hidden ? "PUBLIC" : "PRIVATE"} />
          <SubmitButton variant="outline" pendingLabel="Saving…" className="h-9 px-3 text-[13px] font-medium">
            {hidden ? "Make it public" : "Make it private"}
          </SubmitButton>
          <p className="mt-2 text-xs text-muted-foreground">
            {hidden
              ? "Going public on a live listing alerts saved searches and buy boxes as a new listing would."
              : "Buyers who already bid keep their bids. Those not invited stop seeing the listing at once."}
          </p>
        </form>
      )}
      {readOnly && <p className="mt-3 text-sm text-muted-foreground">The sales side of the desk changes this.</p>}
      {hidden && editable && (
        <form action={inviteListingBuyers} className="mt-5 space-y-2">
          <input type="hidden" name="listingId" value={listing.id} />
          <input type="hidden" name="from" value={from} />
          <label className="block">
            <span className="text-[13px] font-semibold text-foreground">Invite buyers by email</span>
            <textarea name="emails" required rows={3} placeholder="One address per line, or separated by commas." className="desk-input mt-2 min-h-20" />
          </label>
          <p className="text-xs text-muted-foreground">
            Up to {INVITES_AT_ONCE} at a time. A buyer with an account sees it on the book at once. Anyone else gets a link that opens it once they sign up with that address.
          </p>
          <SubmitButton pendingLabel="Sending…" className="h-9 px-3 text-[13px] font-medium">Send invitations</SubmitButton>
        </form>
      )}
      {invites.length > 0 && (
        <div className="mt-5">
          <p className="text-[13px] font-semibold text-foreground">Invited</p>
          {live.length === 0 && <p className="mt-2 text-sm text-muted-foreground">No open invitations.</p>}
          <ul className="mt-2 divide-y divide-border border-y border-border">
            {live.map((invite) => (
              <li key={invite.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="break-all text-sm text-foreground">{invite.email}</p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    Invited {prettyDate(invite.createdAt)} · {invite.openedAt ? `Opened ${prettyDate(invite.openedAt)}` : "Not opened yet"}
                  </p>
                </div>
                {editable && (
                  <form action={revokeListingInvite}>
                    <input type="hidden" name="inviteId" value={invite.id} />
                    <input type="hidden" name="from" value={from} />
                    <SubmitButton variant="ghost" pendingLabel="Revoking…" className="h-9 px-3 text-[13px] font-medium text-bad">Revoke</SubmitButton>
                  </form>
                )}
              </li>
            ))}
          </ul>
          {revoked.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Revoked: {revoked.map((invite) => `${invite.email} (${prettyDate(invite.revokedAt)})`).join(", ")}
            </p>
          )}
        </div>
      )}
      {desk && (
        <div className="mt-5">
          <p className="text-[13px] font-semibold text-foreground">The seller&apos;s excluded buyers</p>
          <SellerExclusionList rows={exclusions} empty="The seller excludes no one. None of their listings is hidden from any buyer." />
        </div>
      )}
      {from === "seller" && (
        <p className="mt-4 text-xs text-muted-foreground">
          Buyers you never sell to are on <Link href="/seller/exclusions" className="text-link">your excluded buyers</Link>. None of your listings shows to them, public or private.
        </p>
      )}
    </section>
  );
}

type ExclusionRow = Awaited<ReturnType<typeof sellerExclusions>>[number];

// The seller's list as the desk reads it, with the account an email matched.
export function SellerExclusionList({ rows, empty }: { rows: ExclusionRow[]; empty: string }) {
  if (!rows.length) return <p className="mt-2 text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="mt-2 divide-y divide-border border-y border-border">
      {rows.map((row) => (
        <li key={row.id} className="py-3">
          <p className="break-all text-sm text-foreground">
            {row.company ? `Company: ${row.company}` : `Email: ${row.email ?? "—"}`}
            {row.account ? ` · account ${row.account.name}` : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            Added {prettyDate(row.createdAt)}
            {row.reason ? ` · ${row.reason}` : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}
