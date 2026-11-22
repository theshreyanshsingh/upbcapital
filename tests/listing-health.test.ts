import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ListingHealthPanel } from "../components/listing-health";
import {
  askedTopics,
  countsUntil,
  emptyEvents,
  funnelLine,
  funnelOf,
  listingHealth,
  loadFunnels,
  MAX_STEPS,
  MIN_SIMILAR,
  nextSteps,
  peerWindow,
  QUESTION_TOPICS,
  similarMedians,
  stepLine,
  type Funnel,
  type FunnelStage,
  type HealthFacts,
  type HealthStep,
} from "../lib/listing-health";
import { prisma } from "../lib/prisma";

// The app compiles JSX with Next. Under tsx a component's JSX reads React from the global scope.
(globalThis as { React?: typeof React }).React = React;
// Mail stays in the log, whatever keys the local .env carries.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL", "EMAIL_FROM"]) process.env[key] = "";

test.after(async () => {
  await prisma.$disconnect();
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-22T12:00:00Z");
const ago = (days: number, from = NOW) => new Date(from.getTime() - days * DAY);

function funnel(totals: Partial<Record<FunnelStage, number>>): Funnel {
  const stage = (key: FunnelStage) => ({ total: totals[key] ?? 0, week: 0 });
  return { views: stage("views"), ndas: stage("ndas"), room: stage("room"), questions: stage("questions"), watchers: stage("watchers"), bids: stage("bids") };
}

// A live listing on which no rule fires: confirmed recently, priced inside the comps, a few boxes fit and most opened it.
function facts(over: Partial<HealthFacts> = {}): HealthFacts {
  return {
    now: NOW,
    kind: "SINGLE",
    liveSince: ago(20),
    hold: false,
    pausedAt: null,
    confirmedAt: ago(5),
    remindedAt: null,
    roundOpen: false,
    private: false,
    regulatedOnly: false,
    showBidderCount: false,
    bidderCountLocked: false,
    askOfUpb: 70,
    comps: { median: 72, low: 65, high: 80, count: 6 },
    indicative: { low: 66, high: 78 },
    funnel: funnel({ views: 12, ndas: 3 }),
    similar: null,
    fits: 3,
    fitsOpened: 2,
    diligenceMissing: [],
    topics: [],
    ...over,
  };
}

const keys = (steps: HealthStep[]) => steps.map((step) => step.key);
const similar = (views: number) => ({ count: 6, days: 20, median: { views, ndas: 1, room: 1, questions: 0, watchers: 1, bids: 0 } });
// A figure the seller could take as a price to set: a dollar amount or a percent.
const PRICE_WORDS = /\$|\d+(\.\d+)?\s*%|percent/i;

// ---------------------------------------------------------------------------------------------------------------
// The funnel

test("the funnel counts each buyer once per stage, every question, and the last 7 days apart", () => {
  const events = emptyEvents();
  events.views.push({ userId: "a", at: ago(1) }, { userId: "a", at: ago(2) }, { userId: "a", at: ago(30) }, { userId: "b", at: ago(10) }, { userId: "c", at: ago(6.9) });
  events.ndas.push({ userId: "a", at: ago(3) }, { userId: "b", at: ago(9) });
  events.room.push({ userId: "a", at: ago(3) }, { userId: "a", at: ago(2) });
  events.questions.push({ userId: "a", at: ago(3) }, { userId: "a", at: ago(2) }, { userId: "b", at: ago(12) });
  events.watchers.push({ userId: "b", at: ago(8) });
  events.bids.push({ userId: "a", at: ago(1) }, { userId: "a", at: ago(0.5) });
  // Not yet happened at NOW, so not counted.
  events.views.push({ userId: "d", at: new Date(NOW.getTime() + DAY) });
  const counted = funnelOf(events, NOW);
  assert.deepEqual(counted.views, { total: 3, week: 2 });
  assert.deepEqual(counted.ndas, { total: 2, week: 1 });
  assert.deepEqual(counted.room, { total: 1, week: 1 });
  assert.deepEqual(counted.questions, { total: 3, week: 2 });
  assert.deepEqual(counted.watchers, { total: 1, week: 0 });
  assert.deepEqual(counted.bids, { total: 1, week: 1 });
  // A similar listing is read up to a day.
  assert.deepEqual(countsUntil(events, ago(9)), { views: 2, ndas: 1, room: 0, questions: 1, watchers: 0, bids: 0 });
  assert.equal(funnelLine(counted), "Seen by 3 · 2 NDAs · 1 bidder");
  assert.equal(funnelLine(funnel({ views: 12, ndas: 1 })), "Seen by 12 · 1 NDA · no bids yet");
  assert.equal(funnelLine(funnel({})), "Not opened yet · 0 NDAs · no bids yet");
});

test("similar listings show medians only with five or more, and are read over the subject's days live", () => {
  const sample = (views: number) => ({ views, ndas: views > 2 ? 1 : 0, room: 0, questions: 0, watchers: 0, bids: 0 });
  assert.equal(MIN_SIMILAR, 5);
  assert.equal(similarMedians([1, 2, 3, 4].map(sample), 20), null);
  const five = similarMedians([1, 2, 3, 4, 10].map(sample), 20);
  assert.equal(five?.count, 5);
  assert.equal(five?.median.views, 3);
  assert.equal(five?.median.ndas, 1);
  assert.equal(similarMedians([1, 2, 3, 4, 10, 12].map(sample), 20)?.median.views, 3.5);

  // A live listing younger than the subject would read short, so it is left out; an older one is cut at the same age.
  const live = { status: "APPROVED", approvedAt: ago(30), updatedAt: ago(1) };
  assert.equal(peerWindow(live, 20, NOW)?.getTime(), ago(10).getTime());
  assert.equal(peerWindow({ ...live, approvedAt: ago(10) }, 20, NOW), null);
  // One that came soon first counts from its launch.
  assert.equal(peerWindow({ ...live, approvedAt: ago(40), launchAt: ago(30) }, 20, NOW)?.getTime(), ago(10).getTime());
  // One that sold sooner is read over its whole run, if it was live in the last 180 days.
  assert.equal(peerWindow({ status: "SOLD", approvedAt: ago(100), soldAt: ago(90), updatedAt: ago(90) }, 20, NOW)?.getTime(), ago(80).getTime());
  assert.equal(peerWindow({ status: "SOLD", approvedAt: ago(300), soldAt: ago(200), updatedAt: ago(200) }, 20, NOW), null);
  assert.equal(peerWindow({ status: "APPROVED", approvedAt: null, updatedAt: ago(1) }, 20, NOW), null);
});

// ---------------------------------------------------------------------------------------------------------------
// Next steps, one rule at a time

test("a quiet listing has no next steps, and a sanctions review suggests nothing whatever else is true", () => {
  assert.deepEqual(nextSteps(facts()), []);
  const busy = facts({ diligenceMissing: [{ key: "TITLE", text: "Title policy or O&E report" }], fits: 0, funnel: funnel({ views: 12, bids: 3 }) });
  assert.ok(nextSteps(busy).length > 0);
  assert.deepEqual(nextSteps({ ...busy, hold: true }), []);
});

test("a pause shows only the confirmation, a reminder shows the pause date, and a stale date shows before the reminder", () => {
  const paused = nextSteps(facts({ pausedAt: ago(2), fits: 0, diligenceMissing: [{ key: "TITLE", text: "Title policy or O&E report" }] }));
  assert.deepEqual(keys(paused), ["PAUSED"]);
  assert.equal(paused[0].target, "availability");
  assert.match(paused[0].fact, /^Paused Nov 20, 2026\./);

  const reminded = nextSteps(facts({ confirmedAt: ago(33), remindedAt: ago(3) }));
  assert.deepEqual(keys(reminded), ["RECONFIRM"]);
  assert.match(reminded[0].fact, /pauses on Nov 26, 2026/);

  // 24 days since the last confirmation: the reminder is 6 days off.
  const soon = nextSteps(facts({ confirmedAt: ago(24) }));
  assert.deepEqual(keys(soon), ["RECONFIRM"]);
  assert.match(soon[0].fact, /Last confirmed available Oct 29, 2026\. The desk asks again on Nov 28, 2026\./);
  assert.deepEqual(nextSteps(facts({ confirmedAt: ago(22) })), []);
});

test("missing diligence items are listed in the checklist's words and point at it", () => {
  const steps = nextSteps(facts({ diligenceMissing: [{ key: "PAY_HISTORY", text: "Pay history on 2 loans" }, { key: "TITLE", text: "Title policy or O&E report" }] }));
  assert.deepEqual(keys(steps), ["DILIGENCE"]);
  assert.equal(steps[0].fact, "The diligence set is missing: Pay history on 2 loans; Title policy or O&E report.");
  assert.equal(steps[0].target, "diligence");
  assert.deepEqual(nextSteps(facts({ diligenceMissing: [] })), []);
});

test("two questions about the same file that isn't in the room ask for it, once", () => {
  const questions = [
    { question: "Can you share the pay history for the last 24 months?", status: "OPEN" },
    { question: "Is there a payment history from the servicer?", status: "ANSWERED" },
    { question: "Any pay history?", status: "DECLINED" },
    { question: "Is there a recent BPO?", status: "OPEN" },
  ];
  const topics = askedTopics(questions, () => false);
  assert.deepEqual(topics.map((row) => [row.key, row.count]), [["PAY_HISTORY", 2], ["VALUE", 1]]);
  const steps = nextSteps(facts({ topics }));
  assert.deepEqual(keys(steps), ["ASKING"]);
  assert.equal(steps[0].suggestion, "Add the pay history to the data room.");
  assert.equal(steps[0].fact, "2 buyer questions ask about the pay history, and nothing in the data room answers them.");
  assert.equal(steps[0].target, "files");

  // One question isn't a pattern; a file on file answers it; and a missing diligence item already names it.
  assert.deepEqual(nextSteps(facts({ topics: askedTopics(questions.slice(0, 1), () => false) })), []);
  assert.deepEqual(nextSteps(facts({ topics: askedTopics(questions, (topic) => topic.key === "PAY_HISTORY") })), []);
  assert.deepEqual(keys(nextSteps(facts({ topics, diligenceMissing: [{ key: "PAY_HISTORY", text: "Pay history" }] }))), ["DILIGENCE"]);

  // Photos go on the listing, not into the room.
  const photos = nextSteps(facts({ topics: askedTopics([{ question: "Any interior photos?", status: "OPEN" }, { question: "Pictures of the roof please", status: "OPEN" }], () => false) }));
  assert.equal(photos[0].suggestion, "Add property photos to the listing.");
  assert.equal(photos[0].target, "photos");
  assert.ok(QUESTION_TOPICS.every((topic) => topic.docTypes.length > 0));
});

test("an ask above the comps shows the comparison when buyers look and nobody bids for 14 days, and names no price", () => {
  const above = facts({ askOfUpb: 90, similar: similar(10), funnel: funnel({ views: 12 }) });
  const steps = nextSteps(above);
  assert.deepEqual(keys(steps), ["PRICE"]);
  assert.equal(steps[0].fact, "Comparable closed trades cleared at about 72% of UPB, between 65% and 80%; your ask is 90%.");
  assert.equal(steps[0].target, "price");
  assert.doesNotMatch(steps[0].suggestion, PRICE_WORDS);

  // Each condition on its own keeps it off.
  assert.deepEqual(nextSteps({ ...above, liveSince: ago(13) }), []);
  assert.deepEqual(nextSteps({ ...above, funnel: funnel({ views: 12, bids: 1 }) }), []);
  assert.deepEqual(nextSteps({ ...above, funnel: funnel({ views: 9 }) }), []);
  // Inside the comps' range and the indicative range.
  assert.deepEqual(nextSteps({ ...above, askOfUpb: 78 }), []);
  // Inside the comps' range but above the indicative: the indicative speaks.
  assert.match(nextSteps({ ...above, askOfUpb: 80 })[0].fact, /^UPB's indicative range for it is 66–78% of UPB; your ask is 80%\.$/);
  // A running bid round keeps the ask where bidders saw it.
  assert.deepEqual(nextSteps({ ...above, roundOpen: true }), []);
  // Without enough similar listings, ten buyers stand in for the median.
  assert.deepEqual(keys(nextSteps({ ...above, similar: null, funnel: funnel({ views: 10 }) })), ["PRICE"]);
  assert.deepEqual(nextSteps({ ...above, similar: null, funnel: funnel({ views: 9 }) }), []);

  // With no comps cell, the indicative range stands in.
  const indicative = nextSteps({ ...above, comps: null, indicative: { low: 74, high: 82 }, askOfUpb: 86.5 });
  assert.equal(indicative[0].fact, "UPB's indicative range for it is 74–82% of UPB; your ask is 86.5%.");
  assert.match(indicative[0].reason, /Not an appraisal or advice\./);
  assert.deepEqual(nextSteps({ ...above, comps: null, indicative: null }), []);
});

test("visibility: no fitting box asks to widen or announce, and many fitting boxes with few opens asks to announce", () => {
  const none = nextSteps(facts({ fits: 0, fitsOpened: 0 }));
  assert.deepEqual(keys(none), ["NO_FIT"]);
  assert.equal(none[0].suggestion, "Ask the desk to announce it to the deal list.");
  assert.equal(none[0].target, "announce");
  assert.equal(nextSteps(facts({ fits: 0, desk: true }))[0].suggestion, "Announce it to the deal list.");
  assert.equal(nextSteps(facts({ fits: 0, private: true }))[0].target, "audience");
  assert.equal(nextSteps(facts({ fits: 0, regulatedOnly: true }))[0].target, "limits");

  const few = nextSteps(facts({ fits: 8, fitsOpened: 3 }));
  assert.deepEqual(keys(few), ["FEW_OPENED"]);
  assert.equal(few[0].fact, "8 buyers have a buy box that fits it, and 3 of them opened it.");
  assert.deepEqual(nextSteps(facts({ fits: 8, fitsOpened: 4 })), []);
  assert.deepEqual(nextSteps(facts({ fits: 4, fitsOpened: 0 })), []);
  // A private listing is never put to the whole list.
  assert.deepEqual(nextSteps(facts({ fits: 8, fitsOpened: 1, private: true })), []);
});

test("two or more bidders with the count off point at the switch, unless it is on or locked", () => {
  const steps = nextSteps(facts({ funnel: funnel({ views: 12, bids: 2 }) }));
  assert.deepEqual(keys(steps), ["BIDDER_COUNT"]);
  assert.equal(steps[0].target, "bidderCount");
  assert.match(steps[0].suggestion, /never the amounts/);
  assert.deepEqual(nextSteps(facts({ funnel: funnel({ views: 12, bids: 1 }) })), []);
  assert.deepEqual(nextSteps(facts({ funnel: funnel({ views: 12, bids: 3 }), showBidderCount: true })), []);
  assert.deepEqual(nextSteps(facts({ funnel: funnel({ views: 12, bids: 3 }), bidderCountLocked: true })), []);
});

test("at most four next steps, first rule first, and no suggestion names a price to set", () => {
  const topics = askedTopics(
    [
      { question: "Pay history please", status: "OPEN" },
      { question: "Payment history?", status: "OPEN" },
      { question: "Title report?", status: "OPEN" },
      { question: "Any O&E on this?", status: "ANSWERED" },
    ],
    () => false,
  );
  const crowded = facts({
    confirmedAt: ago(25),
    diligenceMissing: [{ key: "VALUE", text: "Dated value" }],
    topics,
    askOfUpb: 95,
    similar: similar(4),
    funnel: funnel({ views: 12 }),
    fits: 0,
  });
  const steps = nextSteps(crowded);
  assert.equal(MAX_STEPS, 4);
  assert.equal(steps.length, 4);
  assert.deepEqual(keys(steps), ["RECONFIRM", "DILIGENCE", "ASKING", "ASKING"]);
  // Every rule that can fire, run apart, names no figure to set as the price.
  const each = [
    ...steps,
    ...nextSteps({ ...crowded, confirmedAt: ago(5), diligenceMissing: [], topics: [] }),
    ...nextSteps(facts({ funnel: funnel({ views: 12, bids: 2 }) })),
    ...nextSteps(facts({ fits: 9, fitsOpened: 1 })),
    ...nextSteps(facts({ pausedAt: ago(1) })),
  ];
  assert.deepEqual([...new Set(keys(each))].sort(), ["ASKING", "BIDDER_COUNT", "DILIGENCE", "FEW_OPENED", "NO_FIT", "PAUSED", "PRICE", "RECONFIRM"]);
  for (const step of each) {
    assert.doesNotMatch(step.suggestion, PRICE_WORDS, step.suggestion);
    assert.ok(step.reason.length > 0 && !step.reason.includes("\n"));
  }
  assert.equal(stepLine(steps[0]), `${steps[0].fact} ${steps[0].suggestion}`);
  assert.equal(stepLine(undefined), null);
});

// ---------------------------------------------------------------------------------------------------------------
// From the database: the funnel, the similar listings, and nothing of theirs in the output

test("a live listing's health reads its own events, compares with five other sellers' listings, and names none of them", async () => {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const now = new Date();
  const back = (days: number) => ago(days, now);
  const users: { id: string; name: string; email: string }[] = [];
  const listingIds: string[] = [];
  const person = async (who: string, role: string) => {
    const user = await prisma.user.create({ data: { email: `health-${who}-${tag}@example.org`, name: `${who} ${tag}`, role: role as never, accountStatus: "APPROVED", passwordHash: "x" } });
    users.push(user);
    return user;
  };
  // An unusual profile, so other fixtures in the shared database don't join the comparison.
  const listing = async (sellerId: string, data: Record<string, unknown>) => {
    const made = await prisma.listing.create({
      data: {
        kind: "SINGLE",
        sellerId,
        status: "APPROVED",
        title: `Health note ${listingIds.length} ${tag}`,
        notes: {
          create: [{
            streetAddress: "1 Health St", city: `Healthville${tag}`, state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
            lienPosition: "THIRD", upb: 50000, interestRate: 9, monthlyPi: 450, paymentStatus: "SUB_PERFORMING", monthsDelinquent: 2,
            askingPrice: 30000, estimatedValue: 250000,
          }] as never,
        },
        ...data,
      } as never,
    });
    listingIds.push(made.id);
    return made;
  };
  try {
    const seller = await person("seller", "INDIVIDUAL_SELLER");
    const desk = await person("desk", "ADMIN");
    const buyers = await Promise.all([0, 1, 2, 3, 4, 5].map((index) => person(`buyer${index}`, "BUYER")));
    const subject = await listing(seller.id, { approvedAt: back(20) });

    // On the subject: buyer 0 opens it three times, twice this week; buyer 1 once, ten days ago. The seller's and the
    // desk's own opens don't count.
    for (const at of [back(1), back(2), back(15)]) await prisma.listingView.create({ data: { listingId: subject.id, userId: buyers[0].id, createdAt: at } });
    await prisma.listingView.create({ data: { listingId: subject.id, userId: buyers[1].id, createdAt: back(10) } });
    await prisma.listingView.create({ data: { listingId: subject.id, userId: seller.id, createdAt: back(1) } });
    await prisma.listingView.create({ data: { listingId: subject.id, userId: desk.id, createdAt: back(1) } });
    await prisma.ndaAcknowledgment.create({ data: { userId: buyers[0].id, listingId: subject.id, acknowledgedAt: back(3), signerName: buyers[0].name } });
    await prisma.favorite.create({ data: { userId: buyers[1].id, listingId: subject.id, createdAt: back(9) } });
    await prisma.auditEvent.create({ data: { actorId: buyers[0].id, action: "DOCUMENT_DOWNLOAD", entityType: "listing", entityId: subject.id, detail: "file", createdAt: back(2) } });
    await prisma.listingQuestion.create({ data: { listingId: subject.id, askerId: buyers[0].id, question: "Can you share the pay history?", createdAt: back(2) } });
    await prisma.listingQuestion.create({ data: { listingId: subject.id, askerId: buyers[1].id, question: "Is the payment history on file?", status: "ANSWERED", answer: "Soon.", createdAt: back(8) } });

    // Five other sellers' listings like it, live at least 20 days. Peer i has i + 1 buyers open it in its first 20 days
    // and one more after, which must not count. Even peers have an NDA in that window.
    const peers = [];
    for (let index = 0; index < 5; index += 1) {
      const owner = await person(`peerseller${index}`, "INDIVIDUAL_SELLER");
      const sold = index >= 3;
      const peer = await listing(owner.id, sold ? { status: "SOLD", approvedAt: back(90), soldAt: back(40) } : { approvedAt: back(60) });
      peers.push({ peer, owner });
      const approved = (sold ? back(90) : back(60)).getTime();
      for (let viewer = 0; viewer <= index; viewer += 1) {
        await prisma.listingView.create({ data: { listingId: peer.id, userId: buyers[viewer].id, createdAt: new Date(approved + 2 * DAY) } });
      }
      await prisma.listingView.create({ data: { listingId: peer.id, userId: buyers[5].id, createdAt: new Date(approved + 25 * DAY) } });
      if (index % 2 === 0) await prisma.ndaAcknowledgment.create({ data: { userId: buyers[0].id, listingId: peer.id, acknowledgedAt: new Date(approved + 3 * DAY), signerName: "x" } });
    }
    // The seller's own other listing is never in the comparison, however busy.
    const own = await listing(seller.id, { approvedAt: back(60) });
    for (const buyer of buyers) await prisma.listingView.create({ data: { listingId: own.id, userId: buyer.id, createdAt: back(55) } });

    const health = (await listingHealth([subject.id], now)).get(subject.id);
    assert.ok(health);
    assert.equal(health.daysLive, 20);
    assert.deepEqual(health.funnel, {
      views: { total: 2, week: 1 },
      ndas: { total: 1, week: 1 },
      room: { total: 1, week: 1 },
      questions: { total: 2, week: 1 },
      watchers: { total: 1, week: 0 },
      bids: { total: 0, week: 0 },
    });
    assert.ok(health.similar, "five similar listings compare");
    assert.equal(health.similar.count, 5);
    assert.equal(health.similar.days, 20);
    assert.equal(health.similar.median.views, 3);
    assert.equal(health.similar.median.ndas, 1);
    assert.equal(health.profile.label, "Single notes, third lien, sub-performing");
    // No file is on the listing, so the checklist names the pay history and the questions don't ask twice. No box fits.
    assert.deepEqual(health.steps.map((step) => step.key), ["DILIGENCE", "NO_FIT"]);
    assert.match(health.steps[0].fact, /Pay history/);

    // Nothing of another listing or seller is in what the page or the report reads.
    const out = JSON.stringify([...(await listingHealth([subject.id], now)).values()]);
    for (const { peer, owner } of peers) {
      for (const secret of [peer.id, peer.title, owner.id, owner.name, owner.email]) assert.ok(!out.includes(secret), secret);
    }
    for (const secret of [own.id, own.title, ...buyers.flatMap((buyer) => [buyer.id, buyer.name, buyer.email])]) assert.ok(!out.includes(secret), secret);

    // The seller desk's one line.
    assert.equal(funnelLine((await loadFunnels([subject])).get(subject.id)!), "Seen by 2 · 1 NDA · no bids yet");

    // A private listing is no comp, which leaves four: not enough to compare.
    await prisma.listing.update({ where: { id: peers[0].peer.id }, data: { visibility: "PRIVATE" } });
    const fewer = (await listingHealth([subject.id], now)).get(subject.id);
    assert.equal(fewer?.similar, null);

    // The section: a stacked list on phones, a table from md up, each step with its link. Nobody else's page shows it.
    const panel = await ListingHealthPanel({ listingId: subject.id, viewer: seller, from: "seller" });
    assert.ok(panel);
    const html = renderToStaticMarkup(panel);
    assert.match(html, /Listing health/);
    assert.match(html, /<ul class="[^"]*md:hidden/);
    assert.match(html, /<table class="[^"]*hidden[^"]*md:table/);
    assert.match(html, /Not enough similar listings to compare\./);
    assert.match(html, /href="#diligence"/);
    for (const { peer, owner } of peers) for (const secret of [peer.title, owner.name]) assert.ok(!html.includes(secret), secret);
    assert.equal(await ListingHealthPanel({ listingId: subject.id, viewer: buyers[0], from: "seller" }), null);

    // A sanctions review on the listing leaves no next steps, and says nothing of why.
    await prisma.ofacCheck.create({ data: { name: `Health hold ${tag}`, result: "REVIEW", listingId: subject.id } });
    const held = (await listingHealth([subject.id], now)).get(subject.id);
    assert.deepEqual(held?.steps, []);

    // A listing that isn't live has no health.
    await prisma.listing.update({ where: { id: subject.id }, data: { status: "PENDING" } });
    assert.equal((await listingHealth([subject.id], now)).size, 0);
  } finally {
    const userIds = users.map((user) => user.id);
    await prisma.ofacCheck.deleteMany({ where: { listingId: { in: listingIds } } });
    await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: listingIds } }, { actorId: { in: userIds } }] } });
    await prisma.listingQuestion.deleteMany({ where: { listingId: { in: listingIds } } });
    await prisma.favorite.deleteMany({ where: { listingId: { in: listingIds } } });
    await prisma.listingView.deleteMany({ where: { listingId: { in: listingIds } } });
    await prisma.ndaAcknowledgment.deleteMany({ where: { listingId: { in: listingIds } } });
    await prisma.note.deleteMany({ where: { listingId: { in: listingIds } } });
    await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
});
