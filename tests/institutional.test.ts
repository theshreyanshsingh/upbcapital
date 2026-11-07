import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { sealedFromSeller } from "../lib/auction";
import { askSeller, awardOffer, checkAward, sellerPickBid } from "../lib/awards";
import { addBeneficialOwner } from "../lib/beneficial-owners";
import { addBuyerEntity, bidEntities, chosenEntity, readEntity, reviewBuyerEntity, screenEntity, submitBuyerEntity } from "../lib/buyer-entities";
import { literal } from "../lib/db-filters";
import { checkOffer, writeInquiry } from "../lib/inquiry";
import { entityLabel } from "../lib/labels";
import { buildCalendar, buildLetterPdf, eventPapers, letterContent } from "../lib/process-letter";
import { prisma } from "../lib/prisma";
import { askQuestion } from "../lib/questions";
import { calendarProblem, createEvent, editEvent, enterEvent, inputValue, qaCutoffBlock, readCalendar } from "../lib/sale-events";
import { OFAC_HOLD_MESSAGE } from "../lib/screening";
import { bidVesting, entityVestingName, fundingParty, namesOnTitle } from "../lib/vesting";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// Notices stay in the log and screens use the local list, whatever keys the local .env carries.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL", "OFAC_API_URL", "OFAC_API_KEY", "OFAC_SDN_URL", "BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "DROPBOX_SIGN_API_KEY", "DOCUSIGN_ACCESS_TOKEN", "DOCUSIGN_ACCOUNT_ID"]) process.env[key] = "";

test.after(async () => {
  await prisma.$disconnect();
});

const at = (iso: string) => new Date(`${iso}Z`);
const IRA = { name: "Jane Doe IRA", entityType: "IRA", iraCustodian: "Equity Trust Company", iraAccountTitle: "Equity Trust Company Custodian FBO Jane Doe IRA #12345" };

test("an extra buying entity needs a kind, a name and where it is formed, and an IRA its custodian and account title", () => {
  assert.match(readEntity({ name: "Harbor LLC", entityType: "BANK", jurisdiction: "DE" }).error ?? "", /kind of entity/);
  assert.match(readEntity({ name: " ", entityType: "LLC", jurisdiction: "DE" }).error ?? "", /Name the buying entity/);
  assert.match(readEntity({ name: "Harbor LLC", entityType: "LLC", jurisdiction: "" }).error ?? "", /where the entity is formed/);
  const llc = readEntity({ name: "  Harbor   Note LLC ", entityType: "LLC", jurisdiction: "Delaware", iraCustodian: "ignored", taxIdLast4: "4321" });
  assert.equal(llc.error, null);
  assert.deepEqual(llc.error === null && llc.data, { name: "Harbor Note LLC", entityType: "LLC", jurisdiction: "Delaware", iraCustodian: null, iraAccountTitle: null, taxIdLast4: "4321" });
  // An IRA needs no jurisdiction, but it needs the custodian and a title that vests for the owner's benefit.
  assert.match(readEntity({ ...IRA, iraCustodian: "" }).error ?? "", /custodian/);
  assert.match(readEntity({ ...IRA, iraAccountTitle: "" }).error ?? "", /account title/);
  assert.match(readEntity({ ...IRA, iraAccountTitle: "Jane Doe retirement account" }).error ?? "", /Equity Trust Company Custodian FBO Jane Doe IRA #12345/);
  const ira = readEntity(IRA);
  assert.equal(ira.error, null);
  assert.equal(ira.error === null && ira.data.iraAccountTitle, IRA.iraAccountTitle);
  assert.equal(readEntity({ ...IRA, iraAccountTitle: "Equity Trust Company Custodian for the benefit of Jane Doe IRA" }).error, null);
  // An IRA vests in its account title; anything else in its own name.
  assert.equal(entityVestingName({ name: "Jane Doe IRA", entityType: "IRA", iraAccountTitle: IRA.iraAccountTitle }), IRA.iraAccountTitle);
  assert.equal(entityVestingName({ name: "Harbor Note LLC", entityType: "LLC", iraAccountTitle: null }), "Harbor Note LLC");
  assert.equal(entityLabel("IRA"), "Self-directed IRA");
  assert.equal(entityLabel("LLC"), "Limited liability company");
});

test("the sale calendar runs NDA, Q&A cutoff, indications, best and final, award, closing", () => {
  const rounds = { indicationsAt: at("2026-12-01T17:00:00"), bestFinalAt: at("2026-12-17T17:00:00") };
  const now = at("2026-11-07T12:00:00");
  assert.equal(calendarProblem(rounds), null);
  const good = { ndaDueAt: at("2026-11-20T17:00:00"), qaCutoffAt: at("2026-11-27T17:00:00"), awardTargetAt: at("2026-12-19T17:00:00"), closingTargetAt: at("2027-01-15T17:00:00") };
  assert.equal(calendarProblem({ ...rounds, ...good }), null);
  assert.match(calendarProblem({ ...rounds, ...good, ndaDueAt: at("2026-11-28T17:00:00") }) ?? "", /The NDA date has to fall before the Q&A cutoff/);
  assert.match(calendarProblem({ ...rounds, qaCutoffAt: at("2026-12-01T17:00:00") }) ?? "", /The Q&A cutoff has to fall before the indications date/);
  assert.match(calendarProblem({ ...rounds, ndaDueAt: at("2026-12-02T17:00:00") }) ?? "", /The NDA date has to fall before the indications date/);
  assert.match(calendarProblem({ ...rounds, awardTargetAt: at("2026-12-17T17:00:00") }) ?? "", /The award target has to fall after the best-and-final date/);
  assert.match(calendarProblem({ ...rounds, ...good, closingTargetAt: at("2026-12-18T17:00:00") }) ?? "", /The closing target has to fall after the award target/);
  // Without an award target, the closing target still follows best and final.
  assert.match(calendarProblem({ ...rounds, closingTargetAt: at("2026-12-10T17:00:00") }) ?? "", /The closing target has to fall after the best-and-final date/);

  const read = readCalendar({ ndaDueAt: "2026-11-20T17:00", qaCutoffAt: "2026-11-27T17:00", awardTargetAt: "", closingTargetAt: "2027-01-15T17:00" }, rounds, null, now);
  assert.equal(read.error, null);
  assert.equal(read.error === null && read.calendar.qaCutoffAt?.toISOString(), "2026-11-27T17:00:00.000Z");
  assert.equal(read.error === null && read.calendar.awardTargetAt, null);
  assert.match(readCalendar({ qaCutoffAt: "soon" }, rounds, null, now).error ?? "", /Enter the Q&A cutoff as a date and time/);
  assert.match(readCalendar({ ndaDueAt: "2026-11-01T17:00" }, rounds, null, now).error ?? "", /The NDA date has to be in the future/);
  // A date already on the event may have passed; a field the form didn't send stays as it was.
  const previous = { ndaDueAt: at("2026-11-01T17:00:00"), qaCutoffAt: at("2026-11-27T17:00:00"), awardTargetAt: null, closingTargetAt: null };
  const kept = readCalendar({ ndaDueAt: "2026-11-01T17:00" }, rounds, previous, now);
  assert.equal(kept.error, null);
  assert.equal(kept.error === null && kept.calendar.qaCutoffAt?.getTime(), previous.qaCutoffAt.getTime());
});

test("the calendar file carries every date in UTC, escaped and folded, and a canceled event says so", () => {
  const event = {
    id: "evt1",
    name: "December NPL sale, pools; singles",
    status: "INDICATIONS" as const,
    indicationsAt: at("2026-12-01T17:00:00"),
    bestFinalAt: at("2026-12-17T17:00:00"),
    ndaDueAt: at("2026-11-20T17:00:00"),
    qaCutoffAt: at("2026-11-27T17:00:00"),
    awardTargetAt: at("2026-12-19T17:00:00"),
    closingTargetAt: null,
    createdAt: at("2026-11-01T00:00:00"),
    updatedAt: at("2026-11-01T00:10:00"),
  };
  const ics = buildCalendar(event, { appUrl: "https://upb.example", now: at("2026-11-07T12:00:00") });
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.equal(ics.match(/BEGIN:VEVENT/g)?.length, 5);
  for (const start of ["20261120T170000Z", "20261127T170000Z", "20261201T170000Z", "20261217T170000Z", "20261219T170000Z"]) assert.ok(ics.includes(`DTSTART:${start}`), start);
  assert.ok(ics.includes("UID:evt1-qaCutoffAt@upbcapital"));
  assert.ok(ics.includes("DTSTAMP:20261107T120000Z"));
  assert.ok(ics.includes("SEQUENCE:600"));
  assert.ok(ics.includes("X-WR-CALNAME:December NPL sale\\, pools\\; singles"));
  // Every physical line fits in 75 octets, and no bare newline sneaks in.
  for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line, "utf8") <= 75, line);
  assert.equal(ics.replace(/\r\n/g, "").includes("\n"), false);
  const unfolded = ics.replace(/\r\n /g, "");
  assert.ok(unfolded.includes("SUMMARY:Questions close: December NPL sale\\, pools\\; singles"));
  assert.ok(unfolded.includes("Process letter: https://upb.example/api/events/evt1/letter"));
  assert.ok(unfolded.includes("URL:https://upb.example/events#evt1"));
  assert.equal(ics.includes("STATUS:CANCELLED"), false);
  assert.equal(buildCalendar({ ...event, status: "CANCELED" as const }).match(/STATUS:CANCELLED/g)?.length, 5);
});

test("the process letter names the listings, every date, the bid rules, the terms from settings and the contact", async () => {
  const event = {
    name: "December NPL sale",
    status: "INDICATIONS" as const,
    summary: "Twelve sellers, first liens.",
    indicationsAt: at("2026-12-01T17:00:00"),
    bestFinalAt: at("2026-12-17T17:00:00"),
    ndaDueAt: at("2026-11-20T17:00:00"),
    qaCutoffAt: at("2026-11-27T17:00:00"),
    awardTargetAt: at("2026-12-19T17:00:00"),
    closingTargetAt: at("2027-01-15T17:00:00"),
    processNotes: "Site visits by appointment.\nCall the desk first.",
  };
  const content = letterContent({
    event,
    listings: [{ title: "Tampa pool", kind: "POOL", loans: 12 }, { title: "Ohio note", kind: "SINGLE", loans: 1 }],
    others: 0,
    settings: { depositBps: 1000, depositDays: 3, diligenceDays: 5 },
    contact: "Dana Desk, dana@upb.example",
    now: at("2026-11-07T12:00:00"),
  });
  assert.equal(content.status, "Indications open");
  assert.deepEqual(content.listings, ["Tampa pool · 12 loans", "Ohio note · one note"]);
  assert.deepEqual(content.dates.map(([label]) => label), ["NDA signed by", "Questions close", "Indications due", "Best and final due", "Award target", "Closing target"]);
  assert.deepEqual(content.dates[2], ["Indications due", "Dec 1, 2026, 17:00 UTC"]);
  const rules = content.rules.join(" ");
  assert.match(rules, /Indications are sealed bids, due by Dec 1, 2026, 17:00 UTC/);
  assert.match(rules, /one best-and-final bid by Dec 17, 2026, 17:00 UTC, 16 days later/);
  assert.match(rules, /good-until date has to fall on or after the best-and-final date/);
  assert.match(rules, /deposit of 10% of the price within 3 days of the award/);
  assert.match(rules, /5 days of diligence/);
  assert.match(rules, /until Nov 27, 2026, 17:00 UTC/);
  assert.match(rules, /aiming for Dec 19, 2026, 17:00 UTC/);
  assert.equal(content.notes, "Site visits by appointment.\nCall the desk first.");
  assert.equal(content.contact, "Dana Desk, dana@upb.example");
  // No deposit and no diligence read as such.
  const bare = letterContent({ event: { ...event, ndaDueAt: null, qaCutoffAt: null, awardTargetAt: null, closingTargetAt: null, processNotes: "" }, listings: [], others: 2, settings: { depositBps: 0, diligenceDays: 0 }, contact: "desk" });
  assert.equal(bare.dates.length, 2);
  assert.match(bare.rules.join(" "), /No deposit is due at award/);
  assert.match(bare.rules.join(" "), /no diligence window/);
  assert.equal(bare.others, 2);
  // The page itself is a PDF that reads back, with a long note running onto a second page.
  const pdf = await buildLetterPdf({ ...content, notes: Array.from({ length: 80 }, (_, index) => `Note line ${index}.`).join("\n") });
  const loaded = await PDFDocument.load(pdf);
  assert.ok(loaded.getPageCount() >= 2);
  assert.equal(Buffer.from(pdf.slice(0, 5)).toString(), "%PDF-");
});

// Timestamp-tagged people and listings nothing seeded touches: a desk member, a seller with one live note, buyers
// with approved main files.
async function makeWorld(opts: { buyers?: number; listings?: number } = {}) {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const person = (prefix: string, role: "INDIVIDUAL_SELLER" | "BUYER" | "ADMIN", status: "APPROVED" | "PENDING" = "APPROVED") =>
    prisma.user.create({
      data: {
        email: `inst-${prefix}-${tag}@example.org`,
        name: `${prefix} ${tag}`,
        role,
        accountStatus: status,
        passwordHash: "x",
        ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
      },
    });
  const desk = await person("desk", "ADMIN");
  const seller = await person("seller", "INDIVIDUAL_SELLER");
  const other = await person("other", "INDIVIDUAL_SELLER");
  const buyers = [];
  for (let index = 0; index < (opts.buyers ?? 3); index += 1) {
    const buyer = await person(`buyer${index}`, "BUYER");
    await prisma.buyerProfile.create({
      data: { userId: buyer.id, status: "APPROVED", entityType: "LLC", entityName: `Main Fund ${index} ${tag}`, homesControlled: 4, reoStrategy: "SELL", eligibilityAt: new Date(Date.now() - DAY) },
    });
    buyers.push(buyer);
  }
  const listings = [];
  for (let index = 0; index < (opts.listings ?? 1); index += 1) {
    listings.push(
      await prisma.listing.create({
        data: {
          kind: "SINGLE",
          sellerId: index === 0 ? seller.id : other.id,
          status: "APPROVED",
          approvedAt: new Date(Date.now() - 7 * DAY),
          title: `Institutional note ${index} ${tag}`,
          notes: {
            create: [{
              streetAddress: `${index} First St`, city: "Testville", state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
              lienPosition: "FIRST", upb: 200000, interestRate: 7, monthlyPi: 1400, paymentStatus: "PERFORMING", monthsDelinquent: 0,
              askingPrice: 120000, estimatedValue: 260000,
            }] as never,
          },
        },
      }),
    );
  }
  return { tag, desk, seller, other, buyers, listings, users: [desk, seller, other, ...buyers], eventIds: [] as string[] };
}

type World = Awaited<ReturnType<typeof makeWorld>>;

async function cleanWorld(world: World) {
  const listingIds = world.listings.map((listing) => listing.id);
  const userIds = world.users.map((user) => user.id);
  const inquiryIds = (await prisma.inquiry.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((row) => row.id);
  const closingIds = (await prisma.closing.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((row) => row.id);
  const entities = [...listingIds, ...inquiryIds, ...closingIds, ...userIds, ...world.eventIds];
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: entities } }, { actorId: { in: userIds } }] } });
  await prisma.deskThread.deleteMany({ where: { OR: [{ listingId: { in: listingIds } }, { inquiryId: { in: inquiryIds } }, { closingId: { in: closingIds } }] } });
  await prisma.revenueEvent.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.ofacCheck.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { name: { contains: literal(world.tag) } }] } });
  await prisma.offerMessage.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.saleEvent.deleteMany({ where: { id: { in: world.eventIds } } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: world.users.map((user) => user.email) } }, { subject: { contains: literal(world.tag) } }, { body: { contains: literal(world.tag) } }] } });
  await prisma.rateWindow.deleteMany({ where: { key: { in: userIds.map((id) => `question:${id}`) } } });
  await prisma.beneficialOwner.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.buyerEntity.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

const listingNow = (id: string) => prisma.listing.findUniqueOrThrow({ where: { id }, include: { seller: true } });
const inquiryNow = (id: string) => prisma.inquiry.findUniqueOrThrow({ where: { id } });

// A bid through the same checks the bid form runs.
async function bid(buyer: World["buyers"][number], listingId: string, amount: number, buyerEntityId: string | null = null) {
  const listing = await listingNow(listingId);
  const check = await checkOffer({ user: buyer, listing, noteId: "", amount, goodUntil: "", buyerEntityId });
  if (check.error !== null) return { error: check.error, id: "" };
  const inquiry = await writeInquiry({ user: buyer, listing, type: "OFFER", noteId: "", amount, message: "", expiresAt: check.expiresAt, buyerEntityId: check.buyerEntityId });
  return { error: null, id: inquiry.id };
}

// An entity that lists owners goes to the desk with its EIN's last four and a control person, as the verification page
// sends it.
async function addEntity(buyer: World["buyers"][number], input: Parameters<typeof addBuyerEntity>[1]) {
  const result = await addBuyerEntity(buyer, { taxIdLast4: "4321", ...input });
  if (result.error !== null) assert.fail(result.error);
  if (result.entity.status !== "NOT_STARTED") return result.entity;
  const owner = await addBeneficialOwner(buyer, { buyerEntityId: result.entity.id, name: `Owner ${result.entity.id}`, title: "Managing member", ownershipPct: "100", controlPerson: "yes" });
  if (owner.error !== null) assert.fail(owner.error);
  const sent = await submitBuyerEntity(buyer, result.entity.id);
  if (sent.error !== null) assert.fail(sent.error);
  return sent.entity;
}

test("a buyer adds entities once the main file is approved, and the desk approves or declines each with a note", async () => {
  const world = await makeWorld({ buyers: 2 });
  try {
    const [buyer, stranger] = world.buyers;
    await prisma.buyerProfile.update({ where: { userId: buyer.id }, data: { status: "SUBMITTED" } });
    assert.match((await addBuyerEntity(buyer, { name: `Harbor ${world.tag} LLC`, entityType: "LLC", jurisdiction: "Delaware" })).error ?? "", /main buyer file first/);
    await prisma.buyerProfile.update({ where: { userId: buyer.id }, data: { status: "APPROVED" } });

    const llc = await addEntity(buyer, { name: `Harbor ${world.tag} LLC`, entityType: "LLC", jurisdiction: "Delaware" });
    assert.equal(llc.status, "SUBMITTED");
    assert.match((await addBuyerEntity(buyer, { name: `harbor ${world.tag} llc`, entityType: "LLC", jurisdiction: "Texas", taxIdLast4: "4321" })).error ?? "", /already on your file/);
    assert.match((await addBuyerEntity(buyer, { name: `Main Fund 0 ${world.tag}`, entityType: "LLC", jurisdiction: "Texas", taxIdLast4: "4321" })).error ?? "", /already on your file/);
    assert.match((await addBuyerEntity(buyer, { ...IRA, name: `Doe ${world.tag} IRA`, iraAccountTitle: "" })).error ?? "", /account title/);
    const ira = await addEntity(buyer, { ...IRA, name: `Doe ${world.tag} IRA` });
    assert.equal(ira.iraCustodian, "Equity Trust Company");
    assert.ok(await prisma.auditEvent.findFirst({ where: { entityId: buyer.id, action: "BUYER_ENTITY_ADDED", detail: { contains: ira.id } } }));

    // Nothing to choose until the desk approves one: the bid form shows the main file alone.
    assert.deepEqual((await bidEntities(buyer.id)).map((choice) => choice.id), [""]);
    assert.match((await chosenEntity(buyer.id, llc.id)).error ?? "", /isn't approved/);

    assert.match((await reviewBuyerEntity(world.desk, { entityId: llc.id, decision: "MAYBE", note: "" })).error ?? "", /Approve or reject/);
    assert.match((await reviewBuyerEntity(world.desk, { entityId: llc.id, decision: "REJECTED", note: "" })).error ?? "", /Tell the buyer why/);
    assert.equal((await reviewBuyerEntity(world.desk, { entityId: llc.id, decision: "REJECTED", note: "The operating agreement is missing." })).error, null);
    const declined = await prisma.buyerEntity.findUniqueOrThrow({ where: { id: llc.id } });
    assert.equal(declined.status, "REJECTED");
    assert.equal(declined.reviewerNote, "The operating agreement is missing.");
    assert.equal(declined.reviewedById, world.desk.id);
    assert.ok(await prisma.notification.findFirst({ where: { toEmail: buyer.email, subject: { contains: literal(`Buying entity declined · Harbor ${world.tag} LLC`) } } }));
    // A declined entity can come back with fixes.
    const again = await addEntity(buyer, { name: `Harbor ${world.tag} LLC`, entityType: "LLC", jurisdiction: "Delaware" });

    assert.equal((await reviewBuyerEntity(world.desk, { entityId: ira.id, decision: "APPROVED", note: "" })).error, null);
    assert.equal((await reviewBuyerEntity(world.desk, { entityId: again.id, decision: "APPROVED", note: "Agreement on file." })).error, null);
    // Approval screened the entity and its custodian against the account.
    const screens = await prisma.ofacCheck.findMany({ where: { userId: buyer.id, context: { contains: "Buying entity approval" } } });
    assert.deepEqual(new Set(screens.map((row) => row.name)), new Set([`Doe ${world.tag} IRA`, "Equity Trust Company", `Harbor ${world.tag} LLC`]));
    const choices = await bidEntities(buyer.id);
    assert.deepEqual(choices.map((choice) => choice.name), [`Main Fund 0 ${world.tag}`, `Doe ${world.tag} IRA`, `Harbor ${world.tag} LLC`]);
    assert.equal(choices[1].vestsAs, IRA.iraAccountTitle);
    assert.equal(choices[1].custodian, "Equity Trust Company");
    assert.equal(choices[1].kind, "Self-directed IRA");
    // Another buyer can't bid through someone else's entity.
    assert.match((await chosenEntity(stranger.id, ira.id)).error ?? "", /your own buying entities/);
  } finally {
    await cleanWorld(world);
  }
});

test("a sanctions match on an entity name holds the entity and the buyer's awards", async () => {
  const world = await makeWorld({ buyers: 1 });
  try {
    const [buyer] = world.buyers;
    await prisma.listing.update({ where: { id: world.listings[0].id }, data: { reservePrice: 90000 } });
    const placed = await bid(buyer, world.listings[0].id, 100000);
    assert.equal(placed.error, null);
    const flagged = await addEntity(buyer, { name: `Blocked Test ${world.tag}`, entityType: "TRUST", jurisdiction: "Nevada" });
    const screen = await screenEntity(flagged, "Buying entity added");
    assert.equal(screen.blocked, true);
    const row = await prisma.ofacCheck.findFirstOrThrow({ where: { userId: buyer.id, name: `Blocked Test ${world.tag}` } });
    assert.equal(row.result, "REVIEW");
    assert.match(row.context ?? "", /Buying entity added: Blocked Test/);
    // The desk can't approve it while the match is open, and the hold reaches the buyer's other bids too.
    assert.equal((await reviewBuyerEntity(world.desk, { entityId: flagged.id, decision: "APPROVED", note: "" })).error, OFAC_HOLD_MESSAGE);
    assert.equal((await prisma.buyerEntity.findUniqueOrThrow({ where: { id: flagged.id } })).status, "SUBMITTED");
    assert.equal((await checkAward(placed.id)).error, OFAC_HOLD_MESSAGE);
    // Cleared by compliance, the entity can be approved and the bid awarded.
    await prisma.ofacCheck.updateMany({ where: { userId: buyer.id, result: "REVIEW" }, data: { status: "CLEARED", reviewedById: world.desk.id, reviewedAt: new Date(), reviewNote: "Different party." } });
    assert.equal((await reviewBuyerEntity(world.desk, { entityId: flagged.id, decision: "APPROVED", note: "" })).error, null);
    assert.equal((await checkAward(placed.id)).error, null);
  } finally {
    await cleanWorld(world);
  }
});

test("a bid names an approved entity, and the closing takes title in it, an IRA in its account title", async () => {
  const world = await makeWorld({ buyers: 2, listings: 3 });
  try {
    const [buyer, other] = world.buyers;
    const [iraListing, llcListing, mainListing] = world.listings;
    for (const listing of world.listings) await prisma.listing.update({ where: { id: listing.id }, data: { reservePrice: 90000 } });
    const ira = await addEntity(buyer, { ...IRA, name: `Doe ${world.tag} IRA` });
    const llc = await addEntity(buyer, { name: `Harbor ${world.tag} LLC`, entityType: "LLC", jurisdiction: "Delaware" });
    const pending = await addEntity(buyer, { name: `Pending ${world.tag} Trust`, entityType: "TRUST", jurisdiction: "Ohio" });
    for (const entity of [ira, llc]) assert.equal((await reviewBuyerEntity(world.desk, { entityId: entity.id, decision: "APPROVED", note: "" })).error, null);

    // Only the buyer's own approved entities pass, and a blank choice is the main file.
    assert.match((await bid(buyer, iraListing.id, 100000, pending.id)).error ?? "", /isn't approved/);
    assert.match((await bid(other, iraListing.id, 100000, ira.id)).error ?? "", /your own buying entities/);
    assert.match((await bid(buyer, iraListing.id, 100000, "no-such-entity")).error ?? "", /your own buying entities/);
    const viaIra = await bid(buyer, iraListing.id, 100000, ira.id);
    const viaLlc = await bid(buyer, llcListing.id, 100000, llc.id);
    const viaMain = await bid(buyer, mainListing.id, 100000, "");
    for (const placed of [viaIra, viaLlc, viaMain]) assert.equal(placed.error, null);
    assert.equal((await inquiryNow(viaIra.id)).buyerEntityId, ira.id);
    assert.equal((await inquiryNow(viaMain.id)).buyerEntityId ?? null, null);
    assert.deepEqual(await bidVesting({ buyerId: other.id, buyerEntityId: ira.id }), { name: `Main Fund 1 ${world.tag}`, entityId: null });

    // The reserve covers each bid, so each awards and opens its closing.
    const closings = [];
    for (const placed of [viaIra, viaLlc, viaMain]) {
      const award = await awardOffer(placed.id, world.desk.id);
      if (award.error !== null) assert.fail(award.error);
      closings.push(await prisma.closing.findUniqueOrThrow({ where: { id: award.closingId } }));
    }
    const [iraClosing, llcClosing, mainClosing] = closings;
    assert.equal(iraClosing.buyerEntity, IRA.iraAccountTitle);
    assert.equal(iraClosing.buyerEntityId, ira.id);
    assert.equal(llcClosing.buyerEntity, `Harbor ${world.tag} LLC`);
    assert.equal(mainClosing.buyerEntity, `Main Fund 0 ${world.tag}`);
    assert.equal(mainClosing.buyerEntityId ?? null, null);
    // The papers, statement, boarding file and sale notice read the name fixed at award.
    assert.equal((await namesOnTitle(iraClosing, buyer.id, [])).buyer, IRA.iraAccountTitle);
    // The IRA's custodian is the funding party; nobody else has one.
    assert.deepEqual(await fundingParty(iraClosing), { custodian: "Equity Trust Company", accountTitle: IRA.iraAccountTitle });
    assert.equal(await fundingParty(llcClosing), null);
    assert.equal(await fundingParty(mainClosing), null);
  } finally {
    await cleanWorld(world);
  }
});

test("a bid can't be awarded under an entity the desk has since declined", async () => {
  const world = await makeWorld({ buyers: 1 });
  try {
    const [buyer] = world.buyers;
    await prisma.listing.update({ where: { id: world.listings[0].id }, data: { reservePrice: 90000 } });
    const llc = await addEntity(buyer, { name: `Harbor ${world.tag} LLC`, entityType: "LLC", jurisdiction: "Delaware" });
    assert.equal((await reviewBuyerEntity(world.desk, { entityId: llc.id, decision: "APPROVED", note: "" })).error, null);
    const placed = await bid(buyer, world.listings[0].id, 100000, llc.id);
    assert.equal(placed.error, null);
    assert.equal((await reviewBuyerEntity(world.desk, { entityId: llc.id, decision: "REJECTED", note: "Good standing lapsed." })).error, null);
    assert.match((await checkAward(placed.id)).error ?? "", /which the desk hasn't approved/);
    assert.match((await awardOffer(placed.id, world.desk.id)).error ?? "", /which the desk hasn't approved/);
    const notice = await prisma.notification.findFirstOrThrow({ where: { toEmail: buyer.email, subject: { contains: literal(`Buying entity declined · Harbor ${world.tag} LLC`) } } });
    assert.match(notice.body, /1 open bid is for it/);
  } finally {
    await cleanWorld(world);
  }
});

async function newEvent(world: World, extra: Partial<Parameters<typeof createEvent>[0]> = {}) {
  const indicationsAt = new Date(Math.ceil((Date.now() + 10 * DAY) / 60000) * 60000);
  const bestFinalAt = new Date(indicationsAt.getTime() + 16 * DAY);
  const made = await createEvent({ name: `Process sale ${world.tag}`, summary: "Small NPL sale.", indicationsAt: inputValue(indicationsAt), bestFinalAt: inputValue(bestFinalAt), actorId: world.desk.id, ...extra });
  if (made.error !== null) assert.fail(made.error);
  world.eventIds.push(made.event.id);
  return made.event;
}

test("the desk sets the process calendar in order, and questions close at the Q&A cutoff", async () => {
  const world = await makeWorld({ buyers: 2, listings: 2 });
  try {
    const indicationsAt = new Date(Math.ceil((Date.now() + 10 * DAY) / 60000) * 60000);
    const bestFinalAt = new Date(indicationsAt.getTime() + 16 * DAY);
    const base = { name: `Process sale ${world.tag}`, summary: "", indicationsAt: inputValue(indicationsAt), bestFinalAt: inputValue(bestFinalAt), actorId: world.desk.id };
    // Out of order is refused, and nothing is made.
    const late = await createEvent({ ...base, qaCutoffAt: inputValue(new Date(indicationsAt.getTime() + HOUR)) });
    assert.match(late.error ?? "", /The Q&A cutoff has to fall before the indications date/);
    const early = await createEvent({ ...base, awardTargetAt: inputValue(new Date(bestFinalAt.getTime() - HOUR)) });
    assert.match(early.error ?? "", /The award target has to fall after the best-and-final date/);
    assert.equal(await prisma.saleEvent.count({ where: { name: base.name } }), 0);

    const event = await newEvent(world, {
      ndaDueAt: inputValue(new Date(indicationsAt.getTime() - 5 * DAY)),
      qaCutoffAt: inputValue(new Date(indicationsAt.getTime() - 2 * DAY)),
      awardTargetAt: inputValue(new Date(bestFinalAt.getTime() + 2 * DAY)),
      closingTargetAt: inputValue(new Date(bestFinalAt.getTime() + 30 * DAY)),
      processNotes: "  Site visits by appointment.  ",
    });
    assert.equal(event.qaCutoffAt?.getTime(), indicationsAt.getTime() - 2 * DAY);
    assert.equal(event.processNotes, "Site visits by appointment.");
    // An edit keeps the order too, and a blank clears a date.
    const fields = { eventId: event.id, name: event.name, summary: "", indicationsAt: inputValue(indicationsAt), bestFinalAt: inputValue(bestFinalAt), actorId: world.desk.id };
    assert.match((await editEvent({ ...fields, closingTargetAt: inputValue(new Date(bestFinalAt.getTime() + DAY)) })).error ?? "", /The closing target has to fall after the award target/);
    assert.equal((await editEvent({ ...fields, ndaDueAt: "", processNotes: "Call the desk first." })).error, null);
    const edited = await prisma.saleEvent.findUniqueOrThrow({ where: { id: event.id } });
    assert.equal(edited.ndaDueAt ?? null, null);
    assert.equal(edited.qaCutoffAt?.getTime(), event.qaCutoffAt?.getTime());
    assert.equal(edited.processNotes, "Call the desk first.");
    assert.ok(await prisma.auditEvent.findFirst({ where: { entityId: event.id, action: "SALE_EVENT_CALENDAR" } }));

    const [listing, outside] = world.listings;
    const [buyer] = world.buyers;
    assert.equal((await enterEvent({ eventId: event.id, listingId: listing.id, consent: "Seller email of Nov 7", actorId: world.desk.id })).error, null);
    for (const item of world.listings) await prisma.ndaAcknowledgment.create({ data: { userId: buyer.id, listingId: item.id, signerName: "Buyer Signer" } });
    const asker = buyer;
    const before = await askQuestion(asker, { listingId: listing.id, question: "Is the payment history complete?" });
    assert.equal(before.ok, true);
    // Past the cutoff, a question on the event's listing is refused with the date, and one elsewhere still goes.
    await prisma.saleEvent.update({ where: { id: event.id }, data: { qaCutoffAt: new Date(Date.now() - HOUR) } });
    const after = await askQuestion(asker, { listingId: listing.id, question: "Is the title clear?" });
    assert.equal(after.ok, false);
    assert.match(!after.ok ? after.error : "", /Questions for this sale event closed .* UTC, so no new ones go to the seller/);
    assert.match((await qaCutoffBlock({ saleEventId: event.id })) ?? "", /closed/);
    assert.equal(await qaCutoffBlock({ saleEventId: null }), null);
    assert.equal((await askQuestion(asker, { listingId: outside.id, question: "Is the title clear?" })).ok, true);
    assert.equal(await prisma.listingQuestion.count({ where: { listingId: listing.id } }), 1);
  } finally {
    await prisma.listingQuestion.deleteMany({ where: { listingId: { in: world.listings.map((listing) => listing.id) } } });
    await prisma.ndaAcknowledgment.deleteMany({ where: { listingId: { in: world.listings.map((listing) => listing.id) } } });
    await cleanWorld(world);
  }
});

test("the letter and calendar open to approved buyers, the desk and the event's own sellers", async () => {
  const world = await makeWorld({ buyers: 1, listings: 2 });
  try {
    const event = await newEvent(world, { processNotes: "Call the desk first." });
    for (const listing of world.listings) assert.equal((await enterEvent({ eventId: event.id, listingId: listing.id, consent: "Seller email", actorId: world.desk.id })).error, null);
    const outsider = await prisma.user.create({ data: { email: `inst-outsider-${world.tag}@example.org`, name: `outsider ${world.tag}`, role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } });
    const waiting = await prisma.user.create({ data: { email: `inst-waiting-${world.tag}@example.org`, name: `waiting ${world.tag}`, role: "BUYER", accountStatus: "PENDING", passwordHash: "x" } });
    world.users.push(outsider, waiting);

    const forBuyer = await eventPapers(event.id, world.buyers[0]);
    assert.equal(forBuyer.status, 200);
    assert.equal(forBuyer.status === 200 && forBuyer.listings.length, 2);
    const forDesk = await eventPapers(event.id, world.desk);
    assert.equal(forDesk.status, 200);
    // A seller sees their own listing by name and the other as a count.
    const forSeller = await eventPapers(event.id, world.seller);
    assert.equal(forSeller.status, 200);
    assert.deepEqual(forSeller.status === 200 && forSeller.listings.map((listing) => listing.id), [world.listings[0].id]);
    assert.equal(forSeller.status === 200 && forSeller.others, 1);
    assert.equal((await eventPapers(event.id, outsider)).status, 403);
    assert.equal((await eventPapers(event.id, waiting)).status, 403);
    assert.equal((await eventPapers(`missing-${world.tag}`, world.desk)).status, 404);

    if (forBuyer.status !== 200) assert.fail("no papers");
    const ics = buildCalendar(forBuyer.event);
    assert.equal(ics.match(/BEGIN:VEVENT/g)?.length, 2);
    const content = letterContent({ event: forBuyer.event, listings: forBuyer.listings, others: forBuyer.others, settings: {}, contact: "desk" });
    assert.equal(content.listings.length, 2);
    assert.ok(content.listings.every((line) => line.endsWith("· one note")));
    assert.equal(content.notes, "Call the desk first.");
  } finally {
    await cleanWorld(world);
  }
});

test("the seller picks a bid the desk didn't recommend, which records agreement and lets the award pass", async () => {
  const world = await makeWorld({ buyers: 3 });
  try {
    const [b0, b1, b2] = world.buyers;
    const listingId = world.listings[0].id;
    const low = await bid(b0, listingId, 100000);
    const middle = await bid(b1, listingId, 110000);
    const high = await bid(b2, listingId, 120000);
    for (const placed of [low, middle, high]) assert.equal(placed.error, null);
    // No reserve, so the desk asks the seller about the highest bid.
    const check = await checkAward(high.id);
    if (check.error !== null) assert.fail(check.error);
    assert.equal(check.agreed, null);
    await askSeller(check.offer, check.price);

    // The seller can't pick a bid that isn't theirs, at a figure that changed, or the one waiting on them.
    assert.match((await sellerPickBid({ inquiryId: low.id, sellerId: world.other.id, price: 100000 })).error ?? "", /isn't on your listing/);
    assert.match((await sellerPickBid({ inquiryId: low.id, sellerId: world.seller.id, price: 95000 })).error ?? "", /changed this bid/);
    assert.match((await sellerPickBid({ inquiryId: high.id, sellerId: world.seller.id, price: 120000 })).error ?? "", /The desk asked you about this bid/);

    // A first pick, then a change of mind: the second replaces the first.
    assert.equal((await sellerPickBid({ inquiryId: middle.id, sellerId: world.seller.id, price: 110000 })).error, null);
    const picked = await sellerPickBid({ inquiryId: low.id, sellerId: world.seller.id, price: 100000 });
    assert.equal(picked.error, null);
    assert.match(picked.error === null ? picked.alias : "", /^Bidder [A-C]$/);
    const lowNow = await inquiryNow(low.id);
    assert.ok(lowNow.sellerRequestedAt);
    assert.equal(lowNow.sellerApprovedAmount, 100000);
    const middleNow = await inquiryNow(middle.id);
    assert.equal(middleNow.sellerRequestedAt ?? null, null);
    assert.equal(middleNow.sellerApprovedAmount ?? null, null);
    // The recommended bid was answered as declined.
    const highNow = await inquiryNow(high.id);
    assert.equal(highNow.sellerDeclined, true);
    assert.ok(highNow.sellerAnsweredAt);
    // The first pick declined the recommendation; the second replaced the first.
    const firstPick = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: middle.id, action: "SELLER_PICKED" } });
    assert.match(firstPick.detail, /\$110,000 for the whole listing · the seller agrees to sell at this price · declined 1 recommended bid/);
    const secondPick = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: low.id, action: "SELLER_PICKED" } });
    assert.match(secondPick.detail, /\$100,000 for the whole listing · the seller agrees to sell at this price · replaces an earlier pick$/);
    assert.ok(await prisma.auditEvent.findFirst({ where: { entityId: high.id, action: "SELLER_DECLINED" } }));
    assert.ok(await prisma.notification.findFirst({ where: { subject: { contains: literal(`Seller picked a bid · ${world.listings[0].title}`) } } }));

    // The award's own checks pass on the recorded agreement, and the other bids close.
    // The replaced pick no longer counts as the seller's word on that bid.
    const middleCheck = await checkAward(middle.id);
    assert.equal(middleCheck.error === null && middleCheck.agreed, null);
    const ready = await checkAward(low.id);
    assert.equal(ready.error === null && ready.agreed, "approved");
    const award = await awardOffer(low.id, world.desk.id);
    assert.equal(award.error, null);
    assert.equal((await inquiryNow(low.id)).status, "ACCEPTED");
    assert.equal((await inquiryNow(high.id)).status, "DECLINED");
    assert.equal((await inquiryNow(middle.id)).status, "DECLINED");
  } finally {
    await cleanWorld(world);
  }
});

test("in a sealed round the seller can't see or pick amounts before the deadline, and can after", async () => {
  const world = await makeWorld({ buyers: 2 });
  try {
    const [b0, b1] = world.buyers;
    const listingId = world.listings[0].id;
    await prisma.listing.update({ where: { id: listingId }, data: { bidMode: "SEALED", bidDeadline: new Date(Date.now() + 2 * DAY) } });
    const first = await bid(b0, listingId, 100000);
    const second = await bid(b1, listingId, 105000);
    for (const placed of [first, second]) assert.equal(placed.error, null);
    assert.equal(sealedFromSeller(await listingNow(listingId)), true);
    assert.match((await sellerPickBid({ inquiryId: first.id, sellerId: world.seller.id, price: 100000 })).error ?? "", /sealed until the deadline/);
    assert.equal((await inquiryNow(first.id)).sellerRequestedAt ?? null, null);
    assert.equal((await inquiryNow(first.id)).sellerApprovedAmount ?? null, null);

    // Once the deadline passes the amounts open, and the seller can pick the lower one.
    await prisma.listing.update({ where: { id: listingId }, data: { bidDeadline: new Date(Date.now() - HOUR) } });
    assert.equal(sealedFromSeller(await listingNow(listingId)), false);
    assert.equal((await sellerPickBid({ inquiryId: first.id, sellerId: world.seller.id, price: 100000 })).error, null);
    const ready = await checkAward(first.id);
    assert.equal(ready.error === null && ready.agreed, "approved");
  } finally {
    await cleanWorld(world);
  }
});
