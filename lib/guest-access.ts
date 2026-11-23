import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { GuestPass, User } from "@prisma/client";
import { accountLocked } from "@/lib/access";
import { canReadClosingFile, canReadDocument, isDeskOnlyDocument, ndaOpensRoom } from "@/lib/acl";
import { actionGate } from "@/lib/action-gates";
import { audit } from "@/lib/audit";
import { bidderNamer } from "@/lib/bidder-alias";
import { closingLoans, stepLabel } from "@/lib/closing";
import { closingClock, effectiveDue, targetDays } from "@/lib/closing-clock";
import { TEMPLATE_KEYS, TEMPLATE_LABELS, type TemplateKey } from "@/lib/closing-docs";
import { closingPacket } from "@/lib/closing-packet";
import { loadDealTimeline, timelineView, type TimelineSide } from "@/lib/closing-service";
import { dealAccess } from "@/lib/data-room";
import { keptWithinLimit, OLDEST_FIRST, unset } from "@/lib/db-filters";
import { demoAddress, demoSeatShut, isReleaseBuild } from "@/lib/deploy";
import { DEPOSIT_TIMELINE_ACTIONS } from "@/lib/deposits";
import { DESK_DENIED, deskCan } from "@/lib/desk-roles";
import { sendSecret } from "@/lib/email";
import { isENote } from "@/lib/enotes";
import { prettyDate } from "@/lib/format";
import { docLabel } from "@/lib/labels";
import { launchPending } from "@/lib/launch-rules";
import { deliverable } from "@/lib/mail-config";
import { prisma } from "@/lib/prisma";
import { canSeeListing } from "@/lib/private-listings";
import { consumeRateLimit } from "@/lib/rate-limit";
import { clientAddress } from "@/lib/request-meta";
import { documentGate } from "@/lib/room-access";
import { seatGate, type ActingUser } from "@/lib/seats";
import { getSettings, isPro } from "@/lib/settings";
import { getBytes } from "@/lib/storage";
import { deliveringSide, kindLabel, loanName, trailingStatusLabel } from "@/lib/trailing-docs";
import { attachmentName } from "@/lib/uploads";
import { bidderCopy } from "@/lib/watermark";

// Guest access. Every institutional trade has people outside UPB on it: each side's attorney, a title officer, a
// document custodian, an auditor. A guest pass is a link for one of them to read one closing, or one listing's data
// room, without an account. It opens only what the side that made it may open, nothing more: no bids, no wire
// instructions, no other party's identity records and no page outside its scope. It expires, either side's own people
// or the desk can end it, and every file it takes is stamped with the guest's name and logged against the pass. The
// link carries a random token and only its hash is kept, as invitations are (lib/seats.ts, lib/private-listings.ts).
// A guest is never signed in: the guest page and its downloads read and set no session.

export const GUEST_ROLES = ["ATTORNEY", "TITLE", "CUSTODIAN", "AUDITOR", "OTHER"] as const;
export type GuestRole = (typeof GUEST_ROLES)[number];
export type GuestSide = "BUYER" | "SELLER" | "DESK";

export const GUEST_ROLE_LABELS: Record<GuestRole, string> = {
  ATTORNEY: "Attorney",
  TITLE: "Title officer",
  CUSTODIAN: "Document custodian",
  AUDITOR: "Auditor",
  OTHER: "Other",
};

// How the role reads after a side: "Seller's attorney", "Buyer's title officer", "Desk's guest".
const ROLE_NOUNS: Record<GuestRole, string> = { ATTORNEY: "attorney", TITLE: "title officer", CUSTODIAN: "document custodian", AUDITOR: "auditor", OTHER: "guest" };

// The lengths a link may run, in days. Nothing here makes one longer than MAX_GUEST_DAYS.
export const GUEST_DAYS = [7, 14, 30] as const;
export const DEFAULT_GUEST_DAYS = 14;
export const MAX_GUEST_DAYS = 90;
// Live links one side may hold on one closing or one room. A buyer in a room counts alone: other bidders aren't its side.
export const LIVE_PASS_LIMIT = 10;
// Requests to the guest page and its files from one address in a minute.
export const GUEST_HITS_PER_MINUTE = 60;
// Links one account may send in an hour, so the desk's mail can't be used to write to strangers.
const CREATES_PER_HOUR = 20;
// The audit action a guest's download is logged under, with "{pass id} · {file}" as its detail.
export const GUEST_VIEW = "GUEST_VIEW";

const DAY = 24 * 60 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A room exists while the listing is filed, live, in contract or sold. A rejected or withdrawn listing has none.
const ROOM_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED", "PENDING", "SOLD"];
// Wire records stay off a guest's copy of the deal log: funds, deposits, proceeds, shares, wire changes and the
// deposit's outcome. The opening line, the steps, files, dates, custody and a cancel stay.
const WIRE_ACTIONS = ["FUNDS_RECEIVED", "DEPOSIT_RECEIVED", "PROCEEDS_SENT", "SHARE_FUNDED", "WIRE_EDIT", "CLOSING_OVERRIDE", ...DEPOSIT_TIMELINE_ACTIONS];
const STEP_ORDER = ["PURCHASE_AGREEMENT", "BUYER_DEPOSIT", "COLLATERAL_TRANSFER", "ASSIGNMENT", "PAYMENT_RECEIVED", "CLOSED"];

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string) => ({ ok: false as const, error });

export function isGuestRole(value: unknown): value is GuestRole {
  return typeof value === "string" && (GUEST_ROLES as readonly string[]).includes(value);
}

export function guestRoleLabel(role: string) {
  return isGuestRole(role) ? GUEST_ROLE_LABELS[role] : GUEST_ROLE_LABELS.OTHER;
}

export function guestRoleNoun(role: string) {
  return isGuestRole(role) ? ROLE_NOUNS[role] : ROLE_NOUNS.OTHER;
}

export function guestTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function guestLink(token: string, appUrl = process.env.NEXT_PUBLIC_APP_URL || "") {
  return `${appUrl}/guest/${token}`;
}

// The line every file a guest takes carries, inside the watermark's own "Confidential · … · date · UPB Capital".
export function guestHolder(pass: { name: string; role: string }) {
  return `Guest · ${pass.name} · ${guestRoleLabel(pass.role)}`;
}

export function passState(pass: { expiresAt: Date; revokedAt?: Date | null }, now = new Date()): "live" | "expired" | "revoked" {
  if (pass.revokedAt) return "revoked";
  return pass.expiresAt.getTime() <= now.getTime() ? "expired" : "live";
}

// The form's expiry: 7, 14 or 30 days, 14 when blank. Anything else is refused rather than rounded.
export function readGuestDays(raw: unknown): number | null {
  const text = String(raw ?? "").trim();
  if (!text) return DEFAULT_GUEST_DAYS;
  const days = Number(text);
  return (GUEST_DAYS as readonly number[]).includes(days) && days <= MAX_GUEST_DAYS ? days : null;
}

export function sideWord(side: string) {
  return side === "SELLER" ? "Seller" : side === "DESK" ? "Desk" : "Buyer";
}

// "Seller's attorney". `owner` names a buyer by its letter in a room the seller reads ("Bidder A's attorney").
export function guestTitle(pass: { side: string; role: string }, owner = sideWord(pass.side)) {
  return `${owner}'s ${guestRoleNoun(pass.role)}`;
}

// The stored hash is found by its unique index, then compared in constant time, so the answer's timing says nothing
// about how much of a guessed token was right.
function sameHash(stored: string, computed: string) {
  const a = Buffer.from(stored, "hex");
  const b = Buffer.from(computed, "hex");
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------------------------------------------
// What a pass opens, and whose side each person is on.

type ClosingScope = NonNullable<Awaited<ReturnType<typeof loadClosingScope>>>;
type RoomListing = NonNullable<Awaited<ReturnType<typeof loadRoom>>>;

async function loadClosingScope(closingId: string) {
  const closing = await prisma.closing.findUnique({
    where: { id: closingId },
    select: { id: true, status: true, canceledAt: true, listingId: true, inquiryId: true, deskBidId: true, listing: { select: { id: true, title: true, sellerId: true, brokerId: true } }, funders: { select: { userId: true } } },
  });
  if (!closing) return null;
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, select: { buyerId: true } }) : null;
  // The lead buyer and every group seat are the buyer side. On a desk purchase the desk is.
  const buyerIds = [inquiry?.buyerId, ...closing.funders.map((funder) => funder.userId)].filter((id): id is string => Boolean(id));
  return { closing, buyerIds };
}

function loadRoom(listingId: string) {
  return prisma.listing.findUnique({
    where: { id: listingId },
    select: { id: true, title: true, sellerId: true, brokerId: true, status: true, launchAt: true, visibility: true, authorizationKey: true },
  });
}

// A closing's sides are its parties: the seller, the buyer side, and the desk. A broker watching the deal is neither.
function closingSideOf(viewer: { id: string; role: string }, scope: ClosingScope): GuestSide | null {
  if (viewer.role === "ADMIN") return "DESK";
  if (viewer.id === scope.closing.listing.sellerId) return "SELLER";
  if (scope.buyerIds.includes(viewer.id)) return "BUYER";
  return null;
}

// Whether a buyer has this room open, by the rules the download route applies to a file anyone in the room may open
// (lib/room-access.ts documentGate): not before launch, not on a listing hidden from them, and an NDA that opens the
// room with Pro, or a closing on the listing. Each file a guest takes still goes through documentGate itself.
async function buyerRoomOpen(user: User, listing: RoomListing) {
  if (user.role !== "BUYER" || launchPending(listing)) return false;
  if (!(await canSeeListing(user, listing))) return false;
  const [nda, deal] = await Promise.all([
    prisma.ndaAcknowledgment.findUnique({ where: { userId_listingId: { userId: user.id, listingId: listing.id } } }),
    dealAccess(listing.id, user.id),
  ]);
  const closingParty = deal.whole || deal.loans.size > 0;
  return canReadDocument({
    owner: false,
    admin: false,
    ownNda: false,
    privateFile: false,
    proBuyer: user.accountStatus === "APPROVED" && isPro(user),
    signedNda: ndaOpensRoom(nda),
    listingStatus: listing.status,
    closingParty,
  });
}

// A room's sides: the seller and the broker of record, the desk, and each buyer with the room open, alone.
async function roomSideOf(viewer: User, listing: RoomListing): Promise<GuestSide | null> {
  if (viewer.role === "ADMIN") return "DESK";
  if (viewer.id === listing.sellerId || (Boolean(listing.brokerId) && viewer.id === listing.brokerId)) return "SELLER";
  return (await buyerRoomOpen(viewer, listing)) ? "BUYER" : null;
}

// Why this person can't add a guest here, or null. A view-only seat commits to nothing (lib/seats.ts), and an account
// that hasn't confirmed its email sends no mail to strangers (lib/email-confirm.ts).
async function addBlock(actor: ActingUser, side: GuestSide, kind: "closing" | "room", open: boolean) {
  if (!open) return kind === "closing" ? "This closing was canceled, so it takes no outside parties." : "This listing's room is closed, so it takes no outside parties.";
  if (side === "DESK" && !deskCan(actor, kind === "closing" ? "closings" : "sales")) return DESK_DENIED;
  return actionGate(actor, "message");
}

// The live passes that count against this side's limit here.
function liveWhere(scope: { closingId: string } | { listingId: string }, side: GuestSide, creatorId: string, now: Date) {
  return {
    ...scope,
    side,
    // A buyer in a room is its own side: other bidders' guests aren't counted against it.
    ...("listingId" in scope && side === "BUYER" ? { createdById: creatorId } : {}),
    expiresAt: { gt: now },
    ...unset("revokedAt"),
  };
}

// Whose side a person is on for one room pass. A buyer counts only for its own pass, even after its own access closed.
function roomPassSide(viewer: { id: string; role: string }, listing: { sellerId: string; brokerId: string | null }, pass: { createdById: string }): GuestSide | null {
  if (viewer.role === "ADMIN") return "DESK";
  if (viewer.id === listing.sellerId || (Boolean(listing.brokerId) && viewer.id === listing.brokerId)) return "SELLER";
  return viewer.id === pass.createdById ? "BUYER" : null;
}

// The side that made a pass may end it. In a room a buyer's pass is that buyer's alone. The desk ends any.
function ownsPass(viewer: { id: string }, viewerSide: GuestSide | null, pass: Pick<GuestPass, "side" | "listingId" | "createdById">) {
  if (!viewerSide || viewerSide === "DESK") return viewerSide === "DESK";
  if (pass.side !== viewerSide) return false;
  return pass.side === "BUYER" && pass.listingId ? pass.createdById === viewer.id : true;
}

// ---------------------------------------------------------------------------------------------------------------
// Adding and ending a pass.

export type GuestInput = { closingId?: string | null; listingId?: string | null; name: unknown; email: unknown; role: unknown; days?: unknown; now?: Date };

export async function createGuestPass(actor: ActingUser, input: GuestInput): Promise<Outcome<{ passId: string; token: string; expiresAt: Date }>> {
  const now = input.now ?? new Date();
  const closingId = input.closingId || null;
  const listingId = input.listingId || null;
  if (Boolean(closingId) === Boolean(listingId)) return fail("Choose the closing or the data room the guest may read.");
  let side: GuestSide | null;
  let title: string;
  let kind: "closing" | "room";
  let block: string | null;
  if (closingId) {
    const scope = await loadClosingScope(closingId);
    if (!scope) return fail("That closing isn't here.");
    side = closingSideOf(actor, scope);
    if (!side) return fail("Only the buyer, the seller and the desk on this closing can add outside parties.");
    kind = "closing";
    title = scope.closing.listing.title;
    block = await addBlock(actor, side, kind, scope.closing.status !== "CANCELED");
  } else {
    const listing = await loadRoom(listingId!);
    if (!listing) return fail("That listing isn't here.");
    side = await roomSideOf(actor, listing);
    if (!side) return fail("Only the seller, the broker of record, the desk and a buyer with the room open can add outside parties.");
    kind = "room";
    title = listing.title;
    block = await addBlock(actor, side, kind, ROOM_STATUSES.includes(listing.status));
  }
  if (block) return fail(block);

  const name = String(input.name ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const email = String(input.email ?? "").trim().toLowerCase();
  if (name.length < 2) return fail("Enter the guest's name.");
  if (!EMAIL.test(email) || email.length > 200) return fail("Enter a valid email for the guest.");
  const role = isGuestRole(input.role) ? input.role : null;
  if (!role) return fail("Choose attorney, title officer, document custodian, auditor or other.");
  const days = readGuestDays(input.days);
  if (days == null) return fail("Choose 7, 14 or 30 days.");
  if (demoAddress(email)) return fail("That address is for the demo desk. Use the guest's own email.");
  if (process.env.DESK_EMAIL && email === process.env.DESK_EMAIL.trim().toLowerCase()) return fail("That address belongs to the desk.");
  if (isReleaseBuild(process.env) && !deliverable(email)) return fail("That address can't receive mail.");

  const scopeWhere = closingId ? { closingId } : { listingId: listingId! };
  const live = await prisma.guestPass.findMany({ where: liveWhere(scopeWhere, side, actor.id, now), select: { email: true } });
  const here = kind === "closing" ? "closing" : "room";
  if (live.some((row) => row.email === email)) return fail(`That address already has a live link on this ${here}. End it first to send a new one.`);
  if (live.length >= LIVE_PASS_LIMIT) return fail(`Your side has ${LIVE_PASS_LIMIT} live guest links on this ${here}. End one before adding another.`);
  if (!(await consumeRateLimit(`guest-pass:${actor.id}`, CREATES_PER_HOUR, 60 * 60 * 1000, now.getTime()))) {
    return fail("Too many guest links this hour. Wait and try again.");
  }

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + Math.min(days, MAX_GUEST_DAYS) * DAY);
  const pass = await prisma.guestPass.create({
    data: { tokenHash: guestTokenHash(token), ...scopeWhere, name, email, role, side, createdById: actor.id, expiresAt },
  });
  // Links sent at once can each pass the checks above. Counted again with this one in, before its email goes, a second
  // for the same address or one past the side's limit comes back out (lib/db-filters.ts).
  const rivals = (extra: { email?: string }) => () => prisma.guestPass.findMany({ where: { ...liveWhere(scopeWhere, side, actor.id, now), ...extra }, select: { id: true }, orderBy: OLDEST_FIRST });
  const over = !(await keptWithinLimit(pass.id, 1, rivals({ email })))
    ? `That address already has a live link on this ${here}. End it first to send a new one.`
    : !(await keptWithinLimit(pass.id, LIVE_PASS_LIMIT, rivals({})))
      ? `Your side has ${LIVE_PASS_LIMIT} live guest links on this ${here}. End one before adding another.`
      : null;
  if (over) {
    await prisma.guestPass.deleteMany({ where: { id: pass.id } });
    return fail(over);
  }
  const from = side === "DESK" ? "The UPB Capital desk" : actor.companyName || actor.name;
  const reads = kind === "closing"
    ? `the closing of ${title} on UPB Capital: its steps, its documents, the trailing documents and the deal log`
    : `the files in the data room for ${title} on UPB Capital that ${side === "SELLER" ? "the seller" : side === "DESK" ? "the desk" : "they"} may open`;
  await sendSecret(
    email,
    `Guest access · ${title}`,
    [
      `${from} invited you, as ${side === "DESK" ? "its" : "their"} ${ROLE_NOUNS[role]}, to read ${reads}. You don't need an account.`,
      `Open this link until ${prettyDate(expiresAt)}:`,
      guestLink(token),
      "Each file you download carries your name and is logged. Anyone with the link can open it, so keep it to yourself. If you weren't expecting this, ignore it.",
    ].join("\n\n"),
  );
  await audit(actor.id, "GUEST_PASS_CREATED", kind === "closing" ? "closing" : "listing", closingId ?? listingId!, `${pass.id} · ${guestTitle(pass)} · ${name} · until ${pass.expiresAt.toISOString().slice(0, 10)}`, actor.actor?.id ?? null);
  return { ok: true, value: { passId: pass.id, token, expiresAt } };
}

export async function revokeGuestPass(actor: ActingUser, passId: string, now = new Date()): Promise<Outcome<{ changed: boolean; closingId: string | null; listingId: string | null }>> {
  const pass = await prisma.guestPass.findUnique({ where: { id: passId } });
  if (!pass) return fail("That guest link isn't here.");
  let side: GuestSide | null = null;
  if (pass.closingId) {
    const scope = await loadClosingScope(pass.closingId);
    side = scope ? closingSideOf(actor, scope) : null;
  } else if (pass.listingId) {
    const listing = await loadRoom(pass.listingId);
    side = listing ? roomPassSide(actor, listing, pass) : null;
  }
  if (!ownsPass(actor, side, pass)) return fail("Only the side that added this guest, or the desk, can end the link.");
  if (side === "DESK" && !deskCan(actor, pass.closingId ? "closings" : "sales")) return fail(DESK_DENIED);
  const seat = await seatGate(actor, "message");
  if (seat) return fail(seat);
  const value = { closingId: pass.closingId, listingId: pass.listingId };
  if (passState(pass, now) !== "live") return { ok: true, value: { changed: false, ...value } };
  const done = await prisma.guestPass.updateMany({ where: { id: pass.id, ...unset("revokedAt") }, data: { revokedAt: now } });
  if (done.count !== 1) return { ok: true, value: { changed: false, ...value } };
  await audit(actor.id, "GUEST_PASS_REVOKED", pass.closingId ? "closing" : "listing", pass.closingId ?? pass.listingId ?? "", `${pass.id} · ${guestTitle(pass)} · ${pass.name}`, actor.actor?.id ?? null);
  return { ok: true, value: { changed: true, ...value } };
}

// ---------------------------------------------------------------------------------------------------------------
// The "Outside parties" section: each pass on a closing or a room as one viewer may read it. The side that added a
// guest, and the desk, see the email, the expiry and when it was last used. The other side sees the name and role
// and when it was added or ended, never the email.

export type OutsideRow = {
  id: string;
  scope: "closing" | "room";
  side: GuestSide;
  title: string;
  name: string;
  roleLabel: string;
  email: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  state: "live" | "expired" | "revoked";
  endedAt: Date | null;
  own: boolean;
  canRevoke: boolean;
};

export type OutsideParties = {
  side: GuestSide;
  rows: OutsideRow[];
  // The add forms this viewer gets: a guest for the closing, for the listing's room, or both.
  forms: { closing: boolean; room: boolean };
  // Why no form shows, for a party who can't add a guest (a view-only seat, a canceled closing).
  block: string | null;
};

export async function outsideParties(viewer: ActingUser, scope: { closingId: string; listingId: string } | { listingId: string }, now = new Date()): Promise<OutsideParties | null> {
  const listing = await loadRoom(scope.listingId);
  if (!listing) return null;
  const roomSide = await roomSideOf(viewer, listing);
  const roomBlock = roomSide ? await addBlock(viewer, roomSide, "room", ROOM_STATUSES.includes(listing.status)) : "";
  const seatOk = !(await seatGate(viewer, "message"));
  let side: GuestSide;
  let passes: GuestPass[];
  let forms: OutsideParties["forms"];
  let block: string | null;
  // In the seller's view of the room, buyers are named the way the rest of its page names them: by letter until an award.
  let namer: ((buyer: { id: string; name: string; companyName: string }) => string) | null = null;
  // A canceled closing ended its own links when it was canceled, whatever their dates say.
  let canceledAt: Date | null = null;
  if ("closingId" in scope) {
    const found = await loadClosingScope(scope.closingId);
    if (!found || found.closing.listingId !== listing.id) return null;
    const closingSide = closingSideOf(viewer, found);
    if (!closingSide) return null;
    side = closingSide;
    const live = found.closing.status !== "CANCELED";
    if (!live) canceledAt = found.closing.canceledAt ?? now;
    const closingBlock = await addBlock(viewer, side, "closing", live);
    // The room form sits here only while the deal is live. A canceled deal's sides add room guests from the listing.
    forms = { closing: !closingBlock, room: live && !roomBlock && Boolean(roomSide) };
    block = forms.closing || forms.room ? null : closingBlock;
    // The closing's own passes, and the room passes this deal's own sides made on its listing.
    passes = await prisma.guestPass.findMany({
      where: {
        OR: [
          { closingId: found.closing.id },
          { listingId: listing.id, side: { in: ["SELLER", "DESK"] } },
          ...(found.buyerIds.length ? [{ listingId: listing.id, side: "BUYER", createdById: { in: found.buyerIds } }] : []),
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 60,
    });
  } else {
    // The seller's view of its room. A buyer reads its own guests on its closing.
    if (roomSide !== "SELLER" && roomSide !== "DESK") return null;
    side = roomSide;
    forms = { closing: false, room: !roomBlock };
    block = roomBlock || null;
    passes = await prisma.guestPass.findMany({ where: { listingId: listing.id }, orderBy: { createdAt: "desc" }, take: 60 });
    namer = await bidderNamer(listing.id, viewer);
  }
  const buyerCreators = [...new Set(passes.filter((pass) => pass.side === "BUYER").map((pass) => pass.createdById))];
  const creators = new Map(
    (namer && buyerCreators.length ? await prisma.user.findMany({ where: { id: { in: buyerCreators } }, select: { id: true, name: true, companyName: true } }) : []).map((row) => [row.id, row]),
  );
  const desk = viewer.role === "ADMIN";
  const rows = passes.map((pass): OutsideRow => {
    const state = canceledAt && pass.closingId && passState(pass, now) === "live" ? "revoked" : passState(pass, now);
    const own = ownsPass(viewer, pass.listingId ? roomPassSide(viewer, listing, pass) : side, pass);
    const canRevoke = state === "live" && own && seatOk && (!desk || deskCan(viewer, pass.closingId ? "closings" : "sales"));
    const creator = pass.side === "BUYER" ? creators.get(pass.createdById) : undefined;
    return {
      id: pass.id,
      scope: pass.closingId ? "closing" : "room",
      side: pass.side as GuestSide,
      title: guestTitle(pass, namer && creator ? namer(creator) : sideWord(pass.side)),
      name: pass.name,
      roleLabel: guestRoleLabel(pass.role),
      email: own ? pass.email : null,
      createdAt: pass.createdAt,
      expiresAt: own ? pass.expiresAt : null,
      lastUsedAt: own ? pass.lastUsedAt ?? null : null,
      state,
      endedAt: state === "revoked" ? pass.revokedAt ?? (pass.closingId ? canceledAt : null) : state === "expired" ? pass.expiresAt : null,
      own,
      canRevoke,
    };
  });
  // Live links first, then the ones that ended, newest first within each.
  rows.sort((a, b) => Number(a.state !== "live") - Number(b.state !== "live") || b.createdAt.getTime() - a.createdAt.getTime());
  return { side, rows, forms, block };
}

// ---------------------------------------------------------------------------------------------------------------
// Opening a pass: the guest page and the downloads.

type Resolved =
  | { state: "ended" }
  | { state: "limited" }
  | { state: "closing"; pass: GuestPass; creator: User; scope: ClosingScope }
  | { state: "room"; pass: GuestPass; creator: User; listing: RoomListing };

// One look-up for the page and every download. An unknown, expired or revoked link, a canceled closing, a closed room,
// or an inviting party who no longer has the access it shared all read the same: the link has ended, nothing more.
async function resolvePass(token: string, ip: string, now: Date): Promise<Resolved> {
  if (!(await consumeRateLimit(`guest:${ip}`, GUEST_HITS_PER_MINUTE, 60 * 1000, now.getTime()))) return { state: "limited" };
  if (!/^[0-9a-f]{64}$/.test(token)) return { state: "ended" };
  const hash = guestTokenHash(token);
  const pass = await prisma.guestPass.findUnique({ where: { tokenHash: hash } });
  if (!pass || !sameHash(pass.tokenHash, hash) || passState(pass, now) !== "live") return { state: "ended" };
  const creator = await prisma.user.findUnique({ where: { id: pass.createdById } });
  // A demo seat's links end with its sign-in on a public origin (lib/deploy.ts demoSeatShut).
  if (!creator || accountLocked(creator.accountStatus) || creator.deletedAt || demoSeatShut(creator.email)) return { state: "ended" };
  let resolved: Resolved = { state: "ended" };
  if (pass.closingId && !pass.listingId) {
    const scope = await loadClosingScope(pass.closingId);
    // A canceled closing ends its passes. The inviting party must still be on the side it invited for.
    if (scope && scope.closing.status !== "CANCELED" && closingSideOf(creator, scope) === pass.side) resolved = { state: "closing", pass, creator, scope };
  } else if (pass.listingId && !pass.closingId) {
    const listing = await loadRoom(pass.listingId);
    if (listing && ROOM_STATUSES.includes(listing.status) && (await roomSideOf(creator, listing)) === pass.side) resolved = { state: "room", pass, creator, listing };
  }
  if (resolved.state !== "ended") await prisma.guestPass.update({ where: { id: pass.id }, data: { lastUsedAt: now } });
  return resolved;
}

export type GuestClosingView = {
  title: string;
  parties: string;
  status: string;
  target: Date | null;
  closedAt: Date | null;
  steps: { key: string; label: string; done: boolean; completedAt: Date | null; due: Date | null }[];
  files: { id: string; name: string; step: string; at: Date }[];
  papers: { kind: TemplateKey; label: string }[];
  trailing: { id: string; label: string; loan: string | null; from: string; status: string; dueAt: Date; sentAt: Date | null; receivedAt: Date | null }[];
  timeline: ReturnType<typeof timelineView>;
};

export type GuestRoomView = { title: string; files: { id: string; label: string; name: string; loan: string | null }[] };

type Invitation = { inviter: string; side: GuestSide; role: string; name: string; expiresAt: Date };

export type GuestOpening =
  | { state: "ended" }
  | { state: "limited" }
  | ({ state: "closing"; view: GuestClosingView } & Invitation)
  | ({ state: "room"; view: GuestRoomView } & Invitation);

// Who invited the guest, in words: the firm, the seller's broker, or the desk.
function inviterOf(pass: GuestPass, creator: User, listing: { brokerId: string | null }) {
  if (pass.side === "DESK") return "The UPB Capital desk";
  const name = creator.companyName || creator.name;
  if (pass.side === "SELLER") return listing.brokerId === creator.id ? `${name} (the seller's broker)` : `${name} (the seller)`;
  return `${name} (the buyer)`;
}

const timelineSide = (side: string): TimelineSide => (side === "DESK" ? "desk" : side === "SELLER" ? "seller" : "buyer");

// The room's files a guest may take: what the inviting party may open under documentGate, less the records that
// are never a guest's to read: signed NDAs (other bidders' signatures), the broker's mandate and the seller's
// authorization. Photos show on the listing, not in the room.
function guestListable(document: { type: string; storedName: string }, listing: { authorizationKey: string }) {
  if (document.type === "PHOTO" || document.type === "NDA" || isDeskOnlyDocument(document)) return false;
  return !(listing.authorizationKey !== "" && document.storedName === listing.authorizationKey);
}

async function roomView(creator: User, listing: RoomListing): Promise<GuestRoomView> {
  const documents = await prisma.document.findMany({
    where: { listingId: listing.id, type: { notIn: ["PHOTO", "NDA", "MANDATE"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, type: true, originalName: true, storedName: true, noteId: true },
  });
  const listable = documents.filter((document) => guestListable(document, listing));
  const gates = await Promise.all(listable.map((document) => documentGate(creator, document.id)));
  const open = listable.filter((_, index) => gates[index].allowed);
  const noteIds = [...new Set(open.map((document) => document.noteId).filter((id): id is string => Boolean(id)))];
  const notes = noteIds.length ? await prisma.note.findMany({ where: { id: { in: noteIds } }, select: { id: true, city: true, state: true } }) : [];
  const place = new Map(notes.map((note) => [note.id, `${note.city}, ${note.state}`]));
  return {
    title: listing.title,
    files: open.map((document) => ({ id: document.id, label: docLabel(document.type), name: document.originalName, loan: document.noteId ? place.get(document.noteId) ?? null : null })),
  };
}

async function closingView(pass: GuestPass, scope: ClosingScope, now: Date): Promise<GuestClosingView> {
  const closing = await prisma.closing.findUniqueOrThrow({
    where: { id: scope.closing.id },
    include: {
      listing: { include: { seller: { select: { name: true, companyName: true } }, notes: { select: { id: true, streetAddress: true, city: true, state: true, eNote: true } } } },
      steps: { include: { files: { orderBy: { createdAt: "asc" } } } },
      funders: { select: { userId: true } },
      trailingDocs: { orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }] },
    },
  });
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, select: { buyer: { select: { name: true, companyName: true } } } }) : null;
  const settings = await getSettings();
  const days = targetDays(settings.closingTargetDays);
  const steps = [...closing.steps].sort((a, b) => STEP_ORDER.indexOf(a.key) - STEP_ORDER.indexOf(b.key));
  const clock = closingClock(closing, steps, days, now);
  const buyer = closing.deskBidId ? "UPB Capital" : closing.funders.length > 1 ? "A buying group" : inquiry?.buyer.companyName || inquiry?.buyer.name || "The buyer";
  const loans = closingLoans(closing, closing.listing.notes);
  const papers: TemplateKey[] = ["PSA", "ASSIGNMENT", ...(loans.some((note) => !isENote(note)) ? (["ALLONGE", "LOST_NOTE_AFFIDAVIT"] as const) : []), ...(closing.depositCents != null ? (["DEPOSIT_AGREEMENT"] as const) : [])];
  // The side's own copy of the deal log, less its wire records and the messages between the parties and the desk.
  const [loaded, wires] = await Promise.all([
    loadDealTimeline(closing.id, timelineSide(pass.side), now),
    prisma.auditEvent.findMany({ where: { entityType: "closing", entityId: closing.id, action: { in: WIRE_ACTIONS } }, select: { id: true } }),
  ]);
  const hidden = new Set(wires.map((event) => `audit:${event.id}`));
  const entries = (loaded?.entries ?? []).filter((entry) => !hidden.has(entry.id) && !entry.id.startsWith("wire:") && !entry.id.startsWith("post:"));
  return {
    title: closing.listing.title,
    parties: `${buyer} buying from ${closing.listing.seller.companyName || closing.listing.seller.name}`,
    status: closing.status,
    target: closing.status === "OPEN" ? clock.target : null,
    closedAt: closing.closedAt,
    steps: steps.map((step) => ({
      key: step.key,
      label: stepLabel(step.key),
      done: step.status === "COMPLETE",
      completedAt: step.completedAt,
      due: closing.status === "OPEN" && step.status !== "COMPLETE" ? effectiveDue(step, closing, days) : null,
    })),
    files: steps.flatMap((step) => step.files.map((file) => ({ id: file.id, name: file.originalName, step: stepLabel(step.key), at: file.createdAt }))),
    papers: papers.map((kind) => ({ kind, label: TEMPLATE_LABELS[kind] })),
    trailing: closing.trailingDocs.map((doc) => ({
      id: doc.id,
      label: kindLabel(doc.kind),
      loan: loanName(closing.listing.notes, doc.noteId),
      from: sideWord(deliveringSide(doc).toUpperCase()),
      status: trailingStatusLabel(doc.status),
      dueAt: doc.dueAt,
      sentAt: doc.sentAt,
      receivedAt: doc.receivedAt,
    })),
    timeline: timelineView({ entries, upcoming: loaded?.upcoming ?? [] }),
  };
}

// The guest page. `ip` is the caller's address, for the rate limit.
export async function openGuestPass(token: string, input: { ip: string; now?: Date }): Promise<GuestOpening> {
  const now = input.now ?? new Date();
  const resolved = await resolvePass(token, input.ip, now);
  if (resolved.state === "ended" || resolved.state === "limited") return resolved;
  const { pass, creator } = resolved;
  if (resolved.state === "closing") {
    const invitation = { inviter: inviterOf(pass, creator, resolved.scope.closing.listing), side: pass.side as GuestSide, role: pass.role, name: pass.name, expiresAt: pass.expiresAt };
    return { state: "closing", view: await closingView(pass, resolved.scope, now), ...invitation };
  }
  const invitation = { inviter: inviterOf(pass, creator, resolved.listing), side: pass.side as GuestSide, role: pass.role, name: pass.name, expiresAt: pass.expiresAt };
  return { state: "room", view: await roomView(creator, resolved.listing), ...invitation };
}

// ---------------------------------------------------------------------------------------------------------------
// Downloads. Each is stamped with the guest's line, whoever invited them, and logged as a guest view naming the pass.
// No session is read or set.

const PLAIN = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" };

function refused(resolved: Resolved) {
  if (resolved.state === "limited") return new Response("Too many requests. Wait a minute and try again.", { status: 429, headers: PLAIN });
  return new Response("This link has ended.", { status: 403, headers: PLAIN });
}

const notFound = () => new Response("Not found.", { status: 404, headers: PLAIN });

async function stamped(file: { type: string; mime: string; originalName: string }, bytes: Uint8Array, pass: GuestPass, now: Date) {
  const copy = await bidderCopy(file, bytes, guestHolder(pass), now);
  if (copy.failed) console.warn(`[upb-guest] a file on pass ${pass.id} did not parse as a PDF, so it went out without a watermark.`);
  return new Response(new Uint8Array(copy.bytes), {
    headers: {
      "Content-Type": file.mime,
      "Content-Disposition": `attachment; filename="${attachmentName(file.originalName)}"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function requestIp(request: Request) {
  return clientAddress(request.headers.get("x-forwarded-for"), request.headers.get("x-real-ip"));
}

// A room file, from the room's own download route (app/api/documents/[id]) when the link carries ?guest=. The file
// opens only under documentGate for the party that made the pass.
export async function guestDocumentDownload(token: string, documentId: string, request: Request, now = new Date()) {
  const resolved = await resolvePass(token, requestIp(request), now);
  if (resolved.state !== "room") return refused(resolved);
  const { document, allowed } = await documentGate(resolved.creator, documentId);
  if (!document || document.listingId !== resolved.listing.id || !guestListable(document, resolved.listing)) return notFound();
  if (!allowed) return new Response("This file isn't open to your link.", { status: 403, headers: PLAIN });
  let bytes: Uint8Array;
  try {
    bytes = await getBytes(document.storedName);
  } catch {
    return notFound();
  }
  const response = await stamped(document, bytes, resolved.pass, now);
  await audit(null, GUEST_VIEW, "listing", document.listingId, `${resolved.pass.id} · ${document.originalName}`);
  return response;
}

// A file on one of the closing's steps.
export async function guestClosingFileDownload(token: string, fileId: string, request: Request, now = new Date()) {
  const resolved = await resolvePass(token, requestIp(request), now);
  if (resolved.state !== "closing") return refused(resolved);
  const file = await prisma.closingFile.findUnique({ where: { id: fileId }, include: { step: { select: { closingId: true } } } });
  if (!file || file.step.closingId !== resolved.scope.closing.id) return notFound();
  const { creator, scope } = resolved;
  if (!canReadClosingFile({ role: creator.role, userId: creator.id, sellerId: scope.closing.listing.sellerId, buyerId: null, funderIds: scope.buyerIds })) return notFound();
  let bytes: Uint8Array;
  try {
    bytes = await getBytes(file.storageKey);
  } catch {
    return notFound();
  }
  const response = await stamped({ type: "CLOSING", mime: file.mime, originalName: file.originalName }, bytes, resolved.pass, now);
  await audit(null, GUEST_VIEW, "closing", scope.closing.id, `${resolved.pass.id} · ${file.originalName}`);
  return response;
}

// One of the closing's papers, filled from the closing as the inviting party would get it (lib/closing-packet.ts).
export async function guestPaperDownload(token: string, kind: string, request: Request, now = new Date()) {
  const resolved = await resolvePass(token, requestIp(request), now);
  if (resolved.state !== "closing") return refused(resolved);
  if (!(TEMPLATE_KEYS as readonly string[]).includes(kind)) return notFound();
  const packet = await closingPacket(resolved.scope.closing.id, kind as TemplateKey, resolved.creator);
  if (!packet || !packet.allowed) return notFound();
  const name = `${kind.toLowerCase()}.pdf`;
  const response = await stamped({ type: "CLOSING", mime: "application/pdf", originalName: name }, packet.pdf, resolved.pass, now);
  await audit(null, GUEST_VIEW, "closing", resolved.scope.closing.id, `${resolved.pass.id} · ${TEMPLATE_LABELS[kind as TemplateKey]}`);
  return response;
}

// Guest downloads from one room, oldest first, for the room's access log (lib/access-log.ts). A buyer's guest
// carries the buyer, so the log can name it the way it names the buyer's own downloads.
export async function guestRoomViews(listingId: string) {
  const events = await prisma.auditEvent.findMany({ where: { entityType: "listing", entityId: listingId, action: GUEST_VIEW }, orderBy: { createdAt: "asc" }, take: 2000 });
  if (!events.length) return [];
  const parsed = events.map((event) => {
    const cut = event.detail.indexOf(" · ");
    return { at: event.createdAt, passId: cut > 0 ? event.detail.slice(0, cut) : event.detail, file: cut > 0 ? event.detail.slice(cut + 3) : "" };
  });
  const passes = await prisma.guestPass.findMany({ where: { id: { in: [...new Set(parsed.map((row) => row.passId))] } }, select: { id: true, side: true, name: true, role: true, createdById: true } });
  const buyerIds = [...new Set(passes.filter((pass) => pass.side === "BUYER").map((pass) => pass.createdById))];
  const buyers = new Map((buyerIds.length ? await prisma.user.findMany({ where: { id: { in: buyerIds } }, select: { id: true, name: true, companyName: true, role: true } }) : []).map((row) => [row.id, row]));
  const byId = new Map(passes.map((pass) => [pass.id, pass]));
  return parsed.flatMap((row) => {
    const pass = byId.get(row.passId);
    if (!pass) return [];
    return [{ ...row, side: pass.side, name: pass.name, role: guestRoleLabel(pass.role), createdById: pass.createdById, buyer: pass.side === "BUYER" ? buyers.get(pass.createdById) ?? null : null }];
  });
}
