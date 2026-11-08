import assert from "node:assert/strict";
import test from "node:test";
import { canOpenListing, openableListingIds } from "../lib/access";
import { checkAward } from "../lib/awards";
import { searchCommands } from "../lib/command-search";
import { loadClosedTrades } from "../lib/comps";
import { checkOffer, inquiryBlock } from "../lib/inquiry";
import { prisma } from "../lib/prisma";
import {
  addExclusion,
  AWARD_EXCLUDED,
  AWARD_UNINVITED,
  awardBlock,
  canSee,
  canSeeListing,
  excludes,
  inviteBuyers,
  listingAccess,
  listingScope,
  normalCompany,
  openInvite,
  readEmails,
  removeExclusion,
  revokeInvite,
  setVisibility,
  visibleWhere,
} from "../lib/private-listings";
import { canAsk } from "../lib/questions";
import { publishedResult } from "../lib/results";
import { safeNext } from "../lib/safe-next";
import { sendSearchRoundup } from "../lib/search-alerts";

const DAY = 24 * 60 * 60 * 1000;
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
const email = (who: string) => `a-private-${who}-${tag}@example.org`;
const made = { users: [] as string[], listings: [] as string[], emails: [] as string[] };

async function person(who: string, role: "BUYER" | "INSTITUTIONAL_SELLER" | "ADMIN", extra: { companyName?: string } = {}) {
  const user = await prisma.user.create({
    data: {
      email: email(who),
      name: `Private ${who} ${tag}`,
      role,
      accountStatus: "APPROVED",
      passwordHash: "x",
      companyName: extra.companyName ?? "",
      ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
    },
  });
  made.users.push(user.id);
  made.emails.push(user.email);
  return user;
}

async function listing(sellerId: string, input: { title: string; visibility?: string; status?: "APPROVED" | "SOLD"; salePrice?: number; state?: string }) {
  const row = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId,
      status: input.status ?? "APPROVED",
      approvedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      // Already claimed, so scoring this fixture never sends the desk a standing-bid notice.
      standingBidsNotifiedAt: new Date(),
      title: input.title,
      ...(input.visibility ? { visibility: input.visibility } : {}),
      ...(input.status === "SOLD" ? { salePrice: input.salePrice ?? 50000, soldAt: new Date(Date.now() - DAY) } : {}),
      notes: {
        create: [{
          streetAddress: "1 Hidden Ln", city: "Quietville", state: input.state ?? "QZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
          lienPosition: "FIRST", upb: 200000, interestRate: 7, monthlyPi: 1400, paymentStatus: "PERFORMING", monthsDelinquent: 0,
          askingPrice: 120000, estimatedValue: 260000,
        }] as never,
      },
    },
  });
  made.listings.push(row.id);
  return row;
}

let world: Awaited<ReturnType<typeof build>>;

async function build() {
  const seller = await person("seller", "INSTITUTIONAL_SELLER");
  const desk = await person("desk", "ADMIN");
  const invitee = await person("invitee", "BUYER");
  const outsider = await person("outsider", "BUYER");
  const rival = await person("rival", "BUYER", { companyName: "Rival Capital, LLC" });
  const hidden = await listing(seller.id, { title: `Private pool ${tag}`, visibility: "PRIVATE" });
  const open = await listing(seller.id, { title: `Public pool ${tag}` });
  return { seller, desk, invitee, outsider, rival, hidden, open };
}

test.before(async () => {
  world = await build();
});

test.after(async () => {
  const listingIds = made.listings;
  const userIds = made.users;
  const inquiryIds = (await prisma.inquiry.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((row) => row.id);
  await prisma.closing.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.offerMessage.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await prisma.deskThread.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await prisma.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await prisma.listingMatch.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listingInvite.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.sellerExclusion.deleteMany({ where: { sellerId: { in: userIds } } });
  await prisma.savedSearch.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...listingIds, ...userIds] } }, { actorId: { in: userIds } }] } });
  await prisma.note.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: made.emails } }, { subject: { contains: tag } }] } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

test("the rules: an exclusion matches by account, email or company in any case, and a private listing needs an invite", () => {
  const person = { id: "u1", email: "Buyer@Firm.com", companies: [normalCompany("Rival Capital, LLC")] };
  assert.equal(excludes({ sellerId: "s", buyerId: "u1", email: null, company: null }, person), true);
  assert.equal(excludes({ sellerId: "s", buyerId: null, email: "buyer@firm.COM", company: null }, person), true);
  assert.equal(excludes({ sellerId: "s", buyerId: null, email: null, company: "rival capital llc" }, person), true);
  assert.equal(excludes({ sellerId: "s", buyerId: null, email: "other@firm.com", company: "Another Fund" }, person), false);

  const access = { desk: false, userId: "u1", invited: new Set(["p1"]), excludedBy: new Set(["bad"]) };
  assert.equal(canSee(access, { id: "p1", sellerId: "s", visibility: "PRIVATE" }), true);
  assert.equal(canSee(access, { id: "p2", sellerId: "s", visibility: "PRIVATE" }), false);
  assert.equal(canSee(access, { id: "x", sellerId: "s", visibility: null }), true);
  assert.equal(canSee(access, { id: "p1", sellerId: "bad", visibility: "PRIVATE" }), false, "an exclusion wins over an invitation");
  assert.equal(canSee(access, { id: "x", sellerId: "bad", visibility: null }), false);
  assert.equal(canSee({ ...access, userId: "s" }, { id: "p2", sellerId: "s", visibility: "PRIVATE" }), true, "the seller sees their own");
  assert.equal(canSee({ ...access, desk: true }, { id: "p2", sellerId: "bad", visibility: "PRIVATE" }), true);
  assert.deepEqual(visibleWhere({ desk: true, userId: "d", invited: new Set(), excludedBy: new Set() }), {});

  assert.deepEqual(readEmails("A@x.com, b@y.org;\nA@x.com  nope"), { emails: ["a@x.com", "b@y.org"], bad: ["nope"] });
});

test("a private listing takes no free-slice place, and an invitation lifts the early and slice holds", () => {
  const now = Date.now();
  const rows = [
    { id: "private", status: "APPROVED" as const, approvedAt: new Date(now - 3 * DAY), visibility: "PRIVATE" },
    { id: "public", status: "APPROVED" as const, approvedAt: new Date(now - 4 * DAY), visibility: null },
  ];
  assert.deepEqual([...openableListingIds(rows, 24, 1)], ["public"]);
  const viewer = { id: "b", role: "BUYER" as const, accountStatus: "APPROVED" as const, subscriptionTier: "FREE" as const, subscriptionStatus: "INCOMPLETE" as const };
  const base = { viewer, status: "APPROVED" as const, approvedAt: new Date(now - 60 * 60 * 1000), earlyAccessHours: 24, openableIds: new Set<string>(), listingId: "private", sellerId: "s" };
  assert.equal(canOpenListing(base).ok, false);
  assert.equal(canOpenListing({ ...base, invited: true }).ok, true);
});

test("a private listing stays off a non-invitee's book, search and roundup, and shows to an invitee", async () => {
  const { seller, invitee, outsider, hidden, open } = world;
  const invited = await inviteBuyers(seller, { listingId: hidden.id, emails: invitee.email.toUpperCase() });
  assert.equal(invited.ok, true);
  if (invited.ok) assert.deepEqual(invited.value.invited, [invitee.email]);

  // The marketplace's own query.
  const book = async (user: { id: string; role: string }) =>
    (await prisma.listing.findMany({ where: { id: { in: [hidden.id, open.id] }, status: { in: ["APPROVED", "PENDING", "SOLD"] }, AND: [await listingScope(user)] }, select: { id: true } })).map((row) => row.id).sort();
  assert.deepEqual(await book(outsider), [open.id]);
  assert.deepEqual(await book(invitee), [hidden.id, open.id].sort());
  assert.deepEqual(await book(seller), [hidden.id, open.id].sort());
  assert.deepEqual(await book(world.desk), [hidden.id, open.id].sort());
  assert.deepEqual(await book({ id: "", role: "BUYER" }), [open.id], "no account sees only the public book");
  assert.equal(await canSeeListing(null, hidden), false);
  assert.equal(await canSeeListing(outsider, hidden), false);
  assert.equal(await canSeeListing(invitee, { id: hidden.id, sellerId: hidden.sellerId }), true, "visibility is read when the caller didn't select it");

  // The command palette finds it for the invitee only.
  const settings = { settings: { earlyAccessHours: 0, freeBrowseLimit: 100 } };
  const found = async (user: typeof outsider) => (await searchCommands(user, `Private pool ${tag}`, settings)).filter((item) => item.id === `listing:${hidden.id}`).length;
  assert.equal(await found(outsider), 0);
  assert.equal(await found(invitee), 1);

  // A daily roundup names it to the invitee and never to anyone else.
  const now = new Date();
  for (const user of [invitee, outsider]) {
    const saved = await prisma.savedSearch.create({ data: { userId: user.id, name: `Quietville ${tag}`, filters: { q: "quietville" }, cadence: "DAILY", createdAt: new Date(now.getTime() - 3 * DAY) } });
    const search = await prisma.savedSearch.findUniqueOrThrow({ where: { id: saved.id }, include: { user: true } });
    await sendSearchRoundup(search, now);
  }
  const roundup = async (to: string) => (await prisma.notification.findMany({ where: { toEmail: to, subject: { contains: tag } }, select: { body: true } })).map((row) => row.body).join("\n");
  assert.match(await roundup(invitee.email), new RegExp(`Private pool ${tag}`));
  assert.match(await roundup(outsider.email), new RegExp(`Public pool ${tag}`));
  assert.doesNotMatch(await roundup(outsider.email), new RegExp(`Private pool ${tag}`));
});

test("a non-invitee's bid on a private listing is refused as closed, and an invitee gets past the gate", async () => {
  const { invitee, outsider, hidden } = world;
  const bid = { listing: hidden, noteId: "", amount: 100000, goodUntil: "" };
  const refused = await checkOffer({ user: outsider, ...bid });
  assert.equal(refused.error, "This listing is not taking new inquiries.");
  assert.equal(await inquiryBlock(outsider, hidden), "This listing is not taking new inquiries.");
  assert.equal(await inquiryBlock(invitee, hidden), null);
  assert.equal(await canAsk(outsider, hidden), false);
});

test("an excluded buyer can't see or bid on the seller's public listing, can't be invited, and isn't told", async () => {
  const { seller, rival, outsider, hidden, open } = world;
  assert.equal(await canSeeListing(rival, open), true);
  const added = await addExclusion(seller, { kind: "COMPANY", value: "  RIVAL capital llc ", reason: "Competitor" });
  assert.equal(added.ok, true);
  assert.equal((await addExclusion(seller, { kind: "COMPANY", value: "Rival Capital, LLC", reason: "" })).ok, false, "the same company once");
  assert.equal(await canSeeListing(rival, open), false);
  assert.equal(canSee(await listingAccess(rival), open), false);
  const book = await prisma.listing.findMany({ where: { id: { in: [hidden.id, open.id] }, AND: [await listingScope(rival)] }, select: { id: true } });
  assert.deepEqual(book, []);
  const refused = await checkOffer({ user: rival, listing: open, noteId: "", amount: 100000, goodUntil: "" });
  assert.equal(refused.error, "This listing is not taking new inquiries.");
  assert.doesNotMatch(refused.error ?? "", /exclu/i);
  // Nobody else is affected.
  assert.equal(await canSeeListing(outsider, open), true);

  const invited = await inviteBuyers(seller, { listingId: hidden.id, emails: rival.email });
  assert.equal(invited.ok, true);
  if (invited.ok) {
    assert.deepEqual(invited.value.invited, []);
    assert.equal(invited.value.skipped[0]?.reason, "on the seller's excluded buyers");
  }

  // By email, in any case, and the account goes with it.
  const byEmail = await addExclusion(seller, { kind: "EMAIL", value: outsider.email.toUpperCase(), reason: "" });
  assert.equal(byEmail.ok, true);
  const row = byEmail.ok ? await prisma.sellerExclusion.findUnique({ where: { id: byEmail.value.id } }) : null;
  assert.equal(row?.buyerId, outsider.id);
  assert.equal(await canSeeListing(outsider, open), false);
  assert.equal((await removeExclusion(world.outsider, row!.id)).ok, false, "only the seller changes their list");
  assert.equal((await removeExclusion(seller, row!.id)).ok, true);
  assert.equal(await canSeeListing(outsider, open), true);
  if (added.ok) await removeExclusion(seller, added.value.id);
  assert.equal(await canSeeListing(rival, open), true);
});

test("the invitation link opens for its address only, and a revoked one opens nothing", async () => {
  const { seller, outsider, desk, hidden } = world;
  const address = email("newcomer");
  made.emails.push(address);
  const sent = await inviteBuyers(desk, { listingId: hidden.id, emails: address });
  assert.equal(sent.ok, true);
  const mail = await prisma.notification.findFirst({ where: { toEmail: address, subject: { contains: tag } }, orderBy: { createdAt: "desc" } });
  const token = mail?.body.match(/\/invite\/([A-Za-z0-9_-]+)/)?.[1] ?? "";
  assert.ok(token.length > 20, "the email carries the link");
  const stored = await prisma.listingInvite.findFirst({ where: { listingId: hidden.id, email: address } });
  assert.notEqual(stored?.token, token, "only the token's hash is kept");

  assert.deepEqual(await openInvite(token, null), { state: "signin" });
  assert.deepEqual(await openInvite(token, outsider), { state: "mismatch" });
  assert.deepEqual(await openInvite("not-a-real-token-at-all", outsider), { state: "missing" });
  assert.equal(await canSeeListing(outsider, hidden), false);

  // The invitee signs up with that address after the invitation went out.
  const newcomer = await prisma.user.create({ data: { email: address, name: `Private newcomer ${tag}`, role: "BUYER", accountStatus: "APPROVED", passwordHash: "x" } });
  made.users.push(newcomer.id);
  assert.equal(await canSeeListing(newcomer, hidden), true, "the address alone shows it once the account exists");
  assert.deepEqual(await openInvite(token, newcomer), { state: "open", listingId: hidden.id });
  const opened = await prisma.listingInvite.findUnique({ where: { id: stored!.id } });
  assert.equal(opened?.userId, newcomer.id);
  assert.ok(opened?.openedAt);

  assert.equal((await revokeInvite(outsider, stored!.id)).ok, false, "a buyer can't revoke");
  assert.equal((await revokeInvite(seller, stored!.id)).ok, true);
  assert.deepEqual(await openInvite(token, newcomer), { state: "missing" });
  assert.equal(await canSeeListing(newcomer, hidden), false);
});

test("only the seller, broker or desk sets the audience, and a public listing turns private at once", async () => {
  const { seller, outsider, invitee, open } = world;
  assert.equal((await setVisibility(outsider, { listingId: open.id, visibility: "PRIVATE" })).ok, false);
  assert.equal((await setVisibility(seller, { listingId: open.id, visibility: "SECRET" })).ok, false);
  const changed = await setVisibility(seller, { listingId: open.id, visibility: "PRIVATE" });
  assert.deepEqual(changed, { ok: true, value: { changed: true, visibility: "PRIVATE" } });
  // Read fresh, as a page would.
  const now = { id: open.id, sellerId: open.sellerId };
  assert.equal(await canSeeListing(outsider, now), false);
  assert.equal(await canSeeListing(invitee, now), false, "an invitation is per listing");
  assert.equal(await canSeeListing(seller, now), true);
});

test("a private sale's price stays out of comps and public results", async () => {
  const { seller } = world;
  const shown = await listing(seller.id, { title: `Public sale ${tag}`, status: "SOLD", salePrice: 123457, state: "QY" });
  const quiet = await listing(seller.id, { title: `Private sale ${tag}`, status: "SOLD", salePrice: 654323, state: "QY", visibility: "PRIVATE" });
  assert.ok(shown.id && quiet.id);
  const trades = await loadClosedTrades();
  assert.equal(trades.some((trade) => trade.price === 123457 && trade.state === "QY"), true);
  assert.equal(trades.some((trade) => trade.price === 654323), false);

  const closing = {
    id: "c",
    status: "COMPLETE",
    openedAt: new Date(Date.now() - 30 * DAY),
    closedAt: new Date(),
    salePrice: 90000,
    noteId: null,
    listing: { kind: "SINGLE", publishResult: true, notes: [{ id: "n", state: "QY", lienPosition: "FIRST", paymentStatus: "PERFORMING", upb: 100000 }] },
  };
  assert.ok(publishedResult(closing));
  assert.equal(publishedResult({ ...closing, listing: { ...closing.listing, visibility: "PRIVATE" } }), null);
});

test("an award refuses a buyer the seller now excludes or a private listing no longer shows, unless already closing", async () => {
  const { seller, rival } = world;
  const target = await listing(seller.id, { title: `Award pool ${tag}` });
  const bid = await prisma.inquiry.create({ data: { listingId: target.id, buyerId: rival.id, type: "OFFER", amount: 110000, message: "" } });
  await prisma.offerMessage.create({ data: { inquiryId: bid.id, authorId: rival.id, kind: "OFFER", amount: 110000, body: "Opening bid." } });
  const before = await checkAward(bid.id);
  assert.notEqual(before.error, AWARD_EXCLUDED);
  assert.notEqual(before.error, AWARD_UNINVITED);

  const added = await addExclusion(seller, { kind: "EMAIL", value: rival.email, reason: "" });
  assert.equal((await checkAward(bid.id)).error, AWARD_EXCLUDED);
  if (added.ok) await removeExclusion(seller, added.value.id);

  await setVisibility(seller, { listingId: target.id, visibility: "PRIVATE" });
  assert.equal((await checkAward(bid.id)).error, AWARD_UNINVITED);
  await inviteBuyers(seller, { listingId: target.id, emails: rival.email });
  assert.notEqual((await checkAward(bid.id)).error, AWARD_UNINVITED);

  // A buyer already closing on the listing keeps it, even once excluded.
  const again = await addExclusion(seller, { kind: "COMPANY", value: "rival capital llc", reason: "" });
  const fresh = { id: bid.id, listingId: target.id, listing: { id: target.id, sellerId: target.sellerId }, buyer: rival };
  assert.equal(await awardBlock(fresh), AWARD_EXCLUDED);
  const won = await prisma.inquiry.create({ data: { listingId: target.id, buyerId: rival.id, type: "OFFER", amount: 100000, message: "", status: "ACCEPTED" } });
  await prisma.closing.create({
    data: { listingId: target.id, inquiryId: won.id, salePrice: 100000, buyerPremiumCents: 0, sellerCommissionCents: 0, buyerTotalCents: 10000000, netToSellerCents: 10000000 },
  });
  assert.equal(await awardBlock(fresh), null);
  if (again.ok) await removeExclusion(seller, again.value.id);
});

test("sign-in and sign-up return only to a path on this site", () => {
  assert.equal(safeNext("/invite/abc_DEF-123", "/home"), "/invite/abc_DEF-123");
  assert.equal(safeNext("/marketplace?view=table#top", "/home"), "/marketplace?view=table#top");
  for (const bad of ["", "//evil.example", "/\\evil.example", "/\\/evil.example", "https://evil.example/invite/x", "javascript:alert(1)", "invite/x", "/a\nb", `/${"x".repeat(600)}`]) {
    assert.equal(safeNext(bad, "/home"), "/home", bad);
  }
  assert.equal(safeNext(undefined, "/home"), "/home");
  assert.equal(safeNext(["/invite/x"], "/home"), "/home");
});
