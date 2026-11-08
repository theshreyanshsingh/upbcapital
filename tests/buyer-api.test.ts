import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import { GET as getHoldings } from "../app/api/v1/holdings/route";
import { GET as getListing } from "../app/api/v1/listings/[id]/route";
import { GET as getListings } from "../app/api/v1/listings/route";
import { GET as getMatches } from "../app/api/v1/matches/route";
import { GET as getOffer } from "../app/api/v1/offers/[id]/route";
import { GET as getOffers } from "../app/api/v1/offers/route";
import { POST as postTape } from "../app/api/v1/tapes/route";
import { BUYER_SCOPES, buyerApiProblem, buyerKeyProblem, cleanBuyerScopes, hashKey, mintKey, scopesOf, userForApiKey } from "../lib/api-keys";
import { remindBidDeadlines } from "../lib/jobs";
import { prisma } from "../lib/prisma";
import { watchReprice } from "../lib/watchers";
import { BUYER_WEBHOOK_EVENTS, cleanEvents, emitBuyerWebhook, emitWebhook, type WebhookSender } from "../lib/webhooks";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
const made = { users: [] as string[], listings: [] as string[], emails: [] as string[], tokens: [] as string[] };
const SECRET = { borrower: `Borrower Hidden ${tag}`, street: `77 Hidden Ave ${tag}`, zip: "99877", memo: `Memo hidden ${tag}`, loanNumber: `LN-${tag}`, file: `room-file-${tag}.pdf` };

type Role = "BUYER" | "INSTITUTIONAL_SELLER";

async function person(who: string, role: Role, data: Partial<Prisma.UserCreateInput> = {}) {
  const user = await prisma.user.create({
    data: {
      email: `buyer-api-${who}-${tag}@example.org`,
      name: `Buyer API ${who} ${tag}`,
      role,
      accountStatus: "APPROVED",
      passwordHash: "x",
      ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
      ...data,
    },
  });
  made.users.push(user.id);
  made.emails.push(user.email);
  return user;
}

async function key(userId: string, scopes: string | null = BUYER_SCOPES.join(",")) {
  const minted = mintKey();
  const row = await prisma.apiKey.create({ data: { userId, name: `Key ${tag}`, prefix: minted.prefix, hash: minted.hash, ...(scopes == null ? {} : { scopes }) } });
  made.tokens.push(minted.token);
  return { token: minted.token, id: row.id };
}

async function listing(sellerId: string, input: { title: string; visibility?: string; state?: string; lien?: "FIRST" | "SECOND"; upb?: number; bidMode?: "SEALED"; bidDeadline?: Date } = { title: "Plain" }) {
  const row = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId,
      status: "APPROVED",
      approvedAt: new Date(Date.now() - 2 * HOUR),
      // Already claimed, so nothing here sends the desk a standing-bid notice.
      standingBidsNotifiedAt: new Date(),
      title: `${input.title} ${tag}`,
      summary: "A test listing.",
      ...(input.visibility ? { visibility: input.visibility } : {}),
      ...(input.bidMode ? { bidMode: input.bidMode, bidDeadline: input.bidDeadline } : {}),
      notes: {
        create: [{
          streetAddress: SECRET.street, city: "Quietville", state: input.state ?? "XQ", zip: SECRET.zip, propertyType: "SFR", occupancy: "VACANT",
          lienPosition: input.lien ?? "FIRST", upb: input.upb ?? 200000, interestRate: 7, monthlyPi: 1400, paymentStatus: "PERFORMING", monthsDelinquent: 0,
          askingPrice: 120000, estimatedValue: 260000, borrowerName: SECRET.borrower, memo: SECRET.memo, loanNumber: SECRET.loanNumber,
          avmValue: 255000, avmProvider: "mock",
        }] as never,
      },
    },
  });
  made.listings.push(row.id);
  return row;
}

function call(handler: (request: Request, context: never) => Promise<Response>, path: string, token: string, params?: Record<string, string>) {
  const request = new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } });
  return handler(request, (params ? { params: Promise.resolve(params) } : undefined) as never);
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown> & { error?: string; code?: string; nextCursor?: string | null };
}

// Every listing id the key sees, page by page, so other fixtures in the shared database can't push ours off a page.
async function listingIds(token: string, query = "") {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let pageCount = 0; pageCount < 50; pageCount += 1) {
    const response = await call(getListings, `/api/v1/listings?limit=100${query}${cursor ? `&cursor=${cursor}` : ""}`, token);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { listings: { id: string }[]; nextCursor: string | null };
    ids.push(...body.listings.map((item) => item.id));
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  return ids;
}

function capture() {
  const sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const send: WebhookSender = async (url, headers, body) => {
    sent.push({ url, headers, body: JSON.parse(body) as Record<string, unknown> });
    return { status: 200, detail: "ok" };
  };
  return { sent, send };
}

let world: Awaited<ReturnType<typeof build>>;

async function build() {
  const seller = await person("seller", "INSTITUTIONAL_SELLER");
  const buyer = await person("buyer", "BUYER");
  const invited = await person("invited", "BUYER");
  const other = await person("other", "BUYER");
  await prisma.buyerProfile.create({ data: { userId: buyer.id, status: "APPROVED" } });
  const open = await listing(seller.id, { title: "Open first" });
  const second = await listing(seller.id, { title: "Open second", lien: "SECOND", upb: 50000 });
  const hidden = await listing(seller.id, { title: "Private sale", visibility: "PRIVATE" });
  await prisma.listingInvite.create({ data: { listingId: hidden.id, email: invited.email, userId: invited.id, token: `buyer-api-${tag}`, invitedById: seller.id } });
  await prisma.document.create({ data: { listingId: open.id, type: "BPO", originalName: SECRET.file, storedName: `stored-${tag}`, mime: "application/pdf", size: 10 } });
  const mine = await prisma.inquiry.create({ data: { listingId: open.id, buyerId: buyer.id, type: "OFFER", status: "OPEN", amount: 111000 } });
  const theirs = await prisma.inquiry.create({ data: { listingId: open.id, buyerId: other.id, type: "OFFER", status: "OPEN", amount: 98765 } });
  return { seller, buyer, invited, other, open, second, hidden, mine, theirs };
}

test.before(async () => {
  world = await build();
});

test.after(async () => {
  const ids = made.listings;
  const userIds = made.users;
  const inquiryIds = (await prisma.inquiry.findMany({ where: { listingId: { in: ids } }, select: { id: true } })).map((row) => row.id);
  const endpointIds = (await prisma.webhookEndpoint.findMany({ where: { userId: { in: userIds } }, select: { id: true } })).map((row) => row.id);
  await prisma.webhookDelivery.deleteMany({ where: { endpointId: { in: endpointIds } } });
  await prisma.webhookEndpoint.deleteMany({ where: { id: { in: endpointIds } } });
  await prisma.offerMessage.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await prisma.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await prisma.listingMatch.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.buyBox.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.buyerHolding.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.favorite.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.listingInvite.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.document.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.note.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.listing.deleteMany({ where: { id: { in: ids } } });
  await prisma.apiKey.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.rateWindow.deleteMany({ where: { OR: made.tokens.map((token) => ({ key: { startsWith: `api:${hashKey(token).slice(0, 32)}` } })) } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...ids, ...userIds] } }, { actorId: { in: userIds } }] } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: made.emails } }, { subject: { contains: tag } }] } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

test("a key's scopes: missing means the seller pair, and a buyer key reaches only what it was given", async () => {
  assert.deepEqual(scopesOf({ scopes: null }), ["tapes:write", "offers:read"]);
  assert.deepEqual(scopesOf({ scopes: "listings:read, evil:write,offers:read" }), ["listings:read", "offers:read"]);
  assert.equal(cleanBuyerScopes(["holdings:read", "tapes:write", "listings:read", "listings:read"]), "listings:read,holdings:read");

  const narrow = await key(world.buyer.id, "listings:read");
  assert.equal((await call(getListings, "/api/v1/listings", narrow.token)).status, 200);
  for (const [handler, path] of [[getMatches, "/api/v1/matches"], [getOffers, "/api/v1/offers"], [getHoldings, "/api/v1/holdings"]] as const) {
    const refused = await call(handler, path, narrow.token);
    assert.equal(refused.status, 403, path);
    const body = await json(refused);
    assert.equal(body.code, "scope_missing");
    assert.match(body.error ?? "", /doesn't have the (matches|offers|holdings):read scope/);
  }
  // A buyer key can't push a tape, and a seller's key can't read the book.
  const full = await key(world.buyer.id);
  const tape = await postTape(new Request("http://localhost/api/v1/tapes", { method: "POST", headers: { authorization: `Bearer ${full.token}` }, body: "{}" }));
  assert.equal(tape.status, 403);
  assert.equal((await json(tape)).code, "scope_missing");
  const sellerKey = await key(world.seller.id, null);
  const book = await call(getListings, "/api/v1/listings", sellerKey.token);
  assert.equal(book.status, 403);
  assert.match((await json(book)).error ?? "", /listings:read/);
});

test("a private listing is invisible to an uninvited buyer's key, in the list, the detail and the matches", async () => {
  const outsider = await key(world.buyer.id);
  const guest = await key(world.invited.id);
  const seen = await listingIds(outsider.token);
  assert.ok(seen.includes(world.open.id));
  assert.ok(!seen.includes(world.hidden.id));
  const detail = await call(getListing, `/api/v1/listings/${world.hidden.id}`, outsider.token, { id: world.hidden.id });
  assert.equal(detail.status, 404);
  assert.deepEqual(await json(detail), { error: "Listing not found." });

  // The invited buyer sees it, marked private.
  assert.ok((await listingIds(guest.token)).includes(world.hidden.id));
  const open = await call(getListing, `/api/v1/listings/${world.hidden.id}`, guest.token, { id: world.hidden.id });
  assert.equal(open.status, 200);
  assert.equal((await json(open)).private, true);

  // A match on it, left over from before it went private, doesn't show either.
  const box = await prisma.buyBox.create({ data: { userId: world.buyer.id, name: `Box ${tag}` } });
  await prisma.listingMatch.create({ data: { listingId: world.hidden.id, buyBoxId: box.id, userId: world.buyer.id, score: 90, reasons: "In XQ" } });
  await prisma.listingMatch.create({ data: { listingId: world.open.id, buyBoxId: box.id, userId: world.buyer.id, score: 80, reasons: "In XQ · First lien", indicativePrice: 101000 } });
  await prisma.listingMatch.create({ data: { listingId: world.second.id, buyBoxId: box.id, userId: world.buyer.id, score: 70, reasons: "In XQ" } });
  const first = await json(await call(getMatches, "/api/v1/matches?limit=1", outsider.token));
  const page = first.matches as { listingId: string; reasons: string[]; buyBox: string; indicativePrice: number | null }[];
  assert.equal(page.length, 1);
  assert.ok(first.nextCursor);
  const rest = await json(await call(getMatches, `/api/v1/matches?limit=1&cursor=${first.nextCursor}`, outsider.token));
  const all = [...page, ...(rest.matches as typeof page)];
  assert.equal(rest.nextCursor, null);
  assert.deepEqual(all.map((match) => match.listingId).sort(), [world.open.id, world.second.id].sort());
  const onOpen = all.find((match) => match.listingId === world.open.id);
  assert.deepEqual(onOpen?.reasons, ["In XQ", "First lien"]);
  assert.equal(onOpen?.indicativePrice, 101000);
});

test("the detail carries the tape a buyer reads before the NDA, and no room file, borrower or other bid", async () => {
  const buyerKey = await key(world.buyer.id);
  const before = { release: process.env.UPB_RELEASE, vercel: process.env.VERCEL };
  try {
    process.env.UPB_RELEASE = "1";
    delete process.env.VERCEL;
    const response = await call(getListing, `/api/v1/listings/${world.open.id}`, buyerKey.token, { id: world.open.id });
    assert.equal(response.status, 200);
    const text = await response.clone().text();
    for (const secret of Object.values(SECRET)) assert.ok(!text.includes(secret), `leaked ${secret}`);
    assert.ok(!text.includes("98765") && !text.includes("111000"), "a bid amount leaked");
    const body = await json(response);
    for (const field of ["documents", "inquiries", "reservePrice", "ndas"]) assert.ok(!(field in body), field);
    const [loan] = body.loans as Record<string, unknown>[];
    for (const field of ["streetAddress", "borrowerName", "zip", "memo", "loanNumber", "mersMin", "eNoteId", "litigationNote", "latitude", "verifiedFields"]) {
      assert.ok(!(field in loan), field);
    }
    assert.equal(loan.city, "Quietville");
    assert.equal(loan.upb, 200000);
    assert.equal(loan.lienPosition, "FIRST");
    // A stand-in value estimate is hidden in a release, as on the listing page.
    assert.equal(loan.valueEstimate, null);
    assert.equal(body.saleFormat, "NONE");
    assert.equal(body.bidDeadline, null);
    assert.match(String(body.webUrl), new RegExp(`/marketplace/${world.open.id}$`));
    assert.equal(body.ltv, 76.92);

    process.env.UPB_RELEASE = "";
    const demo = await json(await call(getListing, `/api/v1/listings/${world.open.id}`, buyerKey.token, { id: world.open.id }));
    assert.equal((demo.loans as Record<string, unknown>[])[0].valueEstimate, 255000);
  } finally {
    if (before.release === undefined) delete process.env.UPB_RELEASE;
    else process.env.UPB_RELEASE = before.release;
    if (before.vercel !== undefined) process.env.VERCEL = before.vercel;
  }
});

test("the list filters as the book does, pages by cursor, and reads updated_since", async () => {
  const buyerKey = await key(world.buyer.id);
  const ours = (ids: string[]) => ids.filter((id) => id === world.open.id || id === world.second.id).sort();
  assert.deepEqual(ours(await listingIds(buyerKey.token, "&state=xq")), [world.open.id, world.second.id].sort());
  assert.deepEqual(ours(await listingIds(buyerKey.token, "&state=XQ&lien_position=SECOND")), [world.second.id]);
  assert.deepEqual(ours(await listingIds(buyerKey.token, "&state=XQ&payment_status=NON_PERFORMING")), []);
  // UPB 200,000 over a value of 260,000 is about 77% LTV. The second is 50,000 over 260,000.
  assert.deepEqual(ours(await listingIds(buyerKey.token, "&state=XQ&max_ltv=50")), [world.second.id]);
  assert.deepEqual(ours(await listingIds(buyerKey.token, "&state=XQ&min_upb=100000&max_upb=250000")), [world.open.id]);
  assert.deepEqual(ours(await listingIds(buyerKey.token, `&state=XQ&updated_since=${new Date(Date.now() + HOUR).toISOString()}`)), []);

  const first = await json(await call(getListings, "/api/v1/listings?state=XQ&lien_position=FIRST,SECOND&limit=1", buyerKey.token));
  assert.equal((first.listings as unknown[]).length, 1);
  assert.ok(first.nextCursor);

  for (const query of ["limit=0", "limit=500", "cursor=nonsense", "updated_since=yesterday", "max_ltv=abc", "lien_position=FOURTH", "state=Florida"]) {
    const bad = await call(getListings, `/api/v1/listings?${query}`, buyerKey.token);
    assert.equal(bad.status, 400, query);
    assert.ok((await json(bad)).error, query);
  }
});

test("a revoked key, and a key on a locked or deleted account, is refused", async () => {
  const revoked = await key(world.buyer.id);
  assert.equal((await call(getListings, "/api/v1/listings?limit=1", revoked.token)).status, 200);
  await prisma.apiKey.update({ where: { id: revoked.id }, data: { revokedAt: new Date() } });
  const response = await call(getListings, "/api/v1/listings?limit=1", revoked.token);
  assert.equal(response.status, 401);
  assert.match((await json(response)).error ?? "", /revoked/);
  assert.equal(await userForApiKey(`Bearer ${revoked.token}`), null);

  const locked = await person("locked", "BUYER", { accountStatus: "SUSPENDED" });
  const lockedKey = await key(locked.id);
  assert.equal((await call(getListings, "/api/v1/listings", lockedKey.token)).status, 401);
  const gone = await person("gone", "BUYER", { deletedAt: new Date() });
  const goneKey = await key(gone.id);
  const deleted = await call(getListings, "/api/v1/listings", goneKey.token);
  assert.equal(deleted.status, 401);
  assert.match((await json(deleted)).error ?? "", /suspended or closed/);
});

test("a buyer key works on Pro, a live trial or a desk comp, and stops with a 403 that says why once Pro lapses", async () => {
  const past = new Date(Date.now() - 3 * DAY);
  const trial = await person("trial", "BUYER", { subscriptionTier: "FREE", subscriptionStatus: "INCOMPLETE", trialStartedAt: new Date(Date.now() - 5 * DAY), trialEndsAt: new Date(Date.now() + DAY) });
  const comped = await person("comped", "BUYER", { subscriptionComped: true });
  const ended = await person("ended", "BUYER", { subscriptionTier: "FREE", subscriptionStatus: "INCOMPLETE", trialStartedAt: new Date(Date.now() - 20 * DAY), trialEndsAt: past });
  const canceled = await person("canceled", "BUYER", { subscriptionTier: "FREE", subscriptionStatus: "CANCELED" });
  const pastDue = await person("pastdue", "BUYER", { subscriptionStatus: "PAST_DUE" });
  for (const user of [trial, comped]) assert.equal((await call(getOffers, "/api/v1/offers", (await key(user.id)).token)).status, 200, user.email);
  for (const [user, why] of [[ended, /Pro trial ended on/], [canceled, /Pro was canceled/], [pastDue, /payment is past due/]] as const) {
    const response = await call(getListings, "/api/v1/listings", (await key(user.id)).token);
    assert.equal(response.status, 403, user.email);
    const body = await json(response);
    assert.equal(body.code, "pro_required");
    assert.match(body.error ?? "", why);
    assert.match(body.error ?? "", /\/buyer\/subscription/);
  }
  // Minting needs Pro and an approved buyer file.
  assert.equal(buyerKeyProblem(world.buyer, { status: "APPROVED" }), null);
  assert.match(buyerKeyProblem(world.buyer, { status: "SUBMITTED" }) ?? "", /buyer file the desk approved/);
  assert.match(buyerKeyProblem(ended, { status: "APPROVED" }) ?? "", /trial ended/);
  assert.match(buyerApiProblem(world.seller) ?? "", /approved buyer accounts/);
});

test("a seller key still works on the seller routes, and a buyer key reads only its own inquiries", async () => {
  const sellerKey = await key(world.seller.id, null);
  const offers = await call(getOffers, "/api/v1/offers", sellerKey.token);
  assert.equal(offers.status, 200);
  const list = (await json(offers)).offers as { id: string; amount: number | null; buyer: string }[];
  const theirs = list.find((offer) => offer.id === world.theirs.id);
  assert.equal(theirs?.amount, 98765);
  assert.ok(list.some((offer) => offer.id === world.mine.id));
  const one = await call(getOffer, `/api/v1/offers/${world.mine.id}`, sellerKey.token, { id: world.mine.id });
  assert.equal(one.status, 200);
  assert.equal((await json(one)).amount, 111000);

  const buyerKey = await key(world.buyer.id);
  const own = await call(getOffers, "/api/v1/offers", buyerKey.token);
  assert.equal(own.status, 200);
  const text = await own.clone().text();
  assert.ok(!text.includes("98765"), "another bidder's amount leaked");
  const body = await json(own);
  const mine = body.offers as { id: string; status: string; amount: number; listingId: string }[];
  assert.deepEqual(mine.map((offer) => offer.id), [world.mine.id]);
  assert.equal(mine[0].status, "OPEN");
  assert.equal(mine[0].amount, 111000);
  assert.equal((await call(getOffer, `/api/v1/offers/${world.theirs.id}`, buyerKey.token, { id: world.theirs.id })).status, 404);
  assert.equal((await call(getOffer, `/api/v1/offers/${world.mine.id}`, buyerKey.token, { id: world.mine.id })).status, 200);

  await prisma.buyerHolding.create({ data: { userId: world.buyer.id, title: `Held ${tag}`, costBasis: 40000, upb: 60000, status: "CURRENT" } });
  const holdings = await json(await call(getHoldings, "/api/v1/holdings", buyerKey.token));
  assert.deepEqual((holdings.holdings as { title: string }[]).map((row) => row.title), [`Held ${tag}`]);
});

test("buyer webhooks go only to Pro buyers who asked for them, with ids and public fields", async () => {
  const lapsed = await person("lapsed-hook", "BUYER", { subscriptionTier: "FREE", subscriptionStatus: "CANCELED" });
  const events = cleanEvents(BUYER_WEBHOOK_EVENTS.map((item) => item.event), BUYER_WEBHOOK_EVENTS);
  assert.equal(events, "listing.matched,listing.repriced,listing.deadline,offer.status");
  assert.equal(cleanEvents(["offer.status", "offer.created"], BUYER_WEBHOOK_EVENTS), "offer.status");
  // A captured sender stands in for the receiving server.
  const hook = await prisma.webhookEndpoint.create({ data: { userId: world.buyer.id, url: "https://hooks.example.com/upb", secret: `s-${tag}`, events } });
  await prisma.webhookEndpoint.create({ data: { userId: lapsed.id, url: "https://hooks.example.com/upb", secret: `s-${tag}`, events } });

  const matched = capture();
  assert.equal(await emitBuyerWebhook([world.buyer.id, lapsed.id], "listing.matched", { listingId: world.open.id, score: 80 }, matched.send), 1);
  assert.equal(matched.sent.length, 1);
  assert.equal(matched.sent[0].headers["x-upb-event"], "listing.matched");

  // The seller's offer event reaches the bidder as offer.status, with no amount.
  const status = capture();
  await prisma.inquiry.update({ where: { id: world.mine.id }, data: { status: "DECLINED" } });
  await emitWebhook(world.seller.id, "offer.declined", { inquiryId: world.mine.id, listingId: world.open.id, reason: "another_bid_accepted", amount: 111000 }, status.send);
  const told = status.sent.find((item) => item.body.event === "offer.status");
  assert.ok(told);
  assert.deepEqual({ ...told.body, sentAt: undefined }, { event: "offer.status", sentAt: undefined, inquiryId: world.mine.id, listingId: world.open.id, type: "OFFER", status: "DECLINED", change: "declined", reason: "another_bid_accepted" });
  await prisma.inquiry.update({ where: { id: world.mine.id }, data: { status: "OPEN" } });

  // Picking events narrows them.
  await prisma.webhookEndpoint.update({ where: { id: hook.id }, data: { events: "listing.repriced" } });
  const quiet = capture();
  assert.equal(await emitBuyerWebhook(world.buyer.id, "listing.matched", { listingId: world.open.id }, quiet.send), 0);
  assert.equal(quiet.sent.length, 0);
  await prisma.webhookEndpoint.deleteMany({ where: { userId: { in: [world.buyer.id, lapsed.id] } } });
});

test("watchers on Pro hear a new price and a closing deadline by webhook", async () => {
  // A localhost endpoint is refused before any connection, so the delivery is recorded with its body and nothing is
  // sent anywhere.
  const watcher = await person("watcher", "BUYER", { watchAlerts: false });
  const lapsed = await person("lapsed-watcher", "BUYER", { subscriptionTier: "FREE", subscriptionStatus: "CANCELED" });
  const events = "listing.repriced,listing.deadline";
  const mineHook = await prisma.webhookEndpoint.create({ data: { userId: watcher.id, url: `https://localhost/${tag}`, secret: `s-${tag}`, events } });
  const lapsedHook = await prisma.webhookEndpoint.create({ data: { userId: lapsed.id, url: `https://localhost/${tag}`, secret: `s-${tag}`, events } });
  const deadline = new Date(Date.now() + 12 * HOUR);
  const dated = await listing(world.seller.id, { title: "Dated", bidMode: "SEALED", bidDeadline: deadline });
  for (const user of [watcher, lapsed]) {
    for (const id of [world.open.id, dated.id]) await prisma.favorite.create({ data: { userId: user.id, listingId: id } });
  }
  const before = (await prisma.listing.findUniqueOrThrow({ where: { id: world.open.id } })).updatedAt;
  await watchReprice({ listingId: world.open.id, before: 120000, after: 109500, loans: 1, actorId: world.seller.id });
  // A new price moves the listing's updatedAt, so an updated_since sync picks it up.
  assert.ok((await prisma.listing.findUniqueOrThrow({ where: { id: world.open.id } })).updatedAt > before);
  await remindBidDeadlines(new Date(), { listingIds: [dated.id] });

  const delivered = await prisma.webhookDelivery.findMany({ where: { endpointId: mineHook.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(delivered.map((row) => row.event), ["listing.repriced", "listing.deadline"]);
  const repriced = JSON.parse(delivered[0].payload) as Record<string, unknown>;
  assert.equal(repriced.listingId, world.open.id);
  assert.equal(repriced.ask, 109500);
  assert.equal(repriced.previousAsk, 120000);
  const deadlineBody = JSON.parse(delivered[1].payload) as Record<string, unknown>;
  assert.equal(deadlineBody.listingId, dated.id);
  assert.equal(deadlineBody.bidDeadline, deadline.toISOString());
  assert.equal(deadlineBody.saleFormat, "SEALED");
  for (const row of delivered) for (const secret of Object.values(SECRET)) assert.ok(!row.payload.includes(secret), secret);
  assert.equal(await prisma.webhookDelivery.count({ where: { endpointId: lapsedHook.id } }), 0);
});
