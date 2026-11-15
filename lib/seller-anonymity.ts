import type { CompanyType } from "@prisma/client";
import { ndaOpensRoom } from "@/lib/acl";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";

// Buyers see a listing's seller as a type ("Credit union", "Bank") until the data room opens to them, as Garnet and
// PNC's exchange do. The room's papers name the chain of title anyway (lib/loan-file.ts), so admission is where the
// name shows: a signed NDA, and the seller's approval of that bidder where the seller asks for it (lib/room-access.ts).
// A party to a closing on the listing sees it too. A seller can choose to be named to every approved buyer
// (Listing.sellerNamed). The desk, the seller and the broker on the listing always see it. A firm's seat signs in as
// its firm (lib/seats.ts), so each check on the viewer's id holds for the firm's seats as well.

// The choices at signup and on the seller's desk, in the order they show. OTHER reads to buyers as "Institution".
export const COMPANY_TYPES: { value: CompanyType; label: string }[] = [
  { value: "BANK", label: "Bank" },
  { value: "CREDIT_UNION", label: "Credit union" },
  { value: "FUND", label: "Fund" },
  { value: "SERVICER", label: "Servicer" },
  { value: "LENDER", label: "Private lender" },
  { value: "OTHER", label: "Other" },
];

export const COMPANY_TYPE_VALUES = ["BANK", "CREDIT_UNION", "FUND", "SERVICER", "LENDER", "OTHER"] as const satisfies readonly CompanyType[];

const TYPE_LABELS: Record<CompanyType, string> = {
  BANK: "Bank",
  CREDIT_UNION: "Credit union",
  FUND: "Fund",
  SERVICER: "Servicer",
  LENDER: "Private lender",
  OTHER: "Institution",
};

// The desk's own paper is UPB's, and says so.
export const DESK_SELLER = "UPB Capital";
export const BROKER_CLIENT = "Broker's client";

export function isCompanyType(value: unknown): value is CompanyType {
  return typeof value === "string" && (COMPANY_TYPE_VALUES as readonly string[]).includes(value);
}

type SellerAccount = { role: string; name: string; companyName?: string | null; companyType?: string | null };
type SellerListing = { sellerId: string; brokerId?: string | null; clientSellerName?: string | null; seller: SellerAccount };

// The type a seller account shows as. An institution that never chose a type is an institution, and anyone else
// without one, an individual or a buyer reselling, is a private note holder.
export function sellerTypeLabel(account: { role: string; companyType?: string | null }) {
  if (account.role === "ADMIN") return DESK_SELLER;
  if (account.role === "BROKER") return BROKER_CLIENT;
  if (isCompanyType(account.companyType)) return TYPE_LABELS[account.companyType];
  return account.role === "INSTITUTIONAL_SELLER" ? "Institution" : "Private note holder";
}

// A broker files for a note holder whose name only the desk and the broker read (Listing.clientSellerName). That
// name never shows to a buyer outside the room, whatever the listing says.
export function heldForClient(listing: { sellerId: string; brokerId?: string | null; clientSellerName?: string | null }) {
  return Boolean(listing.clientSellerName?.trim()) || (Boolean(listing.brokerId) && listing.brokerId === listing.sellerId);
}

// The label a listing's seller shows as. A desk-filed tape is its seller's, so it reads the seller's type too.
export function sellerLabel(listing: SellerListing) {
  return heldForClient(listing) && listing.seller.role !== "ADMIN" ? BROKER_CLIENT : sellerTypeLabel(listing.seller);
}

// The seller's real name: the note holder a broker filed for, else the account's company or name.
export function sellerName(listing: SellerListing) {
  if (listing.seller.role === "ADMIN") return DESK_SELLER;
  return listing.clientSellerName?.trim() || listing.seller.companyName?.trim() || listing.seller.name;
}

export type NameViewer = { id: string; role: string } | null | undefined;
export type NameListing = { sellerId: string; brokerId?: string | null; sellerNamed?: boolean | null; clientSellerName?: string | null };
// What the viewer has on this listing: their NDA, if any, and whether they are a party to an open or complete closing.
export type NameFacts = { nda?: { accessStatus?: string | null } | null; closingParty?: boolean };

// The seller's choice to be named. A broker's client is never named this way.
export function namedToEveryBuyer(listing: NameListing) {
  return listing.sellerNamed === true && !heldForClient(listing);
}

// Whether this viewer may read the seller's name on this listing. The public pages name no seller either way.
export function maySeeSellerName(viewer: NameViewer, listing: NameListing, facts: NameFacts = {}) {
  if (!viewer) return false;
  if (viewer.role === "ADMIN") return true;
  if (viewer.id === listing.sellerId || (Boolean(listing.brokerId) && viewer.id === listing.brokerId)) return true;
  if (namedToEveryBuyer(listing)) return true;
  // An NDA still waiting on the seller, or declined, doesn't open the room, so it doesn't name the seller.
  return ndaOpensRoom(facts.nda) || Boolean(facts.closingParty);
}

// A bank or credit union that services its own loans is named in the tape's servicer field. Before the seller's
// name shows to this viewer, that servicer reads as the seller's type instead. Names compare without case,
// punctuation or the usual legal and charter words, so "First Community CU" is "First Community Credit Union".
const CHARTER_WORDS = /\b(inc|incorporated|llc|l l c|corp|corporation|co|company|na|n a|fsb|ssb|bank|bancorp|credit union|cu|federal|savings|association|assn|trust|servicing|services|mortgage)\b/g;

function bareName(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(CHARTER_WORDS, " ").replace(/\s+/g, " ").trim();
}

export function selfServiced(listing: SellerListing, servicerName: string | null | undefined) {
  if (listing.seller.role === "ADMIN" || !servicerName?.trim()) return false;
  const servicer = bareName(servicerName);
  if (servicer.length < 3) return false;
  return [listing.clientSellerName, listing.seller.companyName, listing.seller.name].some((name) => Boolean(name?.trim()) && bareName(name!) === servicer);
}

export function servicerShown(listing: SellerListing, servicerName: string | null | undefined, allowed: boolean) {
  if (allowed || !selfServiced(listing, servicerName)) return servicerName ?? null;
  return `${sellerLabel(listing)} (services its own loans)`;
}

// What to print for the seller: the name when this viewer may read it, else the label.
export function sellerShown(listing: SellerListing, allowed: boolean) {
  return allowed ? sellerName(listing) : sellerLabel(listing);
}

// The listings, of those given, where this account buys or funds an open or complete closing, by the same rule as
// the data room (lib/data-room.ts).
async function closingPartyListings(userId: string, listingIds: string[]) {
  const closings = await prisma.closing.findMany({
    where: { listingId: { in: listingIds }, status: { in: ["OPEN", "COMPLETE"] } },
    select: { id: true, listingId: true, inquiryId: true },
  });
  if (!closings.length) return new Set<string>();
  const inquiryIds = closings.flatMap((closing) => (closing.inquiryId ? [closing.inquiryId] : []));
  const [bought, funded] = await Promise.all([
    inquiryIds.length ? prisma.inquiry.findMany({ where: { id: { in: inquiryIds }, buyerId: userId }, select: { id: true } }) : [],
    prisma.closingFunder.findMany({ where: { closingId: { in: closings.map((closing) => closing.id) }, userId }, select: { closingId: true } }),
  ]);
  const mine = new Set([...bought.map((row) => row.id), ...funded.map((row) => row.closingId)]);
  return new Set(closings.filter((closing) => mine.has(closing.id) || (closing.inquiryId && mine.has(closing.inquiryId))).map((closing) => closing.listingId));
}

// maySeeSellerName for several listings at once, reading the viewer's NDAs and closings only where the listing alone
// doesn't settle it.
export async function sellerNameSight(viewer: NameViewer, listings: (NameListing & { id: string })[]) {
  const sight = new Map(listings.map((listing) => [listing.id, maySeeSellerName(viewer, listing)]));
  const open = listings.filter((listing) => !sight.get(listing.id));
  if (!viewer || !open.length) return sight;
  const ids = open.map((listing) => listing.id);
  const [ndas, parties] = await Promise.all([
    prisma.ndaAcknowledgment.findMany({ where: { userId: viewer.id, listingId: { in: ids } }, select: { listingId: true, accessStatus: true } }),
    closingPartyListings(viewer.id, ids),
  ]);
  const ndaOf = new Map(ndas.map((nda) => [nda.listingId, nda]));
  for (const listing of open) {
    sight.set(listing.id, maySeeSellerName(viewer, listing, { nda: ndaOf.get(listing.id) ?? null, closingParty: parties.has(listing.id) }));
  }
  return sight;
}

// What to print for one listing's seller to one viewer, reading what it needs.
export async function sellerShownTo(viewer: NameViewer, listing: SellerListing & NameListing & { id: string }) {
  const sight = await sellerNameSight(viewer, [listing]);
  return sellerShown(listing, sight.get(listing.id) ?? false);
}

// ---------------------------------------------------------------------------------------------------------------
// The seller's lines, and the desk's

// The seller's one line on what buyers read, beside the switch.
export function sellerNamingLine(listing: SellerListing & NameListing) {
  if (heldForClient(listing)) {
    return `Buyers see the seller as ${BROKER_CLIENT.toLowerCase()}, with you named as the broker, until the data room opens to them. Your client's name never shows before then.`;
  }
  if (namedToEveryBuyer(listing)) return `Every approved buyer sees your name, ${sellerName(listing)}.`;
  return `Buyers see you as ${sellerLabel(listing)} until the data room opens to them, so leave your name out of the title and summary.`;
}

// The desk's line on its listing page: what a buyer outside the room reads, and when the name shows.
export function deskSellerLine(listing: SellerListing & NameListing) {
  const name = sellerName(listing);
  if (listing.seller.role === "ADMIN") return `Buyers see the seller as ${DESK_SELLER}: this is the desk's own paper.`;
  if (namedToEveryBuyer(listing)) return `The seller chose to be named: every approved buyer sees ${name}.`;
  const client = heldForClient(listing) ? " The broker is named as the broker." : "";
  return `Buyers see the seller as ${sellerLabel(listing)} until the data room opens to them, then ${name}.${client}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Changes

const CLOSED = new Set(["SOLD", "WITHDRAWN", "REJECTED"]);

// A sold, withdrawn or declined listing has no buyers left to show, so its choice stays as it was.
export function namingClosed(status: string) {
  return CLOSED.has(status);
}

// The seller's switch: named to every approved buyer, or a type until the room opens. The seller of record alone sets
// it, while the listing is filed or live.
export async function setSellerNamed(input: { listingId: string; actorId: string; on: boolean }) {
  const listing = await prisma.listing.findUnique({
    where: { id: input.listingId },
    select: { id: true, status: true, sellerId: true, brokerId: true, clientSellerName: true, sellerNamed: true },
  });
  if (!listing || listing.sellerId !== input.actorId) return { error: "That listing isn't yours." } as const;
  if (heldForClient(listing)) return { error: "A broker's client stays unnamed until a buyer is in the data room." } as const;
  if (namingClosed(listing.status)) return { error: "This listing is closed, so there is nothing to change." } as const;
  if ((listing.sellerNamed === true) === input.on) return { error: null, on: input.on, unchanged: true } as const;
  await prisma.listing.update({ where: { id: listing.id }, data: { sellerNamed: input.on } });
  await audit(input.actorId, "SELLER_NAMED", "listing", listing.id, input.on ? "on" : "off");
  return { error: null, on: input.on, unchanged: false } as const;
}

export const SELLER_TYPE_ROLES = ["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER"] as const;

// The account's company type, from the seller's desk. Blank clears it.
export async function setCompanyType(account: { id: string; role: string; companyType?: string | null }, value: unknown) {
  if (!(SELLER_TYPE_ROLES as readonly string[]).includes(account.role)) return { error: "Only a seller account has a company type." } as const;
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw && !isCompanyType(raw)) return { error: "Choose a type from the list." } as const;
  const next = raw ? (raw as CompanyType) : null;
  const label = sellerTypeLabel({ role: account.role, companyType: next });
  if ((account.companyType ?? null) === next) return { error: null, label, unchanged: true } as const;
  await prisma.user.update({ where: { id: account.id }, data: { companyType: next } });
  await audit(account.id, "COMPANY_TYPE", "user", account.id, next ?? "none");
  return { error: null, label, unchanged: false } as const;
}
