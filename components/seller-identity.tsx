import Link from "next/link";
import { BadgeCheck } from "lucide-react";
import { addPoolDocuments } from "@/actions/listings";
import { saveSellerIdentitySetting } from "@/actions/seller-identity";
import { SubmitButton } from "@/components/submit-button";
import { prisma } from "@/lib/prisma";
import { SELLER_FILE_HREF, identityGateApplies, keepsSellerFile, listingMandates, sellerFileLabel, sellerIdentityRequired, sellerVerified } from "@/lib/seller-identity";
import { getSettings } from "@/lib/settings";
import { deskCan, type Staff } from "@/lib/staff";

// The seller file's pieces on other pages. Each loads what it shows, so a shared page needs one line for it.

// On the buyer files page: the way to the seller files. The page shows it to compliance only.
export async function SellerFilesLink() {
  const waiting = await prisma.sellerProfile.count({ where: { status: "SUBMITTED" } });
  return (
    <p className="mt-4 text-sm">
      <a href={SELLER_FILE_HREF} className="font-medium text-link">Seller files</a>
      <span className="text-muted-foreground">{waiting ? ` · ${waiting} waiting for review` : " · identity and signing authority"}</span>
    </p>
  );
}

// On the desk's listing page: where the seller's file stands, and whether approval waits on it.
export async function SellerIdentityLine({ listing, viewer }: { listing: { id: string; sellerId: string; brokerId?: string | null; seller: { role: string } }; viewer: Staff }) {
  if (!identityGateApplies(listing)) return <p className="mt-3 text-sm text-muted-foreground">Seller identity: not asked. The desk lists its own paper.</p>;
  // A broker is the seller of record on what they file, so the line reads their file, and the holder's mandate below.
  const whose = listing.brokerId ? "Broker's seller file" : "Seller identity";
  const [profile, settings, mandates] = await Promise.all([
    prisma.sellerProfile.findUnique({ where: { userId: listing.sellerId }, select: { status: true, entityName: true, signerName: true, signerTitle: true } }),
    getSettings(),
    listing.brokerId ? listingMandates(listing.id) : Promise.resolve([]),
  ]);
  const approved = profile?.status === "APPROVED";
  const required = sellerIdentityRequired(settings);
  const mandate = mandates[0];
  return (
    <>
      <p className={`mt-3 text-sm ${approved || !required ? "text-foreground" : "text-warn"}`}>
        {whose}: {sellerFileLabel(profile?.status)}
        {approved && profile ? ` · ${profile.entityName}, signed by ${profile.signerName}${profile.signerTitle ? `, ${profile.signerTitle}` : ""}` : ""}
        {!approved && (required ? " · approval waits on it" : " · not required by the desk's setting")}
        {deskCan(viewer, "compliance") && profile && profile.status !== "NOT_STARTED" && (
          <>
            {" · "}
            <a href={`${SELLER_FILE_HREF}#seller-${listing.sellerId}`} className="font-medium text-link">Open the file</a>
          </>
        )}
      </p>
      {listing.brokerId && (
        <p className={`mt-1 text-sm ${mandate || !required ? "text-foreground" : "text-warn"}`}>
          Note holder&apos;s mandate: {mandate ? <a href={`/api/documents/${mandate.id}`} className="text-link">{mandate.originalName}</a> : "not on file"}
          {!mandate && (required ? " · approval waits on it" : " · not required by the desk's setting")}
        </p>
      )}
    </>
  );
}

// On a broker's deal page: the note holder's mandate for this listing, and the way to add one. It goes to the desk
// alone, through the same upload as the deal's other files.
export async function MandateFile({ listingId, open }: { listingId: string; open: boolean }) {
  const [mandates, settings] = await Promise.all([listingMandates(listingId), getSettings()]);
  const required = sellerIdentityRequired(settings);
  return (
    <section id="mandate" aria-labelledby="mandate-heading" className="mt-8 scroll-mt-6 space-y-3 border border-border p-5 rounded-xl">
      <p id="mandate-heading" className="eyebrow">Note holder&apos;s mandate</p>
      {mandates.length ? (
        <ul className="space-y-1 text-sm">
          {mandates.map((mandate) => (
            <li key={mandate.id}>
              <a href={`/api/documents/${mandate.id}`} className="text-link">{mandate.originalName}</a>
            </li>
          ))}
        </ul>
      ) : (
        <p className={`text-sm ${required ? "text-warn" : "text-muted-foreground"}`}>
          No mandate on file.{required ? " The desk approves this deal only once the note holder's signed mandate or listing agreement is here." : ""}
        </p>
      )}
      <p className="text-xs text-muted-foreground">The signed mandate or listing agreement from the note holder for this listing. Only you and the desk read it. Buyers never see it.</p>
      {open && (
        <form action={addPoolDocuments} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="listingId" value={listingId} />
          <input type="hidden" name="from" value="broker" />
          <input type="hidden" name="documentType" value="MANDATE" />
          <label className="block min-w-56 flex-1">
            <span className="text-[13px] text-muted-foreground">{mandates.length ? "Add a newer mandate" : "Mandate"}</span>
            <input name="documents" type="file" accept=".pdf,.png,.jpg,.jpeg" required className="desk-input mt-2" />
          </label>
          <SubmitButton variant="outline" className="h-10 text-[13px] font-medium" pendingLabel="Uploading…">Send to the desk</SubmitButton>
        </form>
      )}
    </section>
  );
}

// On the seller's or broker's desk until the file is approved.
export async function SellerIdentityBanner({ user }: { user: { id: string; role: string } }) {
  if (!keepsSellerFile(user.role)) return null;
  const broker = user.role === "BROKER";
  const [profile, settings] = await Promise.all([
    prisma.sellerProfile.findUnique({ where: { userId: user.id }, select: { status: true, reviewerNote: true } }),
    getSettings(),
  ]);
  const status = profile?.status ?? "NOT_STARTED";
  if (status === "APPROVED") return null;
  const required = sellerIdentityRequired(settings);
  const copy =
    status === "SUBMITTED"
      ? "Your seller file is with the desk."
      : status === "CHANGES_REQUESTED"
        ? `The desk asked for changes to your seller file.${profile?.reviewerNote ? ` ${profile.reviewerNote}` : ""}`
        : status === "REJECTED"
          ? `The desk declined your seller file.${profile?.reviewerNote ? ` ${profile.reviewerNote}` : ""} Write the desk to reopen it.`
          : broker
            ? "Confirm who you are and that you may act as a broker. You are the seller of record on what you file."
            : "Confirm who you are and that you may sell the note.";
  const listings = broker ? "the deals you file" : "your listings";
  const why = required ? ` The desk approves ${listings} only once it approves this file.` : " Buyers see that the seller's identity is verified once the desk approves it.";
  const action = status === "NOT_STARTED" ? "Start your seller file" : status === "CHANGES_REQUESTED" ? "Update your seller file" : "See your seller file";
  return (
    <p className="mt-6 border border-link/30 bg-link/10 px-4 py-3 text-sm text-foreground rounded-xl">
      {copy}
      {status === "REJECTED" ? "" : why}{" "}
      <Link href="/seller/verification" className="font-medium text-link">{action}</Link>
    </p>
  );
}

// On a listing: a mark for buyers once the desk has approved the seller's identity and signing authority.
export async function SellerVerifiedBadge({ sellerId }: { sellerId: string }) {
  if (!(await sellerVerified(sellerId))) return null;
  return (
    <span className="figure inline-flex items-center gap-1 rounded-full bg-good/10 px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap text-good">
      <BadgeCheck aria-hidden className="size-3.5" />
      Seller identity verified
    </span>
  );
}

// On the settings page: the gate on the desk's listing approval.
export function SellerIdentitySetting({ value, owns }: { value: boolean | null | undefined; owns: boolean }) {
  const current = value === true ? "on" : value === false ? "off" : "default";
  const releaseOn = sellerIdentityRequired({ requireSellerIdentity: null });
  return (
    <form id="seller-identity" action={saveSellerIdentitySetting} className="mt-8 scroll-mt-6 space-y-5 glass p-6" aria-labelledby="seller-identity-heading">
      <div>
        <p id="seller-identity-heading" className="eyebrow">Seller identity</p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          When it is on, the desk approves a seller&apos;s identity and signing authority before it approves their listing. A broker is the seller of record on what they file, so the same holds for them. The desk&apos;s own paper is exempt. Either way, each listing shows the seller&apos;s status.
        </p>
        <p className="mt-2 text-sm text-foreground">Now: {sellerIdentityRequired({ requireSellerIdentity: value }) ? "on" : "off"}.</p>
      </div>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Require an approved seller file</span>
        <select name="requireSellerIdentity" defaultValue={current} disabled={!owns} className="desk-input mt-2">
          <option value="default">Default: on in release builds, off in the demo ({releaseOn ? "on here" : "off here"})</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      </label>
      {owns ? <SubmitButton className="h-11 text-[13px] font-medium" pendingLabel="Saving…">Save the gate</SubmitButton> : <p className="text-sm text-muted-foreground">Only an owner changes the gate.</p>}
    </form>
  );
}
