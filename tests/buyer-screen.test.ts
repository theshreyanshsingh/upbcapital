import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { isPrivateDocument, loanOpenTo } from "../lib/acl";
import { awardOffer, roundFeedback, setBuyNow, withdrawListing } from "../lib/awards";
import { assessAgainstBox, scoreAgainstBox, seasoningMonths, type BoxCriteria, type ScoreNote } from "../lib/buy-box";
import { literal } from "../lib/db-filters";
import { appliedChips, FIGURE_KEYS, filtersFor, filtersQuery, listingMatches, parseFilters, sortFor, sortRows, type MatchNote } from "../lib/filters";
import { criteriaFrom, rescoreListing, scoreMatch } from "../lib/matching";
import { listingFigures } from "../lib/metrics";
import { addPhotos, PHOTO_LIMIT, photoForViewer, photoOpen, photoProblem, removePhoto, visiblePhotos, type PhotoViewer } from "../lib/photos";
import { prisma } from "../lib/prisma";
import { carriedFileLine, copyLoanFile, RELIST_FIELDS, relistDocuments } from "../lib/relist-file";
import { MIN_SALES, publishedResults, setPublishResult, trackRecord, type ResultClosing } from "../lib/results";
import { uploadDir } from "../lib/storage";

const DAY = 24 * 60 * 60 * 1000;
// Notices stay in the log and photos on local disk, whatever keys the local .env carries.
for (const key of ["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL"]) process.env[key] = "";

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// Timestamp-tagged people and listings nothing seeded touches.

type Role = "INDIVIDUAL_SELLER" | "BUYER" | "ADMIN";

function world() {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const users: { id: string; email: string; name: string }[] = [];
  const listings: string[] = [];
  const person = async (prefix: string, role: Role, pro = true) => {
    const user = await prisma.user.create({
      data: {
        email: `screen-${prefix}-${tag}@example.org`,
        name: `${prefix} ${tag}`,
        role,
        accountStatus: "APPROVED",
        passwordHash: "x",
        ...(role === "BUYER" && pro ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
      },
    });
    users.push(user);
    return user;
  };
  const loan = (over: Record<string, unknown> = {}) => ({
    streetAddress: "1 First St", city: "Testville", state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
    lienPosition: "FIRST", upb: 100000, interestRate: 7, monthlyPi: 800, paymentStatus: "PERFORMING", monthsDelinquent: 0,
    askingPrice: 80000, estimatedValue: 200000, ...over,
  });
  const listing = async (sellerId: string, opts: { title?: string; notes?: Record<string, unknown>[]; data?: Record<string, unknown> } = {}) => {
    const notes = opts.notes ?? [loan()];
    const row = await prisma.listing.create({
      data: {
        kind: notes.length > 1 ? "POOL" : "SINGLE",
        sellerId,
        status: "APPROVED",
        approvedAt: new Date(Date.now() - 7 * DAY),
        title: `${opts.title ?? "Screen"} ${tag}`,
        notes: { create: notes as never },
        ...(opts.data ?? {}),
      },
      include: { notes: true },
    });
    listings.push(row.id);
    return row;
  };
  const clean = async () => {
    const userIds = users.map((user) => user.id);
    const inquiryIds = (await prisma.inquiry.findMany({ where: { listingId: { in: listings } }, select: { id: true } })).map((row) => row.id);
    const closingIds = (await prisma.closing.findMany({ where: { listingId: { in: listings } }, select: { id: true } })).map((row) => row.id);
    const stored = (await prisma.document.findMany({ where: { listingId: { in: listings }, type: "PHOTO" }, select: { storedName: true } })).map((row) => row.storedName);
    await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...listings, ...inquiryIds, ...closingIds, ...userIds] } }, { actorId: { in: userIds } }] } });
    await prisma.deskThread.deleteMany({ where: { OR: [{ listingId: { in: listings } }, { inquiryId: { in: inquiryIds } }, { closingId: { in: closingIds } }] } });
    await prisma.revenueEvent.deleteMany({ where: { listingId: { in: listings } } });
    await prisma.ofacCheck.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.listing.deleteMany({ where: { id: { in: listings } } });
    await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: users.map((user) => user.email) } }, { subject: { contains: literal(tag) } }] } });
    await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    // Photos written to local disk by addPhotos. A relisted copy shares the file, so it goes once.
    for (const name of new Set(stored)) await fs.rm(path.join(uploadDir(), name), { force: true });
  };
  return { tag, person, loan, listing, clean };
}

const mail = (email: string, subject: string) => prisma.notification.findMany({ where: { toEmail: email, subject: { contains: literal(subject) } } });

// ---------------------------------------------------------------------------------------------------------------
// 1. The book's LTV filter and sort.

const card = (over: Partial<MatchNote> = {}): MatchNote => ({
  city: "Tampa", state: "FL", paymentStatus: "PERFORMING", lienPosition: "FIRST", propertyType: "SFR",
  upb: 100000, askingPrice: 80000, estimatedValue: 200000, monthlyPi: 800, interestRate: 7, tradeStatus: "AVAILABLE", ...over,
});

const metric = (note: MatchNote) => ({ ...note, estimatedValue: note.estimatedValue ?? 0, monthlyPi: note.monthlyPi ?? 0, interestRate: note.interestRate ?? 0 });

test("the book filters on LTV as the listing figures read it, with a chip, an address and Pro only", () => {
  // UPB over value: the same 50% the listing page shows.
  assert.equal(listingFigures("SINGLE", [metric(card())]).ltv, 50);
  assert.equal(listingMatches({ kind: "SINGLE", notes: [card()] }, { ltvMax: 60 }), true);
  assert.equal(listingMatches({ kind: "SINGLE", notes: [card()] }, { ltvMin: 60 }), false);
  assert.equal(listingMatches({ kind: "SINGLE", notes: [card()] }, { ltvMin: 40, ltvMax: 50 }), true);
  // A pool's LTV is the totals of the loans still for sale: 250k over 400k.
  const pool = { kind: "POOL", notes: [card(), card({ upb: 150000 }), card({ upb: 300000, estimatedValue: 100000, tradeStatus: "SOLD" })] };
  assert.equal(listingFigures("POOL", pool.notes.slice(0, 2).map(metric)).ltv, 62.5);
  assert.equal(listingMatches(pool, { ltvMin: 62, ltvMax: 63 }), true);
  assert.equal(listingMatches(pool, { ltvMax: 60 }), false);
  // No value on file means no LTV, so an LTV filter never matches it. A caller that passes only the card can't either.
  assert.equal(listingMatches({ kind: "SINGLE", notes: [card({ estimatedValue: 0 })] }, { ltvMax: 500 }), false);
  assert.equal(listingMatches({ kind: "SINGLE", notes: [{ city: "Tampa", state: "FL", paymentStatus: "PERFORMING", lienPosition: "FIRST", propertyType: "SFR", upb: 1, askingPrice: 1 }] }, { ltvMax: 90 }), false);

  const parsed = parseFilters({ ltvMin: "40", ltvMax: "80%" });
  assert.deepEqual(parsed, { ltvMin: 40, ltvMax: 80 });
  assert.deepEqual(parseFilters(Object.fromEntries(filtersQuery(parsed))), parsed);
  assert.equal(filtersQuery({ ltvMax: 80, state: "FL" }).toString(), "state=FL&ltvMax=80");
  assert.deepEqual(appliedChips({ ltvMax: 80 }).map((chip) => chip.label), ["LTV up to 80%"]);
  assert.deepEqual(appliedChips({ ltvMin: 50, ltvMax: 80 }).map((chip) => chip.label), ["LTV 50% to 80%"]);
  assert.deepEqual(appliedChips({ ltvMin: 50, ltvMax: 80 })[0].without, {});

  // A free member sees figures veiled, so LTV filters and the LTV sort are Pro only.
  assert.ok((FIGURE_KEYS as readonly string[]).includes("ltvMin") && (FIGURE_KEYS as readonly string[]).includes("ltvMax"));
  const free = filtersFor({ ltvMin: 10, ltvMax: 80, state: "FL" }, false);
  assert.equal(free.ltvMin, undefined);
  assert.equal(free.ltvMax, undefined);
  assert.equal(free.state, "FL");
  assert.deepEqual(sortFor("ltv", undefined, false), { key: "new", dir: "desc" });
  assert.deepEqual(sortFor("ltv", undefined, true), { key: "ltv", dir: "asc" });
  assert.deepEqual(sortFor("ltv", "desc", true), { key: "ltv", dir: "desc" });
});

test("the LTV sort puts the lowest first, and rows with no LTV last either way", () => {
  const row = (id: string, ltv: number | null, approvedAt: number) => ({ id, approvedAt, deadline: null, state: "FL", figures: { upb: 1, asking: 1, value: 1, priceToUpb: null, yield: null, ltv } });
  const rows = [row("high", 90, 1), row("none", null, 9), row("low", 40, 2), row("mid", 65, 3)];
  assert.deepEqual(sortRows(rows, { key: "ltv", dir: "asc" }).map((item) => item.id), ["low", "mid", "high", "none"]);
  assert.deepEqual(sortRows(rows, { key: "ltv", dir: "desc" }).map((item) => item.id), ["high", "mid", "low", "none"]);
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Buy-box LTV and seasoning limits.

const NO_LIMITS: BoxCriteria = { states: [], liens: [], statuses: [], upbMin: null, upbMax: null, priceMin: null, priceMax: null, maxPriceToUpb: null, targetYield: null };
const scored = (over: Partial<ScoreNote> = {}): ScoreNote => ({
  state: "FL", lienPosition: "FIRST", paymentStatus: "PERFORMING", upb: 100000, askingPrice: 80000, monthlyPi: 800, interestRate: 7,
  estimatedValue: 200000, seasoningMonths: 36, ...over,
});
const missOf = (notes: ScoreNote[], box: BoxCriteria) => {
  const result = assessAgainstBox(notes, box);
  return result.fit ? null : result.reason;
};

test("a buy box caps LTV on the totals, and a loan with no value can't show it fits", () => {
  assert.deepEqual(scoreAgainstBox([scored()], { ...NO_LIMITS, maxLtv: 60 })?.reasons, ["50% LTV"]);
  assert.equal(scoreAgainstBox([scored()], { ...NO_LIMITS, maxLtv: 40 }), null);
  assert.equal(missOf([scored()], { ...NO_LIMITS, maxLtv: 40 }), "The LTV of 50% is over the box's 40%.");
  assert.equal(missOf([scored({ estimatedValue: 0 })], { ...NO_LIMITS, maxLtv: 80 }), "No estimated value is on file, so the LTV can't be checked.");
  assert.equal(missOf([scored({ estimatedValue: undefined })], { ...NO_LIMITS, maxLtv: 80 }), "No estimated value is on file, so the LTV can't be checked.");
  // A pool: 300k over 400k is 75%.
  assert.ok(scoreAgainstBox([scored(), scored({ upb: 200000 })], { ...NO_LIMITS, maxLtv: 75 }));
  assert.equal(scoreAgainstBox([scored(), scored({ upb: 200000 })], { ...NO_LIMITS, maxLtv: 70 }), null);
  // A box from before these limits scores as it did.
  assert.deepEqual(scoreAgainstBox([scored({ estimatedValue: undefined, seasoningMonths: undefined })], { ...NO_LIMITS, states: ["FL"] })?.reasons, ["State fits"]);
});

test("a seasoning floor counts months since origination, and a missing origination date fails it and says so", () => {
  assert.equal(seasoningMonths(new Date("2024-03-20T00:00:00Z"), new Date("2026-03-19T00:00:00Z")), 23);
  assert.equal(seasoningMonths(new Date("2024-03-20T00:00:00Z"), new Date("2026-03-20T00:00:00Z")), 24);
  assert.equal(seasoningMonths(new Date("2026-04-01T00:00:00Z"), new Date("2026-03-01T00:00:00Z")), 0);
  assert.equal(seasoningMonths(null), null);

  assert.deepEqual(scoreAgainstBox([scored()], { ...NO_LIMITS, minSeasoningMonths: 24 })?.reasons, ["Seasoned 24+ months"]);
  assert.equal(missOf([scored({ seasoningMonths: 6 })], { ...NO_LIMITS, minSeasoningMonths: 24 }), "Seasoned 6 months, under the box's 24.");
  assert.equal(missOf([scored({ seasoningMonths: null })], { ...NO_LIMITS, minSeasoningMonths: 12 }), "No origination date is on file, so the loan can't show 12 months of seasoning.");
  assert.equal(scoreAgainstBox([scored({ seasoningMonths: undefined })], { ...NO_LIMITS, minSeasoningMonths: 12 }), null);
  // A pool fits on half its UPB, and the reason names the loans with no date.
  const pool = assessAgainstBox([scored({ upb: 200000 }), scored({ seasoningMonths: null })], { ...NO_LIMITS, minSeasoningMonths: 24 });
  assert.ok(pool.fit);
  assert.deepEqual(pool.fit && pool.reasons, ["67% of UPB seasoned 24+ months", "1 loan has no origination date"]);
  assert.equal(
    missOf([scored(), scored({ seasoningMonths: null, upb: 150000 }), scored({ seasoningMonths: null, upb: 150000 })], { ...NO_LIMITS, minSeasoningMonths: 24 }),
    "Less than half the UPB is seasoned 24 months or more. 2 loans have no origination date.",
  );
  // A box with no seasoning floor doesn't need a date.
  assert.ok(scoreAgainstBox([scored({ seasoningMonths: null })], { ...NO_LIMITS, maxLtv: 80 }));

  const criteria = criteriaFrom({ states: "FL", liens: "", statuses: "", upbMin: null, upbMax: null, priceMin: null, priceMax: null, maxPriceToUpb: null, targetYield: null, maxLtv: 75, minSeasoningMonths: 12 });
  assert.equal(criteria.maxLtv, 75);
  assert.equal(criteria.minSeasoningMonths, 12);
});

test("a standing price applies the same LTV limit, so a box never prices paper it wouldn't take", () => {
  const user = { role: "BUYER", accountStatus: "APPROVED", subscriptionTier: "PRO", subscriptionStatus: "ACTIVE", subscriptionCurrentPeriodEnd: null };
  const box = (maxLtv: number) => ({
    id: "box", userId: "u", name: "Box", states: "", liens: "", statuses: "", upbMin: null, upbMax: null, priceMin: null, priceMax: null, maxPriceToUpb: null,
    targetYield: null, maxLtv, minSeasoningMonths: null, standingBids: true, bidBasis: "UPB", bidPercent: 70, bidCap: null, bidSpread: null, active: true, user,
  }) as never;
  const standing = [{ id: "n", upb: 100000, askingPrice: 90000, interestRate: 7, monthlyPi: 800, paymentStatus: "PERFORMING", maturityDate: null, tradeStatus: "AVAILABLE" }];
  // 100k over 125k is 80%.
  const notes = [scored({ upb: 100000, askingPrice: 90000, estimatedValue: 125000 })];
  const over = scoreMatch("SINGLE", standing, box(60), notes, new Date(), 0, null);
  assert.equal(over.result, null);
  assert.equal(over.price, null);
  const fits = scoreMatch("SINGLE", standing, box(85), notes, new Date(), 0, null);
  assert.equal(fits.price, 70000);
  assert.ok(fits.result?.reasons.includes("80% LTV"));
});

test("matching writes LTV and seasoning reasons, and drops a loan with no origination date", async () => {
  const w = world();
  try {
    const seller = await w.person("seller", "INDIVIDUAL_SELLER");
    const buyer = await w.person("buyer", "BUYER");
    const box = await prisma.buyBox.create({ data: { userId: buyer.id, name: `Seasoned ${w.tag}`, states: "ZZ", maxLtv: 70, minSeasoningMonths: 12 } });
    const seasoned = await w.listing(seller.id, { title: "Seasoned", notes: [w.loan({ originationDate: new Date(Date.now() - 3 * 365 * DAY) })] });
    const undated = await w.listing(seller.id, { title: "Undated" });
    const pool = await w.listing(seller.id, {
      title: "Pool",
      notes: [w.loan({ upb: 120000, originationDate: new Date(Date.now() - 400 * DAY) }), w.loan({ streetAddress: "2 Second St", upb: 60000 })],
    });
    for (const listing of [seasoned, undated, pool]) await rescoreListing(listing.id, false);
    const match = (listingId: string) => prisma.listingMatch.findUnique({ where: { listingId_buyBoxId: { listingId, buyBoxId: box.id } } });
    assert.equal((await match(seasoned.id))?.reasons, "State fits · 50% LTV · Seasoned 12+ months");
    assert.equal(await match(undated.id), null);
    assert.equal((await match(pool.id))?.reasons, "State fits · 45% LTV · 67% of UPB seasoned 12+ months · 1 loan has no origination date");
  } finally {
    await w.clean();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Property photos follow the address veil and stay out of the data room.

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x40, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(64, 3)]);

test("a photo opens exactly where the loan's street address does", () => {
  const live = { id: "L", status: "APPROVED" };
  const inContract = { id: "L", status: "PENDING" };
  const free = { id: "N", listingId: "L", tradeStatus: "AVAILABLE" };
  const sold = { id: "N", listingId: "L", tradeStatus: "IN_CONTRACT" };
  const nobody: PhotoViewer = { admin: false, owner: false, signedNda: false, deal: { whole: false, loans: new Set() } };
  const viewers: PhotoViewer[] = [
    nobody,
    { ...nobody, signedNda: true },
    { ...nobody, deal: { whole: true, loans: new Set() } },
    { ...nobody, signedNda: true, deal: { whole: false, loans: new Set(["N"]) } },
    { ...nobody, signedNda: true, deal: { whole: false, loans: new Set(["other"]) } },
  ];
  // For a buyer, the photo rule is the listing page's street rule, case for case.
  for (const viewer of viewers) {
    for (const listing of [live, inContract]) {
      for (const note of [free, sold]) {
        const street = loanOpenTo({ tradeStatus: note.tradeStatus, listingStatus: listing.status, signedNda: viewer.signedNda, wholeParty: viewer.deal.whole, loanParty: viewer.deal.loans.has(note.id) });
        assert.equal(photoOpen(viewer, listing, note), street, JSON.stringify({ viewer: { ...viewer, deal: [...viewer.deal.loans] }, listing, note }));
      }
    }
  }
  assert.equal(photoOpen({ ...nobody, signedNda: true }, live, free), true);
  assert.equal(photoOpen({ ...nobody, signedNda: true }, inContract, free), false);
  // The listing's own side and the desk always see their photos. A photo with no loan, or another listing's, opens to no buyer.
  assert.equal(photoOpen({ ...nobody, owner: true }, inContract, sold), true);
  assert.equal(photoOpen({ ...nobody, admin: true }, inContract, sold), true);
  assert.equal(photoOpen({ ...nobody, signedNda: true }, live, null), false);
  assert.equal(photoOpen({ ...nobody, signedNda: true }, live, { ...free, listingId: "elsewhere" }), false);
});

test("photos are JPEG, PNG or WebP, checked by their bytes and size", () => {
  assert.equal(photoProblem("front.jpg", JPEG), null);
  assert.equal(photoProblem("front.JPEG", JPEG), null);
  assert.equal(photoProblem("yard.png", PNG), null);
  assert.equal(photoProblem("kitchen.webp", WEBP), null);
  assert.equal(photoProblem("deed.pdf", Buffer.from("%PDF-1.4")), "Photos are JPEG, PNG or WebP.");
  assert.equal(photoProblem("page.html", Buffer.from("<html>")), "Photos are JPEG, PNG or WebP.");
  assert.equal(photoProblem("fake.jpg", PNG), "The file contents do not match its type.");
  assert.equal(photoProblem("fake.webp", JPEG), "The file contents do not match its type.");
  assert.equal(photoProblem("huge.jpg", Buffer.concat([JPEG, Buffer.alloc(8 * 1024 * 1024)])), "That photo is over 8 MB.");
  assert.equal(photoProblem("empty.jpg", Buffer.alloc(0)), "Choose a file.");
});

test("photo access follows the address veil, photos stay out of the data room, and a listing holds twelve", async () => {
  const w = world();
  try {
    const seller = await w.person("seller", "INDIVIDUAL_SELLER");
    const desk = await w.person("desk", "ADMIN");
    const signed = await w.person("signed", "BUYER");
    const waiting = await w.person("waiting", "BUYER");
    const stranger = await w.person("stranger", "BUYER");
    const listing = await w.listing(seller.id, { title: "Photos" });
    await prisma.ndaAcknowledgment.create({ data: { userId: signed.id, listingId: listing.id } });
    // A room whose seller approves each bidder: the NDA is signed but access waits.
    await prisma.ndaAcknowledgment.create({ data: { userId: waiting.id, listingId: listing.id, accessStatus: "PENDING" } });
    const room = await prisma.document.create({ data: { listingId: listing.id, type: "BPO", originalName: "bpo.pdf", storedName: `bpo-${w.tag}.pdf`, mime: "application/pdf", size: 10 } });

    assert.deepEqual(await addPhotos(signed, { listingId: listing.id, files: [{ name: "a.jpg", bytes: JPEG }] }), { ok: false, error: "That listing isn't yours." });
    const added = await addPhotos(seller, { listingId: listing.id, files: [{ name: "front.jpg", bytes: JPEG }, { name: "notes.pdf", bytes: Buffer.from("%PDF-1.4") }] });
    assert.deepEqual(added, { ok: true, value: { added: 1, skipped: ["notes.pdf"] } });
    const photo = await prisma.document.findFirstOrThrow({ where: { listingId: listing.id, type: "PHOTO" } });
    // A single note's photo is that loan's, so it keeps the loan's own rule wherever documents are read.
    assert.equal(photo.noteId, listing.notes[0].id);
    assert.equal(photo.mime, "image/jpeg");

    const status = async (user: Parameters<typeof photoForViewer>[0]) => (await photoForViewer(user, photo.id)).status;
    assert.equal(await status(seller), 200);
    assert.equal(await status(desk), 200);
    assert.equal(await status(signed), 200);
    assert.equal(await status(waiting), 403);
    assert.equal(await status(stranger), 403);
    // The photo route serves photos only, never another document of the room.
    assert.equal((await photoForViewer(signed, room.id)).status, 404);
    assert.equal((await photoForViewer(signed, "missing")).status, 404);
    // In contract, the street closes to bidders, and so does the photo.
    await prisma.listing.update({ where: { id: listing.id }, data: { status: "PENDING" } });
    assert.equal(await status(signed), 403);
    assert.equal(await status(seller), 200);
    await prisma.listing.update({ where: { id: listing.id }, data: { status: "APPROVED" } });

    // The gallery shows what the route serves.
    const notes = listing.notes.map((note) => ({ id: note.id, listingId: note.listingId, tradeStatus: note.tradeStatus }));
    const seen = await visiblePhotos({ admin: false, owner: false, signedNda: false, deal: { whole: false, loans: new Set() } }, { id: listing.id, status: "APPROVED", notes });
    assert.deepEqual({ shown: seen.shown.length, closed: seen.closed }, { shown: 0, closed: 1 });
    const opened = await visiblePhotos({ admin: false, owner: false, signedNda: true, deal: { whole: false, loans: new Set() } }, { id: listing.id, status: "APPROVED", notes });
    assert.deepEqual(opened.shown.map((row) => row.id), [photo.id]);

    // The data room: the room's own filter drops the photo, and the listing pages read documents without photos.
    assert.equal(isPrivateDocument(photo, listing), true);
    const pageDocuments = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id }, include: { documents: { where: { type: { not: "PHOTO" } } } } });
    assert.deepEqual(pageDocuments.documents.map((row) => row.id), [room.id]);
    assert.deepEqual(pageDocuments.documents.filter((row) => !isPrivateDocument(row, listing)).map((row) => row.id), [room.id]);

    // Twelve to a listing.
    const more = await addPhotos(seller, { listingId: listing.id, files: Array.from({ length: PHOTO_LIMIT }, (_, index) => ({ name: `p${index}.png`, bytes: PNG })) });
    assert.ok(more.ok);
    assert.equal(more.ok && more.value.added, PHOTO_LIMIT - 1);
    assert.equal(more.ok && more.value.skipped.length, 1);
    assert.deepEqual(await addPhotos(desk, { listingId: listing.id, files: [{ name: "one.webp", bytes: WEBP }] }), { ok: false, error: "A listing holds up to 12 photos. Remove one to add another." });

    // Only the listing's side or the desk removes one.
    assert.deepEqual(await removePhoto(stranger, photo.id), { ok: false, error: "That listing isn't yours." });
    assert.deepEqual(await removePhoto(seller, photo.id), { ok: true, value: { listingId: listing.id } });
    assert.equal(await prisma.document.count({ where: { id: photo.id } }), 0);
    assert.deepEqual(await removePhoto(seller, photo.id), { ok: false, error: "That photo is already gone." });
    // A pool's photo names its loan.
    const pool = await w.listing(seller.id, { title: "Pool photos", notes: [w.loan(), w.loan({ streetAddress: "2 Second St" })] });
    assert.deepEqual(await addPhotos(seller, { listingId: pool.id, files: [{ name: "a.jpg", bytes: JPEG }] }), { ok: false, error: "Pick the loan these photos show." });
    assert.ok((await addPhotos(seller, { listingId: pool.id, noteId: pool.notes[1].id, files: [{ name: "a.jpg", bytes: JPEG }] })).ok);
  } finally {
    await w.clean();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 4. What a losing bidder hears.

test("a losing bidder hears the round's size, their place and the reserve, never an amount", () => {
  const bids = [{ id: "won", price: 70000 }, { id: "top", price: 80000 }, { id: "low", price: 60000 }, { id: "twin", price: 60000 }];
  assert.equal(roundFeedback({ winnerPrice: 70000, reserve: 50000, bids }, "top"), "The round had 4 bids, and yours ranked 1st by price. The winning bid met the seller's reserve.");
  assert.equal(roundFeedback({ winnerPrice: 70000, reserve: 50000, bids }, "low"), "The round had 4 bids, and yours ranked 3rd by price, tied with another bid. The winning bid met the seller's reserve.");
  assert.equal(roundFeedback({ winnerPrice: 70000, reserve: 90000, bids }, "top"), "The round had 4 bids, and yours ranked 1st by price. The winning bid was under the seller's reserve, and the seller approved it.");
  assert.equal(roundFeedback({ winnerPrice: 70000, reserve: null, bids }, "top"), "The round had 4 bids, and yours ranked 1st by price. The seller set no reserve and approved the winning bid.");
  assert.equal(roundFeedback({ winnerPrice: 70000, reserve: null, bids }, "nobody"), null);
  for (const id of ["top", "low", "twin"]) assert.doesNotMatch(roundFeedback({ winnerPrice: 70000, reserve: 50000, bids }, id) ?? "", /\$|\d{3,}/);
});

test("after an award each losing bidder hears where they stood, and a buy-it-now win tells them nothing more", async () => {
  const w = world();
  try {
    const seller = await w.person("seller", "INDIVIDUAL_SELLER");
    const desk = await w.person("desk", "ADMIN");
    const [low, mid, high] = [await w.person("low", "BUYER"), await w.person("mid", "BUYER"), await w.person("high", "BUYER")];
    const listing = await w.listing(seller.id, { title: "Round", data: { reservePrice: 50000 } });
    const bid = (buyerId: string, amount: number, extra: Record<string, unknown> = {}) =>
      prisma.inquiry.create({ data: { listingId: listing.id, buyerId, type: "OFFER", status: "OPEN", amount, ...extra } });
    await bid(low.id, 60000);
    const winner = await bid(mid.id, 70000);
    await bid(high.id, 80000);
    assert.equal((await awardOffer(winner.id, desk.id)).error, null);
    const [highNote] = await mail(high.email, `Bid not selected · ${listing.title}`);
    const [lowNote] = await mail(low.email, `Bid not selected · ${listing.title}`);
    assert.equal(highNote.body, "Another bid was accepted. The round had 3 bids, and yours ranked 1st by price. The winning bid met the seller's reserve. Thank you for bidding.");
    assert.equal(lowNote.body, "Another bid was accepted. The round had 3 bids, and yours ranked 3rd by price. The winning bid met the seller's reserve. Thank you for bidding.");
    for (const body of [highNote.body, lowNote.body]) {
      assert.doesNotMatch(body, /\$|70,000|70000|80,000|60,000/);
      assert.ok(!body.includes(mid.name));
    }

    // A buy-it-now win: its price is on the listing, so a rank would give it away.
    const takeIt = await w.listing(seller.id, { title: "Take it", data: { buyNowPrice: 90000, buyNowSetAt: new Date(), reservePrice: 50000 } });
    await prisma.inquiry.create({ data: { listingId: takeIt.id, buyerId: low.id, type: "OFFER", status: "OPEN", amount: 85000 } });
    const confirmed = await prisma.inquiry.create({ data: { listingId: takeIt.id, buyerId: high.id, type: "OFFER", status: "OPEN", amount: 90000, buyNow: true } });
    assert.equal((await awardOffer(confirmed.id, desk.id)).error, null);
    const [plain] = await mail(low.email, `Bid not selected · ${takeIt.title}`);
    assert.equal(plain.body, "Another bid was accepted. Thank you for bidding.");
  } finally {
    await w.clean();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 5. Watchers hear about buy it now and a withdrawal.

test("watchers hear a buy-it-now price is there without the amount, and hear once when the listing is withdrawn", async () => {
  const w = world();
  try {
    const seller = await w.person("seller", "INDIVIDUAL_SELLER");
    const watcher = await w.person("watcher", "BUYER");
    const bidder = await w.person("bidder", "BUYER");
    const quiet = await w.person("quiet", "BUYER");
    await prisma.user.update({ where: { id: quiet.id }, data: { watchAlerts: false } });
    const listing = await w.listing(seller.id, { title: "Watched" });
    for (const user of [watcher, bidder, quiet, seller]) await prisma.favorite.create({ data: { userId: user.id, listingId: listing.id } });
    await prisma.inquiry.create({ data: { listingId: listing.id, buyerId: bidder.id, type: "OFFER", status: "OPEN", amount: 100000 } });

    const subject = `Buy it now available · ${listing.title}`;
    assert.equal((await setBuyNow(listing.id, seller.id, 150000)).error, null);
    const [notice] = await mail(watcher.email, subject);
    assert.ok(notice);
    assert.doesNotMatch(notice.body, /150,000|150000|\$/);
    assert.match(notice.body, /a listing you saved, has a buy-it-now price/);
    assert.ok(notice.body.includes(`/marketplace/${listing.id}`));
    assert.equal((await mail(seller.email, subject)).length, 0);
    assert.equal((await mail(quiet.email, subject)).length, 0);
    // A changed price is news again. The same price and a removal are not.
    assert.equal((await setBuyNow(listing.id, seller.id, 160000)).error, null);
    assert.equal((await setBuyNow(listing.id, seller.id, 160000)).error, null);
    assert.equal((await setBuyNow(listing.id, seller.id, null)).error, null);
    assert.equal((await mail(watcher.email, subject)).length, 2);

    assert.equal((await withdrawListing(listing.id, seller.id)).error, null);
    const [gone] = await mail(watcher.email, `Listing withdrawn · ${listing.title}`);
    assert.match(gone.body, /a listing you saved, was withdrawn\. It is off the book/);
    // The bidder hears once, through their own bid, not again as a watcher.
    const bidderNotes = await mail(bidder.email, `Listing withdrawn · ${listing.title}`);
    assert.equal(bidderNotes.length, 1);
    assert.match(bidderNotes[0].body, /your bid is closed/);
    assert.equal((await mail(seller.email, `Listing withdrawn · ${listing.title}`)).length, 0);
    assert.equal((await mail(quiet.email, `Listing withdrawn · ${listing.title}`)).length, 0);
  } finally {
    await w.clean();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 6. The public results page.

const finished = (over: Partial<ResultClosing> & { days?: number; lien?: string; status?: string; payment?: string } = {}): ResultClosing => {
  const openedAt = new Date("2026-02-01T12:00:00Z");
  const { days = 30, lien = "FIRST", payment = "PERFORMING", ...rest } = over;
  return {
    id: crypto.randomUUID(),
    status: "COMPLETE",
    openedAt,
    closedAt: new Date(openedAt.getTime() + days * DAY),
    salePrice: 61000,
    noteId: null,
    listing: { kind: "SINGLE", publishResult: null, notes: [{ id: "n1", state: "FL", lienPosition: lien, paymentStatus: payment, upb: 100000 }] },
    ...rest,
  };
};

test("the track record waits for enough closed sales, then shows the rate, the median and the mix", () => {
  assert.equal(MIN_SALES, 3);
  const few = trackRecord([finished(), finished(), finished({ status: "CANCELED", closedAt: null })]);
  assert.deepEqual(few, { closed: 2, canceled: 1, closeRate: null, medianDays: null, byLien: [], byPerformance: [], enough: false });
  assert.equal(trackRecord([]).enough, false);

  const record = trackRecord([
    finished({ days: 10 }),
    finished({ days: 40, lien: "SECOND", payment: "NON_PERFORMING" }),
    finished({ days: 20 }),
    finished({ status: "CANCELED", closedAt: null }),
    // Still open: not part of the record.
    finished({ status: "OPEN", closedAt: null }),
  ]);
  assert.equal(record.enough, true);
  assert.equal(record.closed, 3);
  assert.equal(record.canceled, 1);
  assert.equal(record.closeRate, 0.75);
  assert.equal(record.medianDays, 20);
  assert.deepEqual(record.byLien, [{ label: "First lien", count: 2 }, { label: "Second lien", count: 1 }]);
  assert.deepEqual(record.byPerformance, [{ label: "Performing", count: 2 }, { label: "Non-performing", count: 1 }]);
});

test("only sales whose seller agreed show one by one, anonymised", () => {
  const pool = {
    kind: "POOL",
    publishResult: true,
    notes: [
      { id: "a", state: "GA", lienPosition: "FIRST", paymentStatus: "NON_PERFORMING", upb: 300000 },
      { id: "b", state: "FL", lienPosition: "SECOND", paymentStatus: "PERFORMING", upb: 50000 },
    ],
  };
  const rows = publishedResults([
    finished(),
    finished({ listing: { ...finished().listing, publishResult: false } }),
    finished({ listing: { ...finished().listing, publishResult: true }, salePrice: 61400, closedAt: new Date("2026-03-05T12:00:00Z") }),
    finished({ status: "CANCELED", closedAt: null, listing: { ...finished().listing, publishResult: true } }),
    // One loan sold out of a pool shows that loan alone.
    finished({ listing: pool, noteId: "a", salePrice: 150000, closedAt: new Date("2026-04-10T12:00:00Z") }),
    finished({ listing: pool, salePrice: 245000, closedAt: new Date("2026-05-10T12:00:00Z") }),
  ]);
  assert.deepEqual(rows.map((row) => ({ kind: row.kind, loanCount: row.loanCount, place: row.place, lien: row.lien, performance: row.performance, upbBand: row.upbBand, ofUpb: row.ofUpb, month: row.month })), [
    { kind: "POOL", loanCount: 2, place: "FL, GA", lien: "Mixed liens", performance: "Mixed performance", upbBand: "$250–500k", ofUpb: 70, month: "May 2026" },
    { kind: "SINGLE", loanCount: 1, place: "GA", lien: "First lien", performance: "Non-performing", upbBand: "$250–500k", ofUpb: 50, month: "April 2026" },
    { kind: "SINGLE", loanCount: 1, place: "FL", lien: "First lien", performance: "Performing", upbBand: "$100–250k", ofUpb: 61, month: "March 2026" },
  ]);
  // Nothing that names the loan or the parties, and no exact balance or price.
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ["closedAt", "kind", "lien", "loanCount", "month", "ofUpb", "performance", "place", "upbBand"]);
});

test("the seller, the filing broker or the desk sets whether a sale is published", async () => {
  const w = world();
  try {
    const seller = await w.person("seller", "INDIVIDUAL_SELLER");
    const desk = await w.person("desk", "ADMIN");
    const buyer = await w.person("buyer", "BUYER");
    const listing = await w.listing(seller.id, { title: "Publish" });
    const flag = async () => (await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).publishResult;
    assert.deepEqual(await setPublishResult(buyer, listing.id, true), { error: "That listing isn't yours." });
    assert.equal(await flag(), null);
    assert.deepEqual(await setPublishResult(seller, listing.id, true), { error: null, changed: true });
    assert.equal(await flag(), true);
    assert.deepEqual(await setPublishResult(seller, listing.id, true), { error: null, changed: false });
    assert.deepEqual(await setPublishResult(desk, listing.id, false), { error: null, changed: true });
    assert.equal(await flag(), false);
  } finally {
    await w.clean();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 7. A relist carries the verified file.

test("a relist copies every loan field and the verified file, keeps the dates, and leaves private papers behind", async () => {
  const w = world();
  try {
    const seller = await w.person("seller", "INDIVIDUAL_SELLER");
    const desk = await w.person("desk", "ADMIN");
    const buyer = await w.person("buyer", "BUYER");
    const checkedOn = new Date("2026-01-15T15:00:00Z");
    const verified = { interestRate: { at: checkedOn.toISOString(), by: desk.id, source: "Pay history", value: "7" } };
    const source = await w.listing(seller.id, {
      title: "Source",
      data: { authorizationKey: `auth-${w.tag}`, status: "SOLD" },
      notes: [w.loan({
        tradeStatus: "SOLD", loanNumber: "LN-77", payString: "000000", originationDate: new Date("2019-05-01T00:00:00Z"), maturityDate: new Date("2049-05-01T00:00:00Z"),
        servicerName: "FCI", modified: false, creditScore: 712, creditScoreType: "FICO", mersMin: "1000000-0000000001-1", loanPurpose: "PURCHASE",
        hoaLien: false, avmValue: 210000, avmProvider: "Desk AVM", verifiedFields: verified, memo: "Seller memo",
      })],
    });
    const note = source.notes[0];
    const doc = (type: string, extra: Record<string, unknown> = {}) =>
      prisma.document.create({ data: { listingId: source.id, type: type as never, originalName: `${type}.pdf`, storedName: `${type}-${w.tag}`, mime: "application/pdf", size: 10, createdAt: new Date("2025-12-01T00:00:00Z"), ...extra } });
    const bpo = await doc("BPO");
    const oe = await doc("OE_REPORT", { noteId: note.id });
    const photo = await doc("PHOTO", { noteId: note.id, mime: "image/jpeg" });
    await doc("NDA");
    await doc("OTHER", { storedName: `auth-${w.tag}` });
    await prisma.collateralItem.create({ data: { noteId: note.id, kind: "ORIGINAL_NOTE", status: "PRESENT", detail: "Endorsed in blank", documentId: oe.id, photoDocumentId: photo.id, updatedById: desk.id, createdAt: checkedOn } });
    await prisma.collateralItem.create({ data: { noteId: note.id, kind: "ASSIGNMENT", status: "MISSING", sequence: 1, cureOwner: "Seller", createdAt: checkedOn } });
    await prisma.riskCheck.create({ data: { noteId: note.id, kind: "BANKRUPTCY", result: "CLEAR", source: "PACER", documentId: oe.id, checkedById: desk.id, checkedAt: checkedOn } });
    await prisma.fieldDiscrepancy.create({ data: { noteId: note.id, listingId: source.id, field: "interestRate", tapeValue: "7", documentValue: "7.25", source: "Note", status: "EXPLAINED", sellerNote: "Rate stepped down in 2022.", resolvedAt: checkedOn } });
    await prisma.fieldDiscrepancy.create({ data: { noteId: note.id, listingId: source.id, field: "upb", tapeValue: "100000", documentValue: "99000", source: "Pay history", status: "ACCEPTED", resolvedAt: checkedOn } });
    // What never travels: the bid, the NDA and the view.
    await prisma.inquiry.create({ data: { listingId: source.id, buyerId: buyer.id, type: "OFFER", status: "ACCEPTED", amount: 70000 } });
    await prisma.ndaAcknowledgment.create({ data: { userId: buyer.id, listingId: source.id } });
    await prisma.listingView.create({ data: { listingId: source.id, userId: buyer.id } });

    // The copy rules cover every scalar on the loan but its identity, listing, trade status and filing date.
    const scalars = Object.values(Prisma.NoteScalarFieldEnum) as string[];
    assert.deepEqual(scalars.filter((field) => !RELIST_FIELDS.includes(field)).sort(), ["createdAt", "id", "listingId", "tradeStatus"]);
    for (const field of ["loanNumber", "payString", "originationDate", "creditScore", "verifiedFields", "mersMin", "servicerName", "avmValue"]) assert.ok(RELIST_FIELDS.includes(field), field);

    const target = await w.listing(seller.id, { title: "Relist", notes: [] });
    const file = await copyLoanFile({ source, notes: source.notes, toListingId: target.id, overrides: () => ({ askingPrice: 99000 }), wholeSource: true });
    assert.deepEqual({ documents: file.documents, collateral: file.collateral, risks: file.risks, discrepancies: file.discrepancies, verifiedFields: file.verifiedFields }, { documents: 3, collateral: 2, risks: 1, discrepancies: 2, verifiedFields: 1 });
    const copy = await prisma.note.findFirstOrThrow({ where: { listingId: target.id } });
    assert.equal(file.notes.get(note.id), copy.id);
    for (const field of RELIST_FIELDS.filter((name) => name !== "askingPrice")) {
      assert.deepEqual((copy as Record<string, unknown>)[field], (note as Record<string, unknown>)[field], field);
    }
    assert.equal(copy.askingPrice, 99000);
    assert.equal(copy.tradeStatus, "AVAILABLE");

    const documents = await prisma.document.findMany({ where: { listingId: target.id }, orderBy: { type: "asc" } });
    assert.deepEqual(documents.map((row) => row.type), ["BPO", "OE_REPORT", "PHOTO"]);
    assert.ok(documents.every((row) => row.storedName !== `auth-${w.tag}` && row.type !== "NDA"));
    const copied = new Map(documents.map((row) => [row.type, row]));
    assert.equal(copied.get("BPO")?.noteId ?? null, null);
    assert.equal(copied.get("OE_REPORT")?.noteId, copy.id);
    assert.equal(copied.get("PHOTO")?.noteId, copy.id);
    // Each file keeps the day it was filed, and a loan's own file still opens only by its loan's rule.
    assert.ok(documents.every((row) => row.createdAt.toISOString() === "2025-12-01T00:00:00.000Z"));
    assert.equal(isPrivateDocument(copied.get("OE_REPORT")!, target), true);
    assert.notEqual(copied.get("BPO")?.id, bpo.id);

    const collateral = await prisma.collateralItem.findMany({ where: { noteId: copy.id }, orderBy: { sequence: "asc" } });
    assert.deepEqual(collateral.map((row) => [row.kind, row.status, row.detail, row.cureOwner]), [["ORIGINAL_NOTE", "PRESENT", "Endorsed in blank", ""], ["ASSIGNMENT", "MISSING", "", "Seller"]]);
    assert.equal(collateral[0].documentId, copied.get("OE_REPORT")?.id);
    assert.equal(collateral[0].photoDocumentId, copied.get("PHOTO")?.id);
    assert.equal(collateral[0].createdAt.toISOString(), checkedOn.toISOString());
    const [risk] = await prisma.riskCheck.findMany({ where: { noteId: copy.id } });
    assert.deepEqual([risk.kind, risk.result, risk.source, risk.checkedById, risk.documentId], ["BANKRUPTCY", "CLEAR", "PACER", desk.id, copied.get("OE_REPORT")?.id]);
    // Verified for the earlier sale: the check keeps its date rather than reading as fresh.
    assert.equal(risk.checkedAt.toISOString(), checkedOn.toISOString());
    const differences = await prisma.fieldDiscrepancy.findMany({ where: { noteId: copy.id }, orderBy: { field: "asc" } });
    assert.deepEqual(differences.map((row) => [row.field, row.status, row.listingId]), [["interestRate", "EXPLAINED", target.id], ["upb", "ACCEPTED", target.id]]);
    assert.equal(differences[0].sellerNote, "Rate stepped down in 2022.");
    assert.equal(differences[0].resolvedAt?.toISOString(), checkedOn.toISOString());

    assert.equal(await prisma.inquiry.count({ where: { listingId: target.id } }), 0);
    assert.equal(await prisma.ndaAcknowledgment.count({ where: { listingId: target.id } }), 0);
    assert.equal(await prisma.listingView.count({ where: { listingId: target.id } }), 0);

    // A participation's share of the balance is a new figure, so a difference on the old balance stays behind. Without
    // every loan, the room's files stay behind too.
    const slice = await w.listing(seller.id, { title: "Slice", notes: [] });
    const half = await copyLoanFile({ source, notes: source.notes, toListingId: slice.id, overrides: (row) => ({ upb: row.upb / 2, askingPrice: 40000 }), wholeSource: false });
    assert.equal(half.discrepancies, 1);
    assert.deepEqual((await prisma.document.findMany({ where: { listingId: slice.id } })).map((row) => row.type).sort(), ["OE_REPORT", "PHOTO"]);
    assert.deepEqual(relistDocuments({ authorizationKey: `auth-${w.tag}`, documents: await prisma.document.findMany({ where: { listingId: source.id } }) }, new Set(), true).map((row) => row.type), ["BPO"]);

    assert.equal(carriedFileLine(new Date("2026-03-03T12:00:00Z")), "The desk verified this loan file for the earlier sale on Mar 3, 2026, and it carries over as it was. Each check shows the date it was made.");
  } finally {
    await w.clean();
  }
});
