import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import Stripe from "stripe";
import { unset } from "../lib/db-filters";
import { ALIAS_URL_NOTE, aliasUrl, screenParty } from "../lib/ofac";
import { prisma } from "../lib/prisma";
import { openReviewWhere, reviewKey, sameReviewIds, screenAndRecord } from "../lib/screening";
import { cancelBuyerSubscription, cancelSubscription, liveSubscription, subscriptionEnded, type SubscriptionApi } from "../lib/stripe-billing";
import { syncProPrice } from "../lib/stripe-sync";

const tagOf = () => `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;

test("the alias file is found next to SDN.CSV, and any other address is refused", () => {
  assert.equal(
    aliasUrl("https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV"),
    "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ALT.CSV",
  );
  assert.equal(aliasUrl("https://www.treasury.gov/ofac/downloads/sdn.csv"), "https://www.treasury.gov/ofac/downloads/alt.csv");
  assert.equal(aliasUrl("https://lists.example.org/SDN.CSV?key=1"), "https://lists.example.org/ALT.CSV?key=1");
  assert.equal(aliasUrl("https://lists.example.org/sdn_list.csv"), null);
  assert.equal(aliasUrl("https://lists.example.org/SDN.CSV/latest"), null);
  assert.equal(aliasUrl("not a url"), null);
});

test("a list address the alias file can't be found from is never a real screen", async () => {
  const screen = await screenParty("Jane Borrower", { OFAC_SDN_URL: "https://lists.example.org/export?format=csv" });
  assert.equal(screen.unavailable, true);
  assert.equal(screen.provider, "local");
  assert.ok(screen.detail.includes(ALIAS_URL_NOTE));
});

// Letters only, so no made-up name comes near the alias the test screens.
function word(n: number) {
  let out = "";
  for (let i = 0; i < 6; i += 1) {
    out += String.fromCharCode(97 + (n % 26));
    n = Math.floor(n / 26) + i * 7;
  }
  return out;
}

async function listServer(altFails: { value: boolean }) {
  const sdn = Array.from({ length: 1200 }, (_, i) => `${i + 1},"${word(i + 3)} ${word(i + 911)}","individual","SDGT",-0- `).join("\r\n");
  const alt = [
    ...Array.from({ length: 1200 }, (_, i) => `${i + 1},${i + 1},"aka","${word(i + 5003)} ${word(i + 7919)}",-0- `),
    `7,99999,"aka","ZORBLAX QUENTARO",-0- `,
  ].join("\r\n");
  const server: Server = createServer((request, response) => {
    if (request.url?.endsWith("/SDN.CSV")) return response.end(sdn);
    if (request.url?.endsWith("/ALT.CSV") && !altFails.value) return response.end(alt);
    response.statusCode = 503;
    response.end("down");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/SDN.CSV` };
}

test("a failed alias download is a failed refresh: no fresh copy without aliases", async () => {
  const altFails = { value: true };
  const { server, url } = await listServer(altFails);
  const env = { OFAC_SDN_URL: url };
  const state = () => (globalThis as unknown as { upbSanctionList: { at: number; failedAt: number } }).upbSanctionList;
  try {
    // No good copy yet, so the alias failure leaves screening unavailable rather than clear.
    const first = await screenParty("Zorblax Quentaro", env);
    assert.equal(first.unavailable, true);
    assert.equal(first.provider, "local");

    altFails.value = false;
    state().failedAt = 0;
    const fresh = await screenParty("Zorblax Quentaro", env);
    assert.equal(fresh.provider, "treasury");
    assert.equal(fresh.result, "REVIEW");
    assert.equal(fresh.matched, "ZORBLAX QUENTARO");

    // A later alias failure keeps the last good copy, aliases included, and says so.
    altFails.value = true;
    state().at = 0;
    state().failedAt = 0;
    const kept = await screenParty("Zorblax Quentaro", env);
    assert.equal(kept.provider, "treasury");
    assert.equal(kept.result, "REVIEW");
    assert.match(kept.detail, /last refresh failed/);
  } finally {
    server.close();
  }
});

test("screening a party again with a review open adds no row and no second desk email", async () => {
  const tag = tagOf();
  const name = `Blocked Test ${tag}`;
  const party = { context: "Account approval", listingId: `listing-${tag}` };
  const subject = `OFAC review · ${name}`;
  try {
    const first = await screenAndRecord(name, party);
    assert.equal(first.check.status, "OPEN");
    const emails = await prisma.notification.count({ where: { subject } });
    const again = await screenAndRecord(name, { ...party, context: "Listing approval" });
    assert.equal(again.check.id, first.check.id);
    assert.equal(again.blocked, true);
    assert.equal(await prisma.ofacCheck.count({ where: { name } }), 1);
    assert.equal(await prisma.notification.count({ where: { subject } }), emails);
    // A different party with the same name still gets a review of their own.
    const other = await screenAndRecord(name, { context: "Test", listingId: `other-${tag}` });
    assert.notEqual(other.check.id, first.check.id);
    assert.notEqual(reviewKey(other.check), reviewKey(first.check));
  } finally {
    await prisma.notification.deleteMany({ where: { subject } });
    await prisma.ofacCheck.deleteMany({ where: { name } });
  }
});

test("a confirmed match screened again stays blocked and tells the desk", async () => {
  const tag = tagOf();
  const name = `Ofac Sample ${tag}`;
  const party = { context: "Test", listingId: `listing-${tag}` };
  const reviewSubject = `OFAC review · ${name}`;
  const confirmedSubject = `OFAC confirmed match screened again · ${name}`;
  try {
    const first = await screenAndRecord(name, party);
    const desk = await prisma.notification.count({ where: { subject: reviewSubject } });
    await prisma.ofacCheck.update({ where: { id: first.check.id }, data: { status: "CONFIRMED", reviewNote: "Same date of birth" } });
    const again = await screenAndRecord(name, party);
    assert.notEqual(again.check.id, first.check.id);
    assert.equal(again.check.status, "CONFIRMED");
    assert.equal(again.blocked, true);
    assert.equal(await prisma.notification.count({ where: { subject: confirmedSubject } }), desk);
  } finally {
    await prisma.notification.deleteMany({ where: { subject: { in: [reviewSubject, confirmedSubject] } } });
    await prisma.ofacCheck.deleteMany({ where: { name } });
  }
});

test("open reviews are found directly, legacy rows with no status included", async () => {
  const tag = tagOf();
  const name = `Review Query ${tag}`;
  const userId = `user-${tag}`;
  try {
    const legacy = await prisma.ofacCheck.create({ data: { name, result: "REVIEW", matched: "ENTRY", userId } });
    const open = await prisma.ofacCheck.create({ data: { name, result: "REVIEW", matched: "ENTRY", userId, status: "OPEN" } });
    const cleared = await prisma.ofacCheck.create({ data: { name, result: "REVIEW", matched: "ENTRY", userId: `${userId}-b`, status: "CLEARED" } });
    const other = await prisma.ofacCheck.create({ data: { name, result: "REVIEW", matched: "OTHER", userId, status: "OPEN" } });
    await prisma.ofacCheck.create({ data: { name, result: "CLEAR", userId } });
    const found = await prisma.ofacCheck.findMany({ where: { ...openReviewWhere, name } });
    assert.deepEqual(found.map((row) => row.id).sort(), [legacy.id, open.id, other.id].sort());
    assert.ok(!found.some((row) => row.id === cleared.id));
    // A decision or a reopen covers this party's rows of this name and entry, and nothing else.
    assert.deepEqual((await sameReviewIds(open)).sort(), [legacy.id, open.id].sort());
    assert.equal(reviewKey(legacy), reviewKey(open));
    assert.notEqual(reviewKey(open), reviewKey(other));
    const manual = await prisma.ofacCheck.create({ data: { name, result: "REVIEW", matched: "ENTRY", status: "OPEN" } });
    assert.deepEqual(await sameReviewIds(manual), [manual.id]);
  } finally {
    await prisma.ofacCheck.deleteMany({ where: { name } });
  }
});

function fakeStripe(subscriptions: { id: string; status: string }[], fail?: Error & { code?: string }) {
  const canceled: string[] = [];
  const api: SubscriptionApi = {
    subscriptions: {
      async retrieve(id) {
        if (fail) throw fail;
        const found = subscriptions.find((row) => row.id === id);
        if (!found) throw Object.assign(new Error(`No such subscription: '${id}'`), { code: "resource_missing" });
        return found;
      },
      async cancel(id) {
        canceled.push(id);
        return { id, status: "canceled" };
      },
      async list() {
        return { data: subscriptions };
      },
    },
  };
  return { api, canceled };
}

test("the desk's membership change cancels a live Stripe subscription, and only a live one", async () => {
  const live = fakeStripe([{ id: "sub_live", status: "past_due" }]);
  assert.equal((await cancelSubscription(live.api, "sub_live")).mode, "canceled");
  assert.deepEqual(live.canceled, ["sub_live"]);

  const ended = fakeStripe([{ id: "sub_old", status: "canceled" }]);
  assert.equal((await cancelSubscription(ended.api, "sub_old")).mode, "unchanged");
  assert.deepEqual(ended.canceled, []);
  assert.equal((await cancelSubscription(ended.api, "sub_gone")).mode, "unchanged");

  const down = fakeStripe([], Object.assign(new Error("Stripe is down"), { code: "api_error" }));
  const result = await cancelSubscription(down.api, "sub_live");
  assert.equal(result.mode, "error");
  assert.equal(result.detail, "Stripe is down");

  // Without Stripe, or with no subscription on file, the database is the whole record.
  assert.equal((await cancelBuyerSubscription(undefined, "sub_live")).mode, "skipped");
  assert.equal((await cancelBuyerSubscription("sk_test_unused", null)).mode, "skipped");
});

test("checkout sees a subscription that can still bill", async () => {
  assert.equal(subscriptionEnded("canceled"), true);
  assert.equal(subscriptionEnded("incomplete_expired"), true);
  assert.equal(subscriptionEnded("past_due"), false);
  assert.equal(subscriptionEnded("unpaid"), false);
  assert.equal((await liveSubscription(fakeStripe([{ id: "a", status: "canceled" }, { id: "b", status: "past_due" }]).api, "cus_1"))?.id, "b");
  assert.equal(await liveSubscription(fakeStripe([{ id: "a", status: "canceled" }]).api, "cus_1"), null);
});

test("a Pro price under $0.50 is an error the desk sees, never a quiet skip", async () => {
  const low = await syncProPrice({ secretKey: "sk_test_unused", cents: 49, productId: "prod_1", priceId: "price_1" });
  assert.equal(low.mode, "error");
  assert.equal(low.priceId, "price_1");
  assert.equal((await syncProPrice({ secretKey: undefined, cents: 0, productId: "", priceId: "" })).mode, "skipped");
});

async function sendWebhook(event: Record<string, unknown>) {
  const { POST } = await import("../app/api/billing/webhook/route");
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });
  const response = await POST(new Request("http://127.0.0.1/api/billing/webhook", { method: "POST", body: payload, headers: { "stripe-signature": header } }));
  assert.equal(response.status, 200);
}

function invoicePaid(id: string, customer: string, amountPaid: number) {
  return { id: `evt_${id}`, object: "event", type: "invoice.paid", data: { object: { id, object: "invoice", customer, amount_paid: amountPaid, billing_reason: "subscription_create" } } };
}

test("the webhook posts what Stripe collected and leaves a desk comp alone", async () => {
  const tag = tagOf();
  const before = { secret: process.env.STRIPE_WEBHOOK_SECRET, key: process.env.STRIPE_SECRET_KEY };
  process.env.STRIPE_WEBHOOK_SECRET = `whsec_test_${tag}`;
  process.env.STRIPE_SECRET_KEY = `sk_test_${tag}`;
  const paying = await prisma.user.create({
    data: { email: `billing-paying-${tag}@example.org`, name: `Paying ${tag}`, role: "BUYER", accountStatus: "APPROVED", passwordHash: "x", stripeCustomerId: `cus_pay_${tag}` },
  });
  const comped = await prisma.user.create({
    data: {
      email: `billing-comped-${tag}@example.org`,
      name: `Comped ${tag}`,
      role: "BUYER",
      accountStatus: "APPROVED",
      passwordHash: "x",
      stripeCustomerId: `cus_comp_${tag}`,
      stripeSubscriptionId: `sub_comp_${tag}`,
      subscriptionTier: "PRO",
      subscriptionStatus: "ACTIVE",
      subscriptionComped: true,
    },
  });
  const invoices = [`in_free_${tag}`, `in_paid_${tag}`, `in_comp_${tag}`];
  try {
    // A referral coupon made the first invoice $0, so there is nothing to post.
    await sendWebhook(invoicePaid(invoices[0], `cus_pay_${tag}`, 0));
    assert.equal(await prisma.revenueEvent.count({ where: { externalId: invoices[0] } }), 0);
    const upgraded = await prisma.user.findUniqueOrThrow({ where: { id: paying.id } });
    assert.equal(upgraded.subscriptionTier, "PRO");

    await sendWebhook(invoicePaid(invoices[1], `cus_pay_${tag}`, 19900));
    assert.equal((await prisma.revenueEvent.findFirstOrThrow({ where: { externalId: invoices[1] } })).amountCents, 19900);

    await sendWebhook(invoicePaid(invoices[2], `cus_comp_${tag}`, 24900));
    await sendWebhook({
      id: `evt_del_${tag}`,
      object: "event",
      type: "customer.subscription.deleted",
      data: { object: { id: `sub_comp_${tag}`, object: "subscription", status: "canceled" } },
    });
    const still = await prisma.user.findUniqueOrThrow({ where: { id: comped.id } });
    assert.equal(still.subscriptionComped, true);
    assert.equal(still.subscriptionTier, "PRO");
    assert.equal(still.subscriptionStatus, "ACTIVE");
    assert.equal(still.subscriptionCurrentPeriodEnd, null);
  } finally {
    if (before.secret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = before.secret;
    if (before.key === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = before.key;
    await prisma.revenueEvent.deleteMany({ where: { externalId: { in: invoices } } });
    await prisma.user.deleteMany({ where: { id: { in: [paying.id, comped.id] } } });
  }
});

test("clearing a note's estimate leaves it for enrichment to work out again", async () => {
  const tag = tagOf();
  const seller = await prisma.user.create({ data: { email: `billing-seller-${tag}@example.org`, name: `Seller ${tag}`, role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } });
  const listing = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId: seller.id,
      status: "APPROVED",
      title: "Estimate test note",
      summary: "Test",
      notes: {
        create: [{
          streetAddress: "1 Test St",
          city: "Miami",
          state: "FL",
          zip: "33101",
          propertyType: "SFR",
          occupancy: "OWNER_OCCUPIED",
          lienPosition: "FIRST",
          upb: 100000,
          interestRate: 6,
          monthlyPi: 700,
          paymentStatus: "PERFORMING",
          monthsDelinquent: 0,
          askingPrice: 80000,
          estimatedValue: 150000,
          latitude: 25.76,
          longitude: -80.19,
          avmValue: 151000,
          avmProvider: "mock",
          avmAsOf: new Date(),
        }] as never,
      },
    },
    include: { notes: true },
  });
  try {
    const note = listing.notes[0];
    // The same write the desk edit makes when the address or value changes.
    await prisma.note.update({
      where: { id: note.id },
      data: { city: "Tampa", latitude: { unset: true }, longitude: { unset: true }, avmValue: { unset: true }, avmProvider: "", avmAsOf: { unset: true } },
    });
    const stale = await prisma.note.findMany({ where: { listingId: listing.id, ...unset("latitude") } });
    assert.deepEqual(stale.map((row) => row.id), [note.id]);
    assert.equal(stale[0].avmValue, null);
    assert.equal(stale[0].avmAsOf, null);
  } finally {
    await prisma.listing.deleteMany({ where: { id: listing.id } });
    await prisma.user.deleteMany({ where: { id: seller.id } });
  }
});
