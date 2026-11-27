import { headers } from "next/headers";
import { after } from "next/server";
import { recordHit } from "@/lib/hits";
import { labelOf } from "@/lib/labels";
import { launchPending } from "@/lib/launch-rules";
import { prisma } from "@/lib/prisma";
import { canSeeListing, isPrivateListing, type ListingViewer } from "@/lib/private-listings";
import { stalePaused } from "@/lib/provenance-rules";
import { upbBucket } from "@/lib/strata";

// Shareable listing cards. A public live listing's teaser page (/open/[id]) carries a preview image for LinkedIn, X
// and email (app/open/[id]/opengraph-image.tsx), and its seller, filing broker and the desk get a share panel with the
// link (components/share-listing.tsx). The card shows only what the public page shows: the city and state, note or
// pool, the lien, the payment status and the UPB band. Never the ask, the street, the borrower or the seller.

type CardNote = { city: string; state: string; lienPosition: string; paymentStatus: string; upb: number };
export type CardListing = {
  id: string;
  kind: string;
  sellerId: string;
  brokerId?: string | null;
  status: string;
  visibility?: string | null;
  launchAt?: Date | null;
  stalePausedAt?: Date | null;
  notes: CardNote[];
};

export type CardFacts = {
  pool: boolean;
  // The largest loan's city and state, as the public page's title.
  place: string;
  loans: number;
  states: string[];
  lien: string;
  lienPosition: string;
  payment: string;
  band: string;
  status: "Live on the desk" | "In contract";
};

// Live: approved, past any launch time, and not paused for the seller's reconfirmation. A listing that went into
// contract keeps its card, so a link already shared still previews.
export function liveListing(listing: Pick<CardListing, "status" | "launchAt" | "stalePausedAt">, now = new Date()) {
  return listing.status === "APPROVED" && !launchPending(listing, now) && !stalePaused(listing);
}

// The facts a listing's card shows, or null for the generic UPB Capital card: missing, private, or neither live nor
// in contract. Who may see it is cardFacts' check, below.
export function cardFactsOf(listing: CardListing | null | undefined, now = new Date()): CardFacts | null {
  if (!listing || !listing.notes.length || isPrivateListing(listing)) return null;
  const live = liveListing(listing, now);
  if (!live && listing.status !== "PENDING") return null;
  const note = [...listing.notes].sort((a, b) => Number(b.upb) - Number(a.upb))[0];
  const pool = listing.kind === "POOL";
  const upb = listing.notes.reduce((sum, row) => sum + Number(row.upb), 0);
  return {
    pool,
    place: `${note.city}, ${note.state}`,
    loans: listing.notes.length,
    states: [...new Set(listing.notes.map((row) => row.state))],
    lien: labelOf("lien", note.lienPosition),
    lienPosition: note.lienPosition,
    payment: labelOf("payment", note.paymentStatus),
    band: upbBucket(pool ? upb : Number(note.upb)),
    status: live ? "Live on the desk" : "In contract",
  };
}

const CARD_SELECT = {
  id: true,
  kind: true,
  sellerId: true,
  brokerId: true,
  status: true,
  visibility: true,
  launchAt: true,
  stalePausedAt: true,
  notes: { select: { city: true, state: true, lienPosition: true, paymentStatus: true, upb: true } },
} as const;

// The card for one listing as the public page would show it. The page's own rule for a signed-out visitor decides
// (lib/private-listings.ts), so a private listing or one in a forward-flow first look gets the generic card. A
// signed-in viewer must also pass their own check, so a buyer the seller excludes gets the generic card too.
export async function cardFacts(listingId: string, viewer?: ListingViewer, now = new Date()): Promise<CardFacts | null> {
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: CARD_SELECT });
  const facts = cardFactsOf(listing, now);
  if (!listing || !facts) return null;
  if (!(await canSeeListing(null, listing))) return null;
  if (viewer && !(await canSeeListing(viewer, listing))) return null;
  return facts;
}

// The pool's states for a line of text: the first few, then how many more.
export function statesLine(states: string[], most = 4) {
  return states.length > most ? `${states.slice(0, most).join(", ")} and ${states.length - most} more` : states.join(", ");
}

// The image's bundled font covers Latin-1 and common punctuation. Any other character would make the renderer fetch a
// font, so a letter outside that range loses its accent, and anything still outside is dropped.
const IN_FONT = /[ -~ -ÿ‐-‧−]/;
export function glyphs(text: string) {
  return [...text].map((char) => (IN_FONT.test(char) ? char : char.normalize("NFD").replace(/[^ -~]/g, ""))).join("");
}

// One sentence about the listing, in the public page's words.
export function shareSentence(facts: CardFacts) {
  if (facts.pool) return `A pool of ${facts.loans} loans across ${statesLine(facts.states)}. Total unpaid principal is in the ${facts.band} band.`;
  const lien = facts.lienPosition === "OTHER" ? "" : `${facts.lien.toLowerCase()}-lien `;
  return `A ${lien}${facts.payment.toLowerCase()} note in ${facts.place}. Unpaid principal is in the ${facts.band} band.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Links

// The site's own origin, as robots.txt and the sitemap name it.
export function siteOrigin() {
  return ((process.env.NEXT_PUBLIC_APP_URL || "").trim() || "http://127.0.0.1:4317").replace(/\/+$/, "");
}

// The base the teaser page's preview image resolves against, so the image link a social site reads is the live
// site's and not localhost.
export function siteBase(): URL | undefined {
  try {
    return new URL(siteOrigin());
  } catch {
    return undefined;
  }
}

// The link a seller shares. ref=share marks the visits it brings, which are counted below.
export function shareUrl(listingId: string, origin = siteOrigin()) {
  return `${origin}/open/${encodeURIComponent(listingId)}?ref=share`;
}

export type ShareLinks = { url: string; linkedin: string; x: string; email: string };

export function shareLinks(url: string, facts: CardFacts): ShareLinks {
  const sentence = shareSentence(facts);
  const subject = facts.pool ? `A pool of ${facts.loans} mortgage notes on UPB Capital` : `A mortgage note in ${facts.place} on UPB Capital`;
  const body = `${sentence} Verified buyers bid on UPB Capital.\n\n${url}`;
  return {
    url,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
    x: `https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(sentence)}`,
    email: `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Visits from shared links. Each is a page hit under its own path, so the count is per listing and the hit keeps
// nothing about who came: no account, no address, no browser.

export function sharedVisitPath(listingId: string) {
  return `/open/${listingId}?ref=share`;
}

// Link previews: the fetchers LinkedIn, X, Slack, Teams, iMessage and the rest send to read the card.
const PREVIEW_AGENT = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|whatsapp|headless|curl|wget|python|okhttp/i;

type Visit = {
  ref: string | string[] | undefined;
  userAgent: string | null | undefined;
  viewer: ListingViewer;
  listing: { sellerId: string; brokerId?: string | null };
};

// A visit counts when it came through a shared link, from a person's browser, and not from the listing's own side
// or the desk, whose opens are left out as the seller's buyer-interest counts leave them out.
export function countsAsSharedVisit({ ref, userAgent, viewer, listing }: Visit) {
  if ((Array.isArray(ref) ? ref[0] : ref) !== "share") return false;
  if (!userAgent || PREVIEW_AGENT.test(userAgent)) return false;
  if (viewer && (viewer.role === "ADMIN" || viewer.id === listing.sellerId || (Boolean(listing.brokerId) && viewer.id === listing.brokerId))) return false;
  return true;
}

export async function recordSharedVisit(listingId: string) {
  await recordHit(sharedVisitPath(listingId));
}

// For the teaser page, once it knows the visitor may see the listing. The hit is written after the page has gone out.
export async function noteSharedVisit(listing: Visit["listing"] & { id: string }, viewer: ListingViewer, ref: Visit["ref"]) {
  const userAgent = (await headers()).get("user-agent");
  if (countsAsSharedVisit({ ref, userAgent, viewer, listing })) after(() => recordSharedVisit(listing.id));
}

export async function sharedVisits(listingId: string) {
  return prisma.pageHit.count({ where: { path: sharedVisitPath(listingId) } });
}

// ---------------------------------------------------------------------------------------------------------------
// The share panel

export type SharePanel = { state: "private" } | ({ state: "public"; visits: number } & ShareLinks);

// What the share panel shows while a listing is live: the link and its share links, or, for a private listing, the
// line saying it has none. Nothing before go-live, while coming soon or paused, or after the sale, and nothing for a
// tranche still in its first look, whose public page isn't open yet.
export async function sharePanel(listing: CardListing, now = new Date()): Promise<SharePanel | null> {
  if (!liveListing(listing, now)) return null;
  if (isPrivateListing(listing)) return { state: "private" };
  const facts = cardFactsOf(listing, now);
  if (!facts) return null;
  const [open, visits] = await Promise.all([canSeeListing(null, listing), sharedVisits(listing.id)]);
  if (!open) return null;
  return { state: "public", visits, ...shareLinks(shareUrl(listing.id), facts) };
}
