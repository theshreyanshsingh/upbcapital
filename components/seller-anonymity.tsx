import { saveCompanyType } from "@/actions/auth";
import { saveSellerNamed } from "@/actions/seller-decisions";
import { SubmitButton } from "@/components/submit-button";
import { prisma } from "@/lib/prisma";
import { COMPANY_TYPES, heldForClient, namingClosed, sellerNamingLine, sellerTypeLabel, SELLER_TYPE_ROLES } from "@/lib/seller-anonymity";

// How buyers see the seller before the data room opens to them (lib/seller-anonymity.ts): the switch on a listing's
// terms, and the type on the seller's desk.

type NamingListing = { id: string; status: string; sellerId: string; brokerId?: string | null; clientSellerName?: string | null; sellerNamed?: boolean | null };

// Under the seller's terms on a listing. A broker's client is never named this way, so a broker sees the line alone.
export async function SellerNameChoice({ listing, canAnswer }: { listing: NamingListing; canAnswer: boolean }) {
  const seller = await prisma.user.findUnique({ where: { id: listing.sellerId }, select: { role: true, name: true, companyName: true, companyType: true } });
  if (!seller) return null;
  const full = { ...listing, seller };
  const editable = canAnswer && !heldForClient(full) && !namingClosed(listing.status);
  return (
    <div className="mt-4">
      <p className="text-sm text-muted-foreground">{sellerNamingLine(full)}</p>
      {editable && (
        <form action={saveSellerNamed} className="mt-3 flex flex-wrap items-center gap-3">
          <input type="hidden" name="listingId" value={listing.id} />
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" name="sellerNamed" defaultChecked={listing.sellerNamed === true} />
            Show our name to every approved buyer
          </label>
          <SubmitButton variant="outline" pendingLabel="Saving…" className="h-9 px-3 text-[13px] font-medium">Save</SubmitButton>
        </form>
      )}
    </div>
  );
}

// On the seller's desk: the type buyers read on every listing until the room opens to them.
export function SellerTypeForm({ user }: { user: { role: string; companyType?: string | null } }) {
  if (!(SELLER_TYPE_ROLES as readonly string[]).includes(user.role)) return null;
  const institution = user.role === "INSTITUTIONAL_SELLER";
  return (
    <form id="seller-type" action={saveCompanyType} className="mt-8 scroll-mt-6 space-y-3 rounded-xl border border-border p-5">
      <p className="eyebrow">How buyers see you</p>
      <p className="text-sm text-muted-foreground">
        Until the data room opens to a buyer, your listings show you as {sellerTypeLabel(user)}, not by name. You can choose to be named on each listing&apos;s page.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-[13px] text-muted-foreground">{institution ? "Company type" : "Type, if you sell as a business"}</span>
          <select name="companyType" defaultValue={user.companyType ?? ""} className="desk-input mt-2 w-56">
            <option value="">{institution ? "Not stated: Institution" : "None: Private note holder"}</option>
            {COMPANY_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
          </select>
        </label>
        <SubmitButton variant="outline" pendingLabel="Saving…" className="h-11 text-[13px] font-medium">Save the type</SubmitButton>
      </div>
    </form>
  );
}
