import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import OpenGraphImage, { alt, size } from "../app/open/[id]/opengraph-image";
import { generateMetadata } from "../app/open/[id]/page";
import { ShareListing } from "../components/share-listing";
import { prisma } from "../lib/prisma";
import {
  cardFacts,
  cardFactsOf,
  countsAsSharedVisit,
  glyphs,
  recordSharedVisit,
  sharedVisitPath,
  sharedVisits,
  shareLinks,
  sharePanel,
  shareSentence,
  shareUrl,
} from "../lib/share-cards";

// The app compiles JSX with Next. Under tsx a component's JSX reads React from the global scope.
(globalThis as { React?: typeof React }).React = React;

const DAY = 24 * 60 * 60 * 1000;
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
const made = { users: [] as string[], listings: [] as string[] };
const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

async function person(who: string, role: "BUYER" | "INSTITUTIONAL_SELLER" | "BROKER" | "ADMIN") {
  const user = await prisma.user.create({
    data: { email: `a-share-${who}-${tag}@example.org`, name: `Share ${who} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x" },
  });
  made.users.push(user.id);
  return user;
}

type Loan = { city: string; state?: string; upb?: number; lienPosition?: "FIRST" | "SECOND"; paymentStatus?: "PERFORMING" | "NON_PERFORMING" };

async function listing(
  sellerId: string,
  input: { city?: string; loans?: Loan[]; kind?: "SINGLE" | "POOL"; status?: "APPROVED" | "PENDING" | "SUBMITTED" | "SOLD"; visibility?: string; launchAt?: Date; stalePausedAt?: Date; brokerId?: string },
) {
  const loans = input.loans ?? [{ city: input.city ?? `Sharetown ${tag}` }];
  const row = await prisma.listing.create({
    data: {
      kind: input.kind ?? "SINGLE",
      sellerId,
      brokerId: input.brokerId ?? null,
      status: input.status ?? "APPROVED",
      approvedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      // Already claimed, so scoring this fixture never sends the desk a standing-bid notice.
      standingBidsNotifiedAt: new Date(),
      title: `Share card ${tag}`,
      ...(input.visibility ? { visibility: input.visibility } : {}),
      ...(input.launchAt ? { launchAt: input.launchAt } : {}),
      ...(input.stalePausedAt ? { stalePausedAt: input.stalePausedAt } : {}),
      notes: {
        create: loans.map((loan) => ({
          streetAddress: `9 Secret St ${tag}`, city: loan.city, state: loan.state ?? "TX", zip: "73301", propertyType: "SFR", occupancy: "VACANT",
          lienPosition: loan.lienPosition ?? "FIRST", upb: loan.upb ?? 180000, interestRate: 7, monthlyPi: 1400, paymentStatus: loan.paymentStatus ?? "PERFORMING",
          monthsDelinquent: 0, askingPrice: 123456, estimatedValue: 260000,
        })) as never,
      },
    },
    include: { notes: true },
  });
  made.listings.push(row.id);
  return row;
}

let world: Awaited<ReturnType<typeof build>>;

async function build() {
  const seller = await person("seller", "INSTITUTIONAL_SELLER");
  const broker = await person("broker", "BROKER");
  const buyer = await person("buyer", "BUYER");
  const excludedBuyer = await person("excluded", "BUYER");
  const desk = await person("desk", "ADMIN");
  const live = await listing(seller.id, { city: `Sharetown ${tag}`, brokerId: broker.id });
  const hidden = await listing(seller.id, { city: `Hushville ${tag}`, visibility: "PRIVATE" });
  const filed = await listing(seller.id, { city: `Draftburg ${tag}`, status: "SUBMITTED" });
  const sold = await listing(seller.id, { city: `Goneville ${tag}`, status: "SOLD" });
  const soon = await listing(seller.id, { city: `Soonton ${tag}`, launchAt: new Date(Date.now() + 3 * DAY) });
  const paused = await listing(seller.id, { city: `Pauseton ${tag}`, stalePausedAt: new Date(Date.now() - DAY) });
  const contract = await listing(seller.id, { city: `Dealton ${tag}`, status: "PENDING" });
  const pool = await listing(seller.id, {
    kind: "POOL",
    loans: [
      { city: `Smallville ${tag}`, state: "OK", upb: 90000, lienPosition: "SECOND", paymentStatus: "NON_PERFORMING" },
      { city: `Bigtown ${tag}`, state: "FL", upb: 400000 },
      { city: `Midtown ${tag}`, state: "GA", upb: 150000 },
    ],
  });
  // A second seller who excludes one buyer from every listing of theirs.
  const choosy = await person("choosy", "INSTITUTIONAL_SELLER");
  const fenced = await listing(choosy.id, { city: `Fenceton ${tag}` });
  await prisma.sellerExclusion.create({ data: { sellerId: choosy.id, buyerId: excludedBuyer.id, createdById: choosy.id } });
  return { seller, broker, buyer, excludedBuyer, desk, live, hidden, filed, sold, soon, paused, contract, pool, choosy, fenced };
}

test.before(async () => {
  world = await build();
});

test.after(async () => {
  const listingIds = made.listings;
  await prisma.pageHit.deleteMany({ where: { path: { in: listingIds.map((id) => sharedVisitPath(id)) } } });
  await prisma.sellerExclusion.deleteMany({ where: { sellerId: { in: made.users } } });
  await prisma.note.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

test("a public live listing's card shows the public page's facts and none of the file's", async () => {
  const facts = await cardFacts(world.live.id);
  assert.ok(facts);
  assert.equal(facts.place, `Sharetown ${tag}, TX`);
  assert.equal(facts.pool, false);
  assert.equal(facts.loans, 1);
  assert.equal(facts.lien, "First");
  assert.equal(facts.payment, "Performing");
  assert.equal(facts.band, "$100–250k");
  assert.equal(facts.status, "Live on the desk");
  const text = JSON.stringify(facts);
  for (const secret of ["Secret St", "123456", "73301", world.seller.name, world.seller.email]) assert.equal(text.includes(secret), false, secret);
  assert.equal((await cardFacts(world.contract.id))?.status, "In contract");
});

test("a pool's card names its largest loan's city, its loan count and states, and the total band", async () => {
  const facts = await cardFacts(world.pool.id);
  assert.ok(facts);
  assert.equal(facts.pool, true);
  assert.equal(facts.place, `Bigtown ${tag}, FL`);
  assert.equal(facts.loans, 3);
  assert.deepEqual([...facts.states].sort(), ["FL", "GA", "OK"]);
  assert.equal(facts.band, "$500k and up");
  assert.match(shareSentence(facts), /^A pool of 3 loans across /);
});

test("private, excluded, missing and not-live listings get the generic card", async () => {
  assert.equal(await cardFacts(world.hidden.id), null);
  // The seller and the desk see their private listing on the page, but its card stays generic for everyone.
  assert.equal(await cardFacts(world.hidden.id, world.seller), null);
  assert.equal(await cardFacts(world.hidden.id, world.desk), null);
  assert.equal(await cardFacts(`missing-${tag}`), null);
  for (const row of [world.filed, world.sold, world.soon, world.paused]) assert.equal(await cardFacts(row.id), null, row.notes[0].city);
  // The seller's excluded buyer gets the generic card; anyone else, signed in or not, gets the listing's.
  assert.equal(await cardFacts(world.fenced.id, world.excludedBuyer), null);
  assert.ok(await cardFacts(world.fenced.id, world.buyer));
  assert.ok(await cardFacts(world.fenced.id));
  // The pure rule agrees on the private listing whatever is passed.
  assert.equal(cardFactsOf({ ...world.hidden, notes: world.hidden.notes }), null);
  assert.equal(cardFactsOf(null), null);
});

test("the image module returns a 1200 by 630 PNG for a listing and for the generic card", async () => {
  assert.deepEqual(size, { width: 1200, height: 630 });
  assert.ok(alt.length > 20);
  for (const id of [world.live.id, world.pool.id, world.hidden.id, `missing-${tag}`]) {
    const response = await OpenGraphImage({ params: Promise.resolve({ id }) });
    assert.ok(response instanceof Response);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.match(response.headers.get("cache-control") ?? "", /private/);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], id);
  }
});

test("the page's metadata names the preview card for a public listing and nothing for a private one", async () => {
  const open = await generateMetadata({ params: Promise.resolve({ id: world.live.id }) });
  assert.equal(open.twitter && "card" in open.twitter ? open.twitter.card : null, "summary_large_image");
  assert.match(String(open.openGraph?.title), new RegExp(`Sharetown ${tag}, TX`));
  assert.ok(open.openGraph?.description);
  assert.ok(open.metadataBase instanceof URL);
  const closed = await generateMetadata({ params: Promise.resolve({ id: world.hidden.id }) });
  assert.equal(closed.title, "Listing");
  assert.equal(JSON.stringify(closed).includes("Hushville"), false);
  assert.equal(closed.openGraph, undefined);
  // A forward-flow tranche in its first look is hidden from anonymous visitors, so its metadata names nothing either,
  // though it isn't marked private; out of the first look, it is named again.
  const tranche = await prisma.flowTranche.create({ data: { programId: `program-${tag}`, listingId: world.live.id, sequence: 1, status: "FIRST_LOOK" } as never });
  try {
    const firstLook = await generateMetadata({ params: Promise.resolve({ id: world.live.id }) });
    assert.equal(firstLook.title, "Listing");
    assert.equal(JSON.stringify(firstLook).includes("Sharetown"), false);
  } finally {
    await prisma.flowTranche.delete({ where: { id: tranche.id } });
  }
  assert.match(String((await generateMetadata({ params: Promise.resolve({ id: world.live.id }) })).title), /Sharetown/);
});

test("share links carry ref=share and encode the link and the text", () => {
  const url = shareUrl("abc 123", "https://upb.example");
  assert.equal(url, "https://upb.example/open/abc%20123?ref=share");
  const facts = cardFactsOf({ ...world.live, notes: world.live.notes });
  assert.ok(facts);
  const links = shareLinks(url, facts);
  const encoded = encodeURIComponent(url);
  assert.equal(links.url, url);
  assert.equal(links.linkedin, `https://www.linkedin.com/sharing/share-offsite/?url=${encoded}`);
  assert.ok(links.x.startsWith(`https://twitter.com/intent/tweet?url=${encoded}&text=`));
  assert.equal(new URL(links.x).searchParams.get("url"), url);
  assert.equal(new URL(links.x).searchParams.get("text"), shareSentence(facts));
  assert.match(shareSentence(facts), /^A first-lien performing note in Sharetown/);
  assert.ok(links.email.startsWith("mailto:?subject="));
  const body = decodeURIComponent(links.email.split("&body=")[1]);
  assert.ok(body.endsWith(`\n\n${url}`));
  assert.equal(links.email.includes(" "), false);
  for (const link of Object.values(links)) assert.equal(link.includes("123456"), false);
});

test("the share panel shows for a public live listing, says so for a private one, and is absent otherwise", async () => {
  const panel = await sharePanel(world.live);
  assert.ok(panel && panel.state === "public");
  assert.ok(panel.url.endsWith(`/open/${world.live.id}?ref=share`));
  assert.equal(panel.visits, 0);
  assert.deepEqual(await sharePanel(world.hidden), { state: "private" });
  for (const row of [world.filed, world.sold, world.soon, world.paused, world.contract]) assert.equal(await sharePanel(row), null, row.notes[0].city);

  const html = renderToStaticMarkup(createElement(ShareListing, { panel: { ...panel, visits: 3 } }));
  assert.match(html, /Share this listing/);
  assert.match(html, /3 visits from shared links/);
  assert.equal((html.match(/target="_blank" rel="noopener noreferrer"/g) ?? []).length, 3);
  assert.ok(html.includes(panel.url.replaceAll("&", "&amp;")));
  assert.match(renderToStaticMarkup(createElement(ShareListing, { panel: { ...panel, visits: 1 } })), /1 visit from shared links/);
  const closed = renderToStaticMarkup(createElement(ShareListing, { panel: { state: "private" } }));
  assert.match(closed, /Private listings have no public link/);
  assert.equal(closed.includes("ref=share"), false);
});

test("visits from shared links count per listing, without previews or the listing's own side", async () => {
  const visit = (over: Partial<Parameters<typeof countsAsSharedVisit>[0]>) =>
    countsAsSharedVisit({ ref: "share", userAgent: BROWSER, viewer: null, listing: world.live, ...over });
  assert.equal(visit({}), true);
  assert.equal(visit({ ref: ["share", "x"] }), true);
  assert.equal(visit({ viewer: world.buyer }), true);
  assert.equal(visit({ ref: undefined }), false);
  assert.equal(visit({ ref: "email" }), false);
  assert.equal(visit({ userAgent: "" }), false);
  for (const agent of ["LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)", "Twitterbot/1.0", "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", "facebookexternalhit/1.1", "Mozilla/5.0 SkypeUriPreview Preview/0.5"]) {
    assert.equal(visit({ userAgent: agent }), false, agent);
  }
  assert.equal(visit({ viewer: world.seller }), false);
  assert.equal(visit({ viewer: world.broker }), false);
  assert.equal(visit({ viewer: world.desk }), false);

  assert.equal(sharedVisitPath(world.live.id), `/open/${world.live.id}?ref=share`);
  await recordSharedVisit(world.live.id);
  await recordSharedVisit(world.live.id);
  await recordSharedVisit(world.pool.id);
  assert.equal(await sharedVisits(world.live.id), 2);
  assert.equal(await sharedVisits(world.pool.id), 1);
  // The hit keeps the page alone: no account, address or browser.
  const hit = await prisma.pageHit.findFirst({ where: { path: sharedVisitPath(world.live.id) } });
  assert.deepEqual(Object.keys(hit ?? {}).sort(), ["createdAt", "id", "path"]);
  const panel = await sharePanel(world.live);
  assert.equal(panel?.state === "public" ? panel.visits : null, 2);
});

test("the card's text keeps to the bundled font's characters", () => {
  assert.equal(glyphs("Española, NM"), "Española, NM");
  assert.equal(glyphs("Kāneʻohe, HI"), "Kaneohe, HI");
  assert.equal(glyphs("$100–250k"), "$100–250k");
});
