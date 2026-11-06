import assert from "node:assert/strict";
import test from "node:test";
import { paletteCommands, searchCommands, shortcutsFor, type CommandItem } from "../lib/command-search";
import { prisma } from "../lib/prisma";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Fixed holds, so the test doesn't depend on the desk's settings: new paper is held 48 hours, and a free member
// opens one listing.
const SETTINGS = { earlyAccessHours: 48, freeBrowseLimit: 1 };

const note = (tag: string) => ({
  streetAddress: `77 Hidden${tag} Lane`,
  borrowerName: `Zed Borrower${tag}`,
  city: "Tampa", state: "FL", zip: "33601", propertyType: "SFR", occupancy: "OWNER_OCCUPIED", lienPosition: "FIRST",
  upb: 100000, interestRate: 7, monthlyPi: 700, paymentStatus: "PERFORMING", monthsDelinquent: 0, askingPrice: 80000, estimatedValue: 150000,
});

test.after(async () => {
  await prisma.$disconnect();
});

type World = Awaited<ReturnType<typeof makeWorld>>;

// Timestamp-tagged people and listings, so parallel runs never share rows and cleanup finds everything.
async function makeWorld() {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const word = `cmdk${tag}`;
  const now = Date.now();
  const user = (prefix: string, role: "INDIVIDUAL_SELLER" | "INSTITUTIONAL_SELLER" | "BUYER" | "ADMIN" | "BROKER", extra: Record<string, unknown> = {}) =>
    prisma.user.create({ data: { email: `cp-${prefix}-${tag}@example.org`, name: `${prefix} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x", ...extra } });
  const sellerA = await user("seller-a", "INDIVIDUAL_SELLER");
  const sellerB = await user("seller-b", "INSTITUTIONAL_SELLER");
  const broker = await user("broker", "BROKER");
  const free = await user("free", "BUYER");
  const pro = await user("pro", "BUYER", { subscriptionTier: "PRO", subscriptionStatus: "ACTIVE", subscriptionCurrentPeriodEnd: new Date(now + 30 * DAY) });
  const pending = await user("pending", "BUYER", { accountStatus: "PENDING" });
  const desk = await user("desk", "ADMIN");
  const listing = (sellerId: string, title: string, status: string, approvedAt: Date | null, extra: Record<string, unknown> = {}) =>
    prisma.listing.create({
      data: { kind: "SINGLE", sellerId, status: status as "APPROVED", title: `${word} ${title}`, ...(approvedAt ? { approvedAt } : {}), notes: { create: [note(tag)] as never }, ...extra },
    });
  const early = await listing(sellerA.id, "early", "APPROVED", new Date(now - HOUR));
  // Just outside the 48-hour hold, so it is the newest listing a free member can open.
  const slice = await listing(sellerA.id, "slice", "APPROVED", new Date(now - 48 * HOUR - 60_000));
  const old = await listing(sellerA.id, "old", "APPROVED", new Date(now - 30 * DAY));
  const sold = await listing(sellerA.id, "sold", "SOLD", new Date(now - 60 * DAY));
  const draft = await listing(sellerB.id, "draft", "SUBMITTED", null);
  const deal = await listing(broker.id, "deal", "APPROVED", new Date(now - 40 * DAY), { brokerId: broker.id, brokerRole: "SELLER_BROKER", clientSellerName: `Client${tag}` });
  const freeBid = await prisma.inquiry.create({ data: { listingId: slice.id, buyerId: free.id, type: "OFFER", status: "OPEN", amount: 70000 } });
  const proBid = await prisma.inquiry.create({ data: { listingId: old.id, buyerId: pro.id, type: "OFFER", status: "ACCEPTED", amount: 75000 } });
  const closing = await prisma.closing.create({
    data: { listingId: old.id, inquiryId: proBid.id, salePrice: 75000, buyerPremiumCents: 0, sellerCommissionCents: 0, buyerTotalCents: 7500000, netToSellerCents: 7500000 },
  });
  const holding = await prisma.buyerHolding.create({ data: { userId: pro.id, title: `${word} holding`, costBasis: 75000, upb: 100000 } });
  return {
    tag, word, sellerA, sellerB, broker, free, pro, pending, desk,
    early, slice, old, sold, draft, deal, freeBid, proBid, closing, holding,
    users: [sellerA, sellerB, broker, free, pro, pending, desk],
    listings: [early, slice, old, sold, draft, deal],
  };
}

async function cleanWorld(world: World) {
  const listingIds = world.listings.map((row) => row.id);
  await prisma.closing.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.inquiry.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.buyerHolding.deleteMany({ where: { userId: { in: world.users.map((row) => row.id) } } });
  await prisma.note.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.user.deleteMany({ where: { id: { in: world.users.map((row) => row.id) } } });
}

const search = (viewer: World["free"], term: string) => searchCommands(viewer, term, { settings: SETTINGS });
const idsOf = (items: CommandItem[], group?: string) => new Set(items.filter((item) => !group || item.group === group).map((item) => item.id));

test("the palette lists each role's own pages, actions and shortcuts", () => {
  const free = { role: "BUYER" as const, subscriptionTier: "FREE" as const, subscriptionStatus: "INCOMPLETE" as const, subscriptionCurrentPeriodEnd: null };
  const buyer = paletteCommands(free);
  const hrefs = (items: CommandItem[]) => items.map((item) => item.href);
  assert.ok(hrefs(buyer.commands).includes("/marketplace"));
  assert.ok(hrefs(buyer.commands).includes("/buyer/offers"));
  assert.ok(!hrefs(buyer.commands).some((href) => href.startsWith("/admin") || href.startsWith("/seller")));
  // Saved views are Pro, so a free member is pointed at the membership page.
  assert.equal(buyer.commands.find((item) => item.label === "Saved views")?.href, "/buyer/subscription");
  assert.equal(paletteCommands({ ...free, subscriptionTier: "PRO", subscriptionStatus: "ACTIVE" }).commands.find((item) => item.label === "Saved views")?.href, "/marketplace#saved-views");
  const seller = paletteCommands({ ...free, role: "INDIVIDUAL_SELLER" });
  assert.ok(seller.commands.some((item) => item.label === "New note listing"));
  assert.ok(!seller.commands.some((item) => item.label === "Upload a tape"));
  assert.ok(!hrefs(seller.commands).includes("/marketplace"), "a seller can't open the book");
  assert.ok(paletteCommands({ ...free, role: "INSTITUTIONAL_SELLER" }).commands.some((item) => item.label === "Upload a tape"));
  assert.ok(paletteCommands({ ...free, role: "BROKER" }).commands.some((item) => item.href === "/broker/deals/new"));
  const desk = paletteCommands({ ...free, role: "ADMIN" });
  assert.ok(desk.commands.some((item) => item.href === "/admin/search"));
  // Every page in the role's nav shows its shortcut, and every shortcut only opens a page.
  assert.deepEqual(desk.commands.find((item) => item.href === "/admin/offers")?.shortcut, ["g", "o"]);
  assert.deepEqual(shortcutsFor("BUYER").map((binding) => binding.keys.join("")), ["gb", "go", "gc", "gi", "gn"]);
  assert.equal(shortcutsFor("BUYER").find((binding) => binding.keys[1] === "o")?.href, "/buyer/offers");
  assert.ok(!shortcutsFor("INDIVIDUAL_SELLER").some((binding) => binding.keys[1] === "o"));
  for (const role of ["ADMIN", "BUYER", "BROKER", "INDIVIDUAL_SELLER"]) {
    for (const binding of shortcutsFor(role)) assert.match(binding.href, /^\/[a-z]/);
  }
});

test("a free member finds only the listings the book opens for them, with figures veiled", async () => {
  const world = await makeWorld();
  try {
    const found = await search(world.free, world.word);
    const listings = idsOf(found, "Listings");
    assert.ok(listings.has(`listing:${world.slice.id}`), "the free slice opens");
    assert.ok(listings.has(`listing:${world.sold.id}`), "a sold listing opens to everyone");
    assert.ok(!listings.has(`listing:${world.early.id}`), "early access is held for Pro");
    assert.ok(!listings.has(`listing:${world.old.id}`), "past the free slice is held");
    assert.ok(!listings.has(`listing:${world.deal.id}`), "past the free slice is held");
    assert.ok(!listings.has(`listing:${world.draft.id}`), "an unpublished listing never shows");
    for (const item of found.filter((row) => row.group === "Listings")) {
      assert.doesNotMatch(item.hint ?? "", /UPB|ask|\$/, "a free member sees no figures");
      assert.match(item.href, /^\/marketplace\//);
    }
    // Their own bid shows. Another buyer's closing and holding don't.
    assert.ok(idsOf(found, "Bids").has(`bid:${world.freeBid.id}`));
    assert.ok(!idsOf(found).has(`closing:${world.closing.id}`));
    assert.ok(!idsOf(found).has(`holding:${world.holding.id}`));
    assert.ok(!idsOf(found).has(`bid:${world.proBid.id}`));
  } finally {
    await cleanWorld(world);
  }
});

test("a Pro member opens early and older paper with figures, plus their own closing and holding", async () => {
  const world = await makeWorld();
  try {
    const found = await search(world.pro, world.word);
    const listings = idsOf(found, "Listings");
    for (const row of [world.early, world.slice, world.old, world.sold, world.deal]) assert.ok(listings.has(`listing:${row.id}`), row.title);
    assert.ok(!listings.has(`listing:${world.draft.id}`));
    assert.match(found.find((item) => item.id === `listing:${world.slice.id}`)?.hint ?? "", /UPB \$100K · ask \$80K/);
    assert.equal(found.find((item) => item.id === `closing:${world.closing.id}`)?.href, `/closings/${world.closing.id}`);
    assert.ok(idsOf(found, "Holdings").has(`holding:${world.holding.id}`));
    assert.ok(!idsOf(found).has(`bid:${world.freeBid.id}`), "another buyer's bid stays theirs");
    // A buyer whose account is still in review opens no listing at all.
    assert.equal(idsOf(await search(world.pending, world.word), "Listings").size, 0);
  } finally {
    await cleanWorld(world);
  }
});

test("a buyer's results never carry a borrower or a street, and searching for one finds nothing", async () => {
  const world = await makeWorld();
  try {
    for (const viewer of [world.free, world.pro]) {
      const text = JSON.stringify(await search(viewer, world.word));
      assert.doesNotMatch(text, new RegExp(`Borrower${world.tag}|Hidden${world.tag}|Client${world.tag}`));
      assert.deepEqual(await search(viewer, `Zed Borrower${world.tag}`), []);
      assert.deepEqual(await search(viewer, `Hidden${world.tag}`), []);
    }
  } finally {
    await cleanWorld(world);
  }
});

test("sellers and brokers find only their own paper, and the desk finds everything", async () => {
  const world = await makeWorld();
  try {
    const mine = await search(world.sellerA, world.word);
    assert.deepEqual(
      idsOf(mine, "Your listings"),
      new Set([world.early, world.slice, world.old, world.sold].map((row) => `listing:${row.id}`)),
    );
    assert.ok(mine.every((item) => item.group !== "Your listings" || item.href.startsWith("/seller/listings/")));
    assert.ok(idsOf(mine, "Closings").has(`closing:${world.closing.id}`), "the closing on the seller's own listing");
    // A seller's own street finds the listing, but the result shows only its title.
    const byStreet = await search(world.sellerA, `Hidden${world.tag}`);
    assert.ok(idsOf(byStreet, "Your listings").has(`listing:${world.old.id}`));
    assert.doesNotMatch(JSON.stringify(byStreet), new RegExp(`Borrower${world.tag}|Hidden${world.tag}`));

    const other = await search(world.sellerB, world.word);
    assert.deepEqual(idsOf(other, "Your listings"), new Set([`listing:${world.draft.id}`]));
    assert.ok(!idsOf(other).has(`closing:${world.closing.id}`));

    const brokered = await search(world.broker, world.word);
    assert.deepEqual(idsOf(brokered, "Your listings"), new Set([`listing:${world.deal.id}`]));
    assert.equal(brokered.find((item) => item.id === `listing:${world.deal.id}`)?.href, `/broker/deals/${world.deal.id}`);
    assert.ok(!idsOf(brokered).has(`closing:${world.closing.id}`));

    const deskFound = await search(world.desk, world.word);
    for (const row of world.listings) assert.ok(idsOf(deskFound, "Listings").has(`listing:${row.id}`), row.title);
    // The desk's own search page shows borrowers, so the palette does too, marked so it is never kept as recent.
    const borrowers = (await search(world.desk, `Borrower${world.tag}`)).filter((item) => item.group === "Borrowers");
    assert.ok(borrowers.length > 0);
    assert.ok(borrowers.every((item) => item.private === true && item.href.startsWith("/admin/listings/")));
  } finally {
    await cleanWorld(world);
  }
});

test("a search needs two characters, and a locked account finds nothing", async () => {
  const viewer = { id: "nobody", role: "ADMIN" as const, accountStatus: "APPROVED" as const, subscriptionTier: "FREE" as const, subscriptionStatus: "INCOMPLETE" as const };
  assert.deepEqual(await searchCommands(viewer, "a", { settings: SETTINGS }), []);
  assert.deepEqual(await searchCommands(viewer, "   ", { settings: SETTINGS }), []);
  assert.deepEqual(await searchCommands({ ...viewer, accountStatus: "SUSPENDED" }, "anything", { settings: SETTINGS }), []);
});
