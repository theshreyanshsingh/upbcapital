import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { canManageRoom } from "@/lib/acl";
import { audit } from "@/lib/audit";
import { unset } from "@/lib/db-filters";
import { notify } from "@/lib/email";
import { prisma } from "@/lib/prisma";

// A private listing shows only to the buyers its seller or the desk invited. Anything that lists or announces
// listings to people who weren't invited (the marketplace, search, roundups, matching, the public index,
// announcements) filters with publicListing.
export const PRIVATE = "PRIVATE";

export function isPrivateListing(listing: { visibility?: string | null }) {
  return listing.visibility === PRIVATE;
}

// Public listings: visibility never set, null, or anything but PRIVATE. Merge it into a where with AND.
export function publicListing(): Prisma.ListingWhereInput {
  return { OR: [{ visibility: { isSet: false } }, { visibility: null }, { visibility: { not: PRIVATE } }] };
}

// ---------------------------------------------------------------------------------------------------------------
// Who sees a listing. The desk sees every one, and a listing's own seller and filing broker see theirs. A buyer a
// seller excludes sees none of that seller's listings, public or private, and nothing tells them why: the listing
// just isn't there. Anyone else sees a public listing, and a private one only on an open invitation or as a party
// to its closing. Every list, search, alert and bid path asks here, so the rules live in one place.

export type ListingViewer = { id: string; role: string } | null | undefined;
type Shown = { id: string; sellerId: string; brokerId?: string | null; visibility?: string | null };
type Person = { id: string; email: string; companies: string[] };
type ExclusionRow = { sellerId: string; buyerId: string | null; email: string | null; company: string | null };

export function normalEmail(email: string) {
  return email.trim().toLowerCase();
}

// "Acme Capital, LLC" and "acme capital llc" are the same buyer.
export function normalCompany(name: string) {
  return name.toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
}

function companiesOf(names: (string | null | undefined)[]) {
  return [...new Set(names.map((name) => normalCompany(name ?? "")).filter(Boolean))];
}

// An exclusion matches by account, by email or by company name, whatever the case.
export function excludes(row: ExclusionRow, person: Person) {
  if (row.buyerId && row.buyerId === person.id) return true;
  if (row.email && person.email && normalEmail(row.email) === normalEmail(person.email)) return true;
  const company = row.company ? normalCompany(row.company) : "";
  return Boolean(company) && person.companies.includes(company);
}

// The names a buyer goes by: the account's company, the vetted entity on their file, and their buying entities.
export async function peopleOf(users: { id: string; email: string; companyName?: string | null }[]): Promise<Person[]> {
  if (!users.length) return [];
  const ids = users.map((user) => user.id);
  const [profiles, entities] = await Promise.all([
    prisma.buyerProfile.findMany({ where: { userId: { in: ids } }, select: { userId: true, entityName: true } }),
    prisma.buyerEntity.findMany({ where: { userId: { in: ids } }, select: { userId: true, name: true } }),
  ]);
  return users.map((user) => ({
    id: user.id,
    email: user.email,
    companies: companiesOf([
      user.companyName,
      ...profiles.filter((row) => row.userId === user.id).map((row) => row.entityName),
      ...entities.filter((row) => row.userId === user.id).map((row) => row.name),
    ]),
  }));
}

// Buyers who won a bid on the listing or fund its closing keep it after it goes private.
async function closingParties(listingIds: string[]) {
  if (!listingIds.length) return new Map<string, Set<string>>();
  const [won, funded] = await Promise.all([
    prisma.inquiry.findMany({ where: { listingId: { in: listingIds }, status: "ACCEPTED" }, select: { listingId: true, buyerId: true } }),
    prisma.closingFunder.findMany({ where: { closing: { listingId: { in: listingIds } } }, select: { userId: true, closing: { select: { listingId: true } } } }),
  ]);
  const parties = new Map<string, Set<string>>();
  const add = (listingId: string, userId: string) => parties.set(listingId, (parties.get(listingId) ?? new Set()).add(userId));
  for (const row of won) add(row.listingId, row.buyerId);
  for (const row of funded) add(row.closing.listingId, row.userId);
  return parties;
}

async function withVisibility<T extends Shown>(listing: T): Promise<T & { visibility: string | null }> {
  if (listing.visibility !== undefined) return { ...listing, visibility: listing.visibility };
  const row = await prisma.listing.findUnique({ where: { id: listing.id }, select: { visibility: true } });
  return { ...listing, visibility: row?.visibility ?? null };
}

export type HiddenReason = "excluded" | "private" | "first_look";
type Audience = { id: string; email: string; role?: string; companyName?: string | null };

// Why each of `people` can't see this listing, for those who can't: the seller excludes them, or it is private and
// they weren't invited. Anyone missing from the map sees it.
export async function hiddenReasons(input: Shown, people: Audience[]): Promise<Map<string, HiddenReason>> {
  const reasons = new Map<string, HiddenReason>();
  if (!people.length) return reasons;
  const listing = await withVisibility(input);
  const owner = (person: Audience) => person.role === "ADMIN" || person.id === listing.sellerId || (Boolean(listing.brokerId) && person.id === listing.brokerId);
  const hidden = isPrivateListing(listing);
  const [exclusions, firstLook] = await Promise.all([
    prisma.sellerExclusion.findMany({ where: { sellerId: listing.sellerId }, select: { sellerId: true, buyerId: true, email: true, company: true } }),
    firstLookBuyers(listing.id),
  ]);
  if (!hidden && !exclusions.length && !firstLook) return reasons;
  const others = people.filter((person) => !owner(person));
  const persons = new Map((exclusions.some((row) => row.company) ? await peopleOf(others) : others.map((person) => ({ id: person.id, email: person.email, companies: [] }))).map((person) => [person.id, person]));
  const [invites, parties] = hidden
    ? await Promise.all([
        prisma.listingInvite.findMany({ where: { listingId: listing.id, ...unset("revokedAt") }, select: { userId: true, email: true } }),
        closingParties([listing.id]),
      ])
    : [[], new Map<string, Set<string>>()];
  const party = parties.get(listing.id) ?? new Set<string>();
  const invited = (person: Audience) =>
    party.has(person.id) || invites.some((invite) => (invite.userId ? invite.userId === person.id : normalEmail(invite.email) === normalEmail(person.email)));
  for (const person of others) {
    const known = persons.get(person.id);
    if (known && exclusions.some((row) => excludes(row, known))) reasons.set(person.id, "excluded");
    else if (firstLook && !firstLook.has(person.id)) reasons.set(person.id, "first_look");
    else if (hidden && !invited(person)) reasons.set(person.id, "private");
  }
  return reasons;
}

// The people in `people` who may see this listing, for anything that tells many buyers about one listing: buy-box
// matches, saved-search alerts, watchers, published answers and desk picks.
export async function audienceOf<T extends Audience>(input: Shown, people: T[]): Promise<T[]> {
  const reasons = await hiddenReasons(input, people);
  return reasons.size ? people.filter((person) => !reasons.has(person.id)) : people;
}

export type ListingSight = { visible: boolean; invited: boolean };

// Whether this viewer sees one listing, and whether they see it only on an invitation, which lifts the book's early
// access and free-slice holds: the seller asked them in by name.
export async function listingSight(viewer: ListingViewer, input: Shown): Promise<ListingSight> {
  const listing = await withVisibility(input);
  const hidden = isPrivateListing(listing);
  if (!viewer) return { visible: !hidden && !(await firstLookBuyers(listing.id)), invited: false };
  if (viewer.role === "ADMIN" || viewer.id === listing.sellerId || (Boolean(listing.brokerId) && viewer.id === listing.brokerId)) return { visible: true, invited: false };
  const user = await prisma.user.findUnique({ where: { id: viewer.id }, select: { id: true, email: true, role: true, companyName: true } });
  if (!user) return { visible: false, invited: false };
  const visible = (await audienceOf(listing, [user])).length > 0;
  // A committed buyer's first look lifts the same holds: the programme asked them in.
  return { visible, invited: visible && (hidden || Boolean(await firstLookBuyers(listing.id))) };
}

export async function canSeeListing(viewer: ListingViewer, listing: Shown) {
  return (await listingSight(viewer, listing)).visible;
}

// One viewer's standing across the book, read once for a page or a job that lists many listings.
export type ListingAccess = {
  desk: boolean;
  userId: string | null;
  // Private listings this viewer was invited to or is closing on.
  invited: Set<string>;
  // Sellers who exclude this viewer.
  excludedBy: Set<string>;
  // Listings in a forward-flow first look this viewer can't see, and those they see as a committed buyer.
  firstLook?: Set<string>;
  firstLookOpen?: Set<string>;
};

function noAccess(userId: string | null = null): ListingAccess {
  return { desk: false, userId, invited: new Set(), excludedBy: new Set() };
}

export async function listingAccess(viewer: ListingViewer): Promise<ListingAccess> {
  if (!viewer) return { ...noAccess(), ...(await firstLookFor(null)) };
  if (viewer.role === "ADMIN") return { ...noAccess(viewer.id), desk: true };
  const user = await prisma.user.findUnique({ where: { id: viewer.id }, select: { id: true, email: true, companyName: true } });
  if (!user) return { ...noAccess(), ...(await firstLookFor(null)) };
  const [person] = await peopleOf([user]);
  const email = normalEmail(user.email);
  const [exclusions, invites, won, funded, flow] = await Promise.all([
    prisma.sellerExclusion.findMany({
      where: { OR: [{ buyerId: user.id }, { email }, ...(person.companies.length ? [{ company: { not: null } }] : [])] },
      select: { sellerId: true, buyerId: true, email: true, company: true },
    }),
    prisma.listingInvite.findMany({
      where: { AND: [unset("revokedAt"), { OR: [{ userId: user.id }, { AND: [{ email }, unset("userId")] }] }] },
      select: { listingId: true },
    }),
    prisma.inquiry.findMany({ where: { buyerId: user.id, status: "ACCEPTED" }, select: { listingId: true } }),
    prisma.closingFunder.findMany({ where: { userId: user.id }, select: { closing: { select: { listingId: true } } } }),
    firstLookFor(user.id),
  ]);
  return {
    desk: false,
    userId: user.id,
    invited: new Set([...invites.map((row) => row.listingId), ...won.map((row) => row.listingId), ...funded.map((row) => row.closing.listingId)]),
    excludedBy: new Set(exclusions.filter((row) => excludes(row, person)).map((row) => row.sellerId)),
    ...flow,
  };
}

export function canSee(access: ListingAccess, listing: Shown) {
  if (access.desk) return true;
  if (access.userId && (listing.sellerId === access.userId || (Boolean(listing.brokerId) && listing.brokerId === access.userId))) return true;
  if (access.excludedBy.has(listing.sellerId)) return false;
  if (access.firstLook?.has(listing.id)) return false;
  return !isPrivateListing(listing) || access.invited.has(listing.id);
}

// A private listing or a first-look tranche this viewer sees only because they were asked in, for canOpenListing's
// invited flag.
export function invitedTo(access: ListingAccess, listing: Shown) {
  if (access.desk || (!isPrivateListing(listing) && !access.firstLookOpen?.has(listing.id))) return false;
  if (access.userId && (listing.sellerId === access.userId || listing.brokerId === access.userId)) return false;
  return canSee(access, listing);
}

// The same rule as a where-fragment for listing queries. Merge it with AND.
export function visibleWhere(access: ListingAccess): Prisma.ListingWhereInput {
  if (access.desk) return {};
  const closed = access.firstLook?.size ? [...access.firstLook] : [];
  if (!access.userId) return closed.length ? { AND: [publicListing(), { id: { notIn: closed } }] } : publicListing();
  const me = access.userId;
  return {
    AND: [
      { OR: [publicListing(), { sellerId: me }, { brokerId: me }, ...(access.invited.size ? [{ id: { in: [...access.invited] } }] : [])] },
      ...(access.excludedBy.size ? [{ OR: [{ sellerId: { notIn: [...access.excludedBy] } }, { sellerId: me }, { brokerId: me }] }] : []),
      ...(closed.length ? [{ OR: [{ id: { notIn: closed } }, { sellerId: me }, { brokerId: me }] }] : []),
    ],
  };
}

export async function listingScope(viewer: ListingViewer) {
  return visibleWhere(await listingAccess(viewer));
}

// ---------------------------------------------------------------------------------------------------------------
// Forward-flow first look. Until a programme's tranche is released, only the programme's active committed buyers,
// its seller and broker, and the desk see it (lib/flow-programs.ts). It narrows the rules above and never widens
// them: an excluded buyer stays out, and a private tranche still needs an invitation. Few tranches are in a first
// look at once, so the book's filter is a short list of ids.

const FIRST_LOOK = "FIRST_LOOK";

// The buyers who see this listing in its first look, or null when it isn't in one.
async function firstLookBuyers(listingId: string) {
  const tranche = await prisma.flowTranche.findUnique({ where: { listingId }, select: { programId: true, status: true } });
  if (tranche?.status !== FIRST_LOOK) return null;
  const rows = await prisma.flowCommitment.findMany({ where: { programId: tranche.programId, status: "ACTIVE" }, select: { buyerId: true } });
  return new Set(rows.map((row) => row.buyerId));
}

async function firstLookFor(userId: string | null): Promise<Pick<ListingAccess, "firstLook" | "firstLookOpen">> {
  const tranches = await prisma.flowTranche.findMany({ where: { status: FIRST_LOOK }, select: { listingId: true, programId: true } });
  if (!tranches.length) return {};
  const programIds = [...new Set(tranches.map((row) => row.programId))];
  const active = userId ? await prisma.flowCommitment.findMany({ where: { buyerId: userId, status: "ACTIVE", programId: { in: programIds } }, select: { programId: true } }) : [];
  const mine = new Set(active.map((row) => row.programId));
  return {
    firstLook: new Set(tranches.filter((row) => !mine.has(row.programId)).map((row) => row.listingId)),
    firstLookOpen: new Set(tranches.filter((row) => mine.has(row.programId)).map((row) => row.listingId)),
  };
}

// For the public pages that list with publicListing alone: nothing in a first look.
export async function outsideFirstLook(): Promise<Prisma.ListingWhereInput> {
  const rows = await prisma.flowTranche.findMany({ where: { status: FIRST_LOOK }, select: { listingId: true } });
  return rows.length ? { id: { notIn: rows.map((row) => row.listingId) } } : {};
}

// ---------------------------------------------------------------------------------------------------------------
// The seller's controls: private or public, and who is invited. The seller, the filing broker and the desk set them.

type Actor = { id: string; role: string };
type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string) => ({ ok: false as const, error });
const NOT_YOURS = "That listing isn't yours to change.";
// The audience can change while the listing is filed, live or in contract. After that the sale is over.
const OPEN_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED", "PENDING"];
export const INVITES_AT_ONCE = 25;
const INVITE_BATCHES = 12;
const INVITE_WINDOW_MS = 60 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The link carries the token. Only its hash is kept, so a copy of the database opens nothing.
export function inviteTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function inviteLink(token: string) {
  return `${process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:4317"}/invite/${token}`;
}

// Addresses one per line or separated by commas, semicolons or spaces. Each once, in lower case.
export function readEmails(raw: unknown) {
  const parts = String(raw ?? "").split(/[\s,;]+/).map((part) => normalEmail(part)).filter(Boolean);
  const emails = [...new Set(parts)];
  return { emails: emails.filter((email) => EMAIL.test(email) && email.length <= 200), bad: emails.filter((email) => !EMAIL.test(email) || email.length > 200) };
}

async function rescoreQuietly(listingId: string) {
  const { rescoreListing } = await import("@/lib/matching");
  await rescoreListing(listingId, false).catch(() => undefined);
}

// Private hides the listing from everyone but the invited buyers, the seller and the desk. Public puts it back on
// the book; a live listing that opens to the market alerts saved searches and buy boxes as a new one would.
export async function setVisibility(actor: Actor, input: { listingId: string; visibility: unknown }): Promise<Outcome<{ changed: boolean; visibility: "PRIVATE" | "PUBLIC" }>> {
  const visibility = input.visibility === PRIVATE ? "PRIVATE" : input.visibility === "PUBLIC" ? "PUBLIC" : null;
  if (!visibility) return fail("Choose private or public.");
  const listing = await prisma.listing.findUnique({ where: { id: input.listingId }, select: { id: true, sellerId: true, brokerId: true, status: true, visibility: true, launchAt: true } });
  if (!listing || !canManageRoom(actor, listing)) return fail(NOT_YOURS);
  if (!OPEN_STATUSES.includes(listing.status)) return fail("This sale is over, so its audience is set.");
  if ((visibility === "PRIVATE") === isPrivateListing(listing)) return { ok: true, value: { changed: false, visibility } };
  await prisma.listing.update({ where: { id: listing.id }, data: { visibility: visibility === "PRIVATE" ? PRIVATE : null } });
  await audit(actor.id, "LISTING_VISIBILITY", "listing", listing.id, visibility === "PRIVATE" ? "private" : "public");
  const { launchPending } = await import("@/lib/launch-rules");
  if (visibility === "PUBLIC" && listing.status === "APPROVED" && !launchPending(listing)) {
    const [{ rescoreListing }, { alertMatchingSearches }] = await Promise.all([import("@/lib/matching"), import("@/lib/search-alerts")]);
    await alertMatchingSearches(listing.id).catch(() => undefined);
    await rescoreListing(listing.id, true).catch(() => undefined);
  } else {
    // Matches for buyers who can't see it now go, and the desk's standing-bid sheet with them.
    await rescoreQuietly(listing.id);
  }
  return { ok: true, value: { changed: true, visibility } };
}

export type InviteResult = { invited: string[]; skipped: { email: string; reason: string }[] };

// Each address gets one open invitation. An existing account is attached at once, so the listing is on its book
// before it opens the email; anyone else gets the link, which works once they sign up with that address.
export async function inviteBuyers(actor: Actor, input: { listingId: string; emails: unknown }): Promise<Outcome<InviteResult>> {
  const listing = await prisma.listing.findUnique({ where: { id: input.listingId }, select: { id: true, title: true, sellerId: true, brokerId: true, status: true } });
  if (!listing || !canManageRoom(actor, listing)) return fail(NOT_YOURS);
  if (!OPEN_STATUSES.includes(listing.status)) return fail("This sale is over, so it takes no new invitations.");
  const { emails, bad } = readEmails(input.emails);
  if (bad.length) return fail(`Check ${bad.length === 1 ? "this address" : "these addresses"}: ${bad.slice(0, 5).join(", ")}.`);
  if (!emails.length) return fail("Enter one or more email addresses.");
  if (emails.length > INVITES_AT_ONCE) return fail(`Invite up to ${INVITES_AT_ONCE} addresses at a time.`);
  // Each invitation is an email from UPB to an address the seller typed, so the batches are limited per hour.
  const { consumeRateLimit } = await import("@/lib/rate-limit");
  if (actor.role !== "ADMIN" && !(await consumeRateLimit(`listing-invite:${actor.id}`, INVITE_BATCHES, INVITE_WINDOW_MS))) {
    return fail("That is a lot of invitations in an hour. Try again shortly.");
  }
  const [users, open, exclusions] = await Promise.all([
    prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, email: true, role: true, companyName: true } }),
    prisma.listingInvite.findMany({ where: { listingId: listing.id, email: { in: emails }, ...unset("revokedAt") }, select: { email: true } }),
    prisma.sellerExclusion.findMany({ where: { sellerId: listing.sellerId }, select: { sellerId: true, buyerId: true, email: true, company: true } }),
  ]);
  const byEmail = new Map(users.map((user) => [normalEmail(user.email), user]));
  const people = new Map((await peopleOf(users)).map((person) => [normalEmail(person.email), person]));
  const already = new Set(open.map((row) => normalEmail(row.email)));
  const result: InviteResult = { invited: [], skipped: [] };
  for (const email of emails) {
    const user = byEmail.get(email);
    const person = people.get(email) ?? { id: "", email, companies: [] };
    if (user && (user.role === "ADMIN" || user.id === listing.sellerId || user.id === listing.brokerId)) {
      result.skipped.push({ email, reason: "already sees it" });
      continue;
    }
    if (exclusions.some((row) => excludes(row, person))) {
      result.skipped.push({ email, reason: "on the seller's excluded buyers" });
      continue;
    }
    if (already.has(email)) {
      result.skipped.push({ email, reason: "already invited" });
      continue;
    }
    const token = randomBytes(24).toString("base64url");
    await prisma.listingInvite.create({ data: { listingId: listing.id, email, userId: user?.id ?? null, token: inviteTokenHash(token), invitedById: actor.id } });
    await notify(
      email,
      `Private sale · ${listing.title}`,
      [
        `You are invited to a private sale on UPB Capital: ${listing.title}. It isn't on the open book. Only invited buyers see it.`,
        `Open it here: ${inviteLink(token)}`,
        user ? "Sign in with this address to open it." : "Create a buyer account with this address, and the link opens the listing once the desk approves it.",
      ].join("\n\n"),
    );
    result.invited.push(email);
  }
  if (result.invited.length) {
    await audit(actor.id, "LISTING_INVITE", "listing", listing.id, result.invited.join(", "));
    await rescoreQuietly(listing.id);
  }
  return { ok: true, value: result };
}

export async function revokeInvite(actor: Actor, inviteId: string): Promise<Outcome<{ listingId: string }>> {
  const invite = await prisma.listingInvite.findUnique({ where: { id: inviteId }, include: { listing: { select: { id: true, sellerId: true, brokerId: true } } } });
  if (!invite || !canManageRoom(actor, invite.listing)) return fail(NOT_YOURS);
  if (invite.revokedAt) return { ok: true, value: { listingId: invite.listingId } };
  await prisma.listingInvite.update({ where: { id: invite.id }, data: { revokedAt: new Date() } });
  await audit(actor.id, "LISTING_INVITE_REVOKED", "listing", invite.listingId, invite.email);
  await rescoreQuietly(invite.listingId);
  return { ok: true, value: { listingId: invite.listingId } };
}

// The invitations on a listing for its seller and the desk: who, whether they opened it, and any revoked.
export async function listingInvites(listingId: string) {
  return prisma.listingInvite.findMany({
    where: { listingId },
    select: { id: true, email: true, userId: true, createdAt: true, openedAt: true, revokedAt: true },
    orderBy: { createdAt: "desc" },
  });
}

export type InviteOpening = { state: "missing" } | { state: "signin" } | { state: "mismatch" } | { state: "open"; listingId: string };

// The invitation link. A signed-in buyer whose address it went to is attached to it and goes to the listing. Anyone
// else is asked to sign in with that address, and learns nothing about the listing.
export async function openInvite(token: string, viewer: { id: string; email: string; role: string } | null, now = new Date()): Promise<InviteOpening> {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(token)) return { state: "missing" };
  const invite = await prisma.listingInvite.findUnique({ where: { token: inviteTokenHash(token) }, include: { listing: { select: { id: true, sellerId: true, brokerId: true, visibility: true } } } });
  if (!invite || invite.revokedAt) return { state: "missing" };
  if (!viewer) return { state: "signin" };
  const mine = invite.userId ? invite.userId === viewer.id : normalEmail(invite.email) === normalEmail(viewer.email);
  if (!mine) return { state: "mismatch" };
  // A buyer the seller has since excluded finds a closed invitation, as if it had been revoked.
  if (!(await canSeeListing(viewer, invite.listing))) return { state: "missing" };
  await prisma.listingInvite.updateMany({
    where: { id: invite.id, ...unset("revokedAt") },
    data: { userId: viewer.id, ...(invite.openedAt ? {} : { openedAt: now }) },
  });
  return { state: "open", listingId: invite.listingId };
}

// ---------------------------------------------------------------------------------------------------------------
// The seller's standing list of buyers they never sell to. Only the seller changes it; the desk reads it.

export const REASON_MAX = 300;

// Each seller's list, newest first, with the account an email matched, for the seller and the desk's files.
export async function exclusionsBySeller(sellerIds: string[]) {
  const rows = sellerIds.length ? await prisma.sellerExclusion.findMany({ where: { sellerId: { in: sellerIds } }, orderBy: { createdAt: "desc" } }) : [];
  const buyerIds = rows.flatMap((row) => (row.buyerId ? [row.buyerId] : []));
  const accounts = buyerIds.length ? await prisma.user.findMany({ where: { id: { in: buyerIds } }, select: { id: true, name: true, email: true } }) : [];
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const lists = new Map(sellerIds.map((id) => [id, [] as (typeof rows[number] & { account: (typeof accounts)[number] | null })[]]));
  for (const row of rows) lists.get(row.sellerId)?.push({ ...row, account: row.buyerId ? byId.get(row.buyerId) ?? null : null });
  return lists;
}

export async function sellerExclusions(sellerId: string) {
  return (await exclusionsBySeller([sellerId])).get(sellerId) ?? [];
}

// The seller's live and filed listings, rescored so a buyer added or taken off the list gains or loses the matches.
async function rescoreSeller(sellerId: string) {
  const listings = await prisma.listing.findMany({ where: { sellerId, status: { in: ["SUBMITTED", "UNDER_REVIEW", "APPROVED"] } }, select: { id: true } });
  for (const listing of listings) await rescoreQuietly(listing.id);
}

// By email or by company name. An email that belongs to an account holds the account too, so a buyer who changes
// their address stays on the list. The seller isn't told whether an account exists.
export async function addExclusion(seller: Actor, input: { kind: unknown; value: unknown; reason: unknown }): Promise<Outcome<{ id: string }>> {
  if (seller.role !== "INDIVIDUAL_SELLER" && seller.role !== "INSTITUTIONAL_SELLER") return fail("Excluded buyers are for sellers.");
  const kind = input.kind === "COMPANY" ? "COMPANY" : "EMAIL";
  const value = String(input.value ?? "").trim().slice(0, 200);
  const reason = String(input.reason ?? "").replace(/\s+/g, " ").trim().slice(0, REASON_MAX);
  const existing = await prisma.sellerExclusion.findMany({ where: { sellerId: seller.id }, select: { email: true, company: true } });
  let data: { buyerId: string | null; email: string | null; company: string | null };
  if (kind === "EMAIL") {
    const email = normalEmail(value);
    if (!EMAIL.test(email)) return fail("Enter the buyer's email address.");
    if (existing.some((row) => row.email && normalEmail(row.email) === email)) return fail("That address is already on your list.");
    const account = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (account?.id === seller.id) return fail("That is your own address.");
    data = { buyerId: account?.id ?? null, email, company: null };
  } else {
    if (normalCompany(value).length < 2) return fail("Enter the company's name.");
    if (existing.some((row) => row.company && normalCompany(row.company) === normalCompany(value))) return fail("That company is already on your list.");
    data = { buyerId: null, email: null, company: value.replace(/\s+/g, " ") };
  }
  const row = await prisma.sellerExclusion.create({ data: { sellerId: seller.id, ...data, reason, createdById: seller.id } });
  await audit(seller.id, "SELLER_EXCLUSION", "user", seller.id, `Added ${data.email ?? data.company}`);
  // Open invitations to the buyer on the seller's listings close at once.
  const invites = await prisma.listingInvite.findMany({ where: { listing: { sellerId: seller.id }, ...unset("revokedAt") }, select: { id: true, email: true, userId: true } });
  if (invites.length) {
    const users = await prisma.user.findMany({
      where: { OR: [{ id: { in: invites.flatMap((invite) => (invite.userId ? [invite.userId] : [])) } }, { email: { in: invites.map((invite) => invite.email) } }] },
      select: { id: true, email: true, companyName: true },
    });
    const people = await peopleOf(users);
    const closed = invites.filter((invite) => {
      const person = people.find((one) => (invite.userId ? one.id === invite.userId : normalEmail(one.email) === normalEmail(invite.email))) ?? { id: invite.userId ?? "", email: invite.email, companies: [] };
      return excludes({ sellerId: seller.id, ...data }, person);
    });
    if (closed.length) await prisma.listingInvite.updateMany({ where: { id: { in: closed.map((invite) => invite.id) } }, data: { revokedAt: new Date() } });
  }
  await rescoreSeller(seller.id);
  return { ok: true, value: { id: row.id } };
}

export async function removeExclusion(seller: Actor, exclusionId: string): Promise<Outcome<null>> {
  const row = await prisma.sellerExclusion.findUnique({ where: { id: exclusionId } });
  if (!row || row.sellerId !== seller.id) return fail("That entry isn't on your list.");
  await prisma.sellerExclusion.delete({ where: { id: row.id } });
  await audit(seller.id, "SELLER_EXCLUSION_REMOVED", "user", seller.id, `Removed ${row.email ?? row.company ?? row.buyerId ?? ""}`);
  await rescoreSeller(seller.id);
  return { ok: true, value: null };
}

// ---------------------------------------------------------------------------------------------------------------
// Awards. A bid can't win for a buyer the seller now excludes, or one a private listing no longer shows to, unless
// they are already a party to a closing on it. The reason reaches the desk only, never the buyer.

export const AWARD_EXCLUDED = "The seller excludes this buyer, so this bid can't be awarded. Decline it, or ask the seller to take the buyer off their list.";
export const AWARD_UNINVITED = "This listing is private and this buyer isn't invited, so this bid can't be awarded. The seller can invite them.";
export const AWARD_SEAT_EXCLUDED = "The seller excludes a group seat holder, so this bid can't be awarded.";
export const AWARD_SEAT_UNINVITED = "This listing is private and a group seat holder isn't invited, so this bid can't be awarded.";
export const AWARD_FIRST_LOOK = "This tranche is in its programme's first look and this buyer isn't an active committed buyer, so this bid can't be awarded until the release.";
export const AWARD_SEAT_FIRST_LOOK = "This tranche is in its programme's first look and a group seat holder isn't an active committed buyer, so this bid can't be awarded until the release.";

// Buyers on an open or finished closing on each listing, by its own bid or as a funder.
async function dealParties(listingIds: string[]) {
  const parties = new Map<string, Set<string>>();
  if (!listingIds.length) return parties;
  const closings = await prisma.closing.findMany({
    where: { listingId: { in: listingIds }, status: { in: ["OPEN", "COMPLETE"] } },
    select: { listingId: true, inquiryId: true, funders: { select: { userId: true } } },
  });
  const inquiryIds = closings.flatMap((closing) => (closing.inquiryId ? [closing.inquiryId] : []));
  const bids = inquiryIds.length ? await prisma.inquiry.findMany({ where: { id: { in: inquiryIds } }, select: { id: true, buyerId: true } }) : [];
  const buyerOf = new Map(bids.map((bid) => [bid.id, bid.buyerId]));
  const add = (listingId: string, userId: string | undefined) => {
    if (userId) parties.set(listingId, (parties.get(listingId) ?? new Set()).add(userId));
  };
  for (const closing of closings) {
    add(closing.listingId, closing.inquiryId ? buyerOf.get(closing.inquiryId) : undefined);
    for (const funder of closing.funders) add(closing.listingId, funder.userId);
  }
  return parties;
}

type AwardBid = { id: string; listingId: string; listing: Shown; buyer: Audience };

// Why each bid can't be awarded on these grounds, by bid id, for the offer book and for checkAward.
export async function awardBlocks(bids: AwardBid[], seats: Map<string, Audience[]> = new Map()): Promise<Map<string, string>> {
  const blocks = new Map<string, string>();
  const byListing = new Map<string, AwardBid[]>();
  for (const bid of bids) byListing.set(bid.listingId, [...(byListing.get(bid.listingId) ?? []), bid]);
  const parties = await dealParties([...byListing.keys()]);
  for (const [listingId, rows] of byListing) {
    const people = [...new Map(rows.flatMap((bid) => [bid.buyer, ...(seats.get(bid.id) ?? [])]).map((person) => [person.id, person])).values()];
    const reasons = await hiddenReasons(rows[0].listing, people);
    if (!reasons.size) continue;
    const party = parties.get(listingId) ?? new Set<string>();
    const reason = (person: Audience) => (party.has(person.id) ? undefined : reasons.get(person.id));
    for (const bid of rows) {
      const own = reason(bid.buyer);
      const seat = (seats.get(bid.id) ?? []).map(reason).find(Boolean);
      if (own) blocks.set(bid.id, own === "excluded" ? AWARD_EXCLUDED : own === "first_look" ? AWARD_FIRST_LOOK : AWARD_UNINVITED);
      else if (seat) blocks.set(bid.id, seat === "excluded" ? AWARD_SEAT_EXCLUDED : seat === "first_look" ? AWARD_SEAT_FIRST_LOOK : AWARD_SEAT_UNINVITED);
    }
  }
  return blocks;
}

export async function awardBlock(bid: AwardBid, seatUserIds: string[] = []) {
  const seats = seatUserIds.length ? await prisma.user.findMany({ where: { id: { in: seatUserIds } }, select: { id: true, email: true, role: true, companyName: true } }) : [];
  return (await awardBlocks([bid], new Map([[bid.id, seats]]))).get(bid.id) ?? null;
}
