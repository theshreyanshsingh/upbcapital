import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { accretedBetween, accretedThrough, accretionByYear, accretionSchedule, ACCRETION_NOTE, addMonths, ASSUMED_HORIZON_MONTHS } from "../lib/accretion";
import { searchCommands, type CommandItem } from "../lib/command-search";
import { DESK_DENIED } from "../lib/desk-roles";
import { STATEMENT_NOTE, statementCsv, taxYearStatement, type StatementHolding } from "../lib/portfolio-tax";
import { prisma } from "../lib/prisma";
import { activeServicers, boardingChoices, boardingServicer, readServicerForm, saveServicer, setServicerActive, stateGaps } from "../lib/servicers";
import { projectFlows } from "../lib/underwriting";

const DAY = 24 * 60 * 60 * 1000;
const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);
// Fixed holds, so the search doesn't depend on the desk's settings.
const SETTINGS = { earlyAccessHours: 48, freeBrowseLimit: 1 };
// Notices stay in the log, whatever keys the local .env carries.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL"]) process.env[key] = "";

test.after(async () => {
  await prisma.$disconnect();
});

type Role = "INDIVIDUAL_SELLER" | "BUYER" | "ADMIN";

// Tagged people, each with an f-search- email, so cleanup removes only what this file made.
async function people() {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const users: { id: string }[] = [];
  const person = async (prefix: string, role: Role, extra: Record<string, unknown> = {}) => {
    const user = await prisma.user.create({
      data: { email: `f-search-${prefix}-${tag}@example.org`, name: `${prefix} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x", ...extra },
    });
    users.push(user);
    return user;
  };
  return { tag, users, person };
}

const pro = { subscriptionTier: "PRO", subscriptionStatus: "ACTIVE", subscriptionCurrentPeriodEnd: new Date(Date.now() + 30 * DAY) };

// ---------------------------------------------------------------------------------------------------------------
// The servicer directory.

test("only the closings side keeps the servicer directory, and every change is in the audit log", async () => {
  const { tag, users, person } = await people();
  const servicerIds: string[] = [];
  try {
    const closer = await person("closer", "ADMIN", { deskRole: "CLOSINGS" });
    const analyst = await person("analyst", "ADMIN", { deskRole: "ANALYST" });
    const sales = await person("sales", "ADMIN", { deskRole: "SALES" });
    const buyer = await person("buyer", "BUYER");
    const form = { name: `FSearch Servicing ${tag}`, website: "fsearch-servicing.example", contactEmail: "boarding@fsearch-servicing.example", states: "fl, GA ga", importFormat: "FCI", boardingFee: "$150 a loan", monthlyFee: "$18 performing", notes: "Boards in ten days." };
    for (const actor of [analyst, sales, buyer]) {
      assert.deepEqual(await saveServicer(actor, form), { ok: false, error: DESK_DENIED }, actor.email);
    }
    const added = await saveServicer(closer, form);
    assert.ok(added.ok, JSON.stringify(added));
    servicerIds.push(added.value.id);
    const row = await prisma.servicer.findUniqueOrThrow({ where: { id: added.value.id } });
    assert.equal(row.website, "https://fsearch-servicing.example/");
    assert.deepEqual(row.states, ["FL", "GA"]);
    assert.equal(row.importFormat, "FCI");
    assert.equal(row.boardingFee, "$150 a loan", "fees are kept as entered");
    assert.ok(await prisma.auditEvent.findFirst({ where: { actorId: closer.id, action: "SERVICER_ADD", entityType: "servicer", entityId: row.id } }));

    // A name is one servicer however it's typed, and bad fields are refused with a reason.
    assert.match((await saveServicer(closer, { ...form, name: form.name.toUpperCase() }) as { error: string }).error, /already on the directory/);
    assert.match(readServicerForm({ ...form, states: "FL, ZZ" }).error ?? "", /ZZ isn't a two-letter state/);
    assert.match(readServicerForm({ ...form, website: "ftp://files.example" }).error ?? "", /website/);
    assert.match(readServicerForm({ ...form, contactEmail: "not an email" }).error ?? "", /email/);
    assert.match(readServicerForm({ ...form, importFormat: "TERRA" }).error ?? "", /export UPB reads/, "holder software isn't a servicer export");
    assert.match(readServicerForm({ ...form, name: "x" }).error ?? "", /Name the servicer/);

    // An edit names what changed. Saving the same fields again writes nothing.
    assert.ok((await saveServicer(closer, { ...form, id: row.id, monthlyFee: "$20 performing" })).ok);
    const edit = await prisma.auditEvent.findFirst({ where: { actorId: closer.id, action: "SERVICER_EDIT", entityId: row.id } });
    assert.match(edit?.detail ?? "", /monthly fee/);
    assert.ok((await saveServicer(closer, { ...form, id: row.id, monthlyFee: "$20 performing" })).ok);
    assert.equal(await prisma.auditEvent.count({ where: { action: "SERVICER_EDIT", entityId: row.id } }), 1);
    assert.deepEqual(await saveServicer(analyst, { ...form, id: row.id, monthlyFee: "$1" }), { ok: false, error: DESK_DENIED });

    // Deactivating takes it off the public list and is logged. Reactivating puts it back.
    assert.deepEqual(await setServicerActive(analyst, { id: row.id, active: false }), { ok: false, error: DESK_DENIED });
    assert.ok((await activeServicers()).some((servicer) => servicer.id === row.id));
    assert.ok((await setServicerActive(closer, { id: row.id, active: false })).ok);
    assert.ok(!(await activeServicers()).some((servicer) => servicer.id === row.id));
    assert.ok(await prisma.auditEvent.findFirst({ where: { actorId: closer.id, action: "SERVICER_DEACTIVATE", entityId: row.id } }));
    assert.ok((await setServicerActive(closer, { id: row.id, active: true })).ok);
    assert.ok(await prisma.auditEvent.findFirst({ where: { actorId: closer.id, action: "SERVICER_REACTIVATE", entityId: row.id } }));
  } finally {
    await prisma.auditEvent.deleteMany({ where: { entityType: "servicer", entityId: { in: servicerIds } } });
    await prisma.servicer.deleteMany({ where: { id: { in: servicerIds } } });
    await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
  }
});

test("each servicer action signs the caller in as the closings side before it does anything", () => {
  const source = readFileSync(path.join(process.cwd(), "actions/servicers.ts"), "utf8");
  assert.match(source, /^"use server";/);
  const exported = [...source.matchAll(/export async function (\w+)\(formData: FormData\) \{\n([^\n]*)/g)];
  assert.equal(exported.length, (source.match(/^export /gm) ?? []).length, "every export is a gated action");
  assert.ok(exported.length >= 2);
  for (const [, name, first] of exported) assert.match(first, /= await requireDesk\("closings", BACK\);/, name);
});

test("a boarding picked from the directory takes its name, links it, and warns about a state it doesn't list", async () => {
  const { tag, users, person } = await people();
  const servicerIds: string[] = [];
  const listingIds: string[] = [];
  try {
    const closer = await person("closer", "ADMIN", { deskRole: "CLOSINGS" });
    const seller = await person("seller", "INDIVIDUAL_SELLER");
    const made = await saveServicer(closer, { name: `FSearch Board ${tag}`, contactEmail: "desk@fsearch-board.example", states: "FL GA" });
    const bare = await saveServicer(closer, { name: `FSearch Bare ${tag}` });
    assert.ok(made.ok && bare.ok);
    servicerIds.push(made.value.id, bare.value.id);

    const picked = await boardingServicer({ servicerId: made.value.id, servicerName: "typed over it", contactEmail: "" });
    assert.deepEqual(picked, { error: null, servicerId: made.value.id, servicerName: `FSearch Board ${tag}`, contactEmail: "desk@fsearch-board.example" });
    // A boarding rep's own email stands over the directory's.
    assert.equal((await boardingServicer({ servicerId: made.value.id, servicerName: "", contactEmail: "rep@fsearch-board.example" })).contactEmail, "rep@fsearch-board.example");
    // Typed in, as before, with no link.
    assert.deepEqual(await boardingServicer({ servicerId: "", servicerName: "Hometown Servicing", contactEmail: "a@b.example" }), { error: null, servicerId: null, servicerName: "Hometown Servicing", contactEmail: "a@b.example" });
    assert.match((await boardingServicer({ servicerId: "c000000000000000000000000", servicerName: "", contactEmail: "" })).error ?? "", /isn't on the directory/);

    // The pick-list carries the loan states each servicer doesn't list.
    const choices = await boardingChoices(["FL", "TX"]);
    const mine = choices.find((choice) => choice.id === made.value.id);
    assert.deepEqual([mine?.missing, mine?.unlisted], [["TX"], false]);
    assert.equal(choices.find((choice) => choice.id === bare.value.id)?.unlisted, true);
    assert.deepEqual(stateGaps(["FL", "GA"], ["fl", "GA", "GA"]), { unlisted: false, missing: [] });

    // Off the directory, it can't be newly picked, but a boarding that already names it keeps it.
    assert.ok((await setServicerActive(closer, { id: made.value.id, active: false })).ok);
    assert.match((await boardingServicer({ servicerId: made.value.id, servicerName: "", contactEmail: "" })).error ?? "", /isn't on the directory/);
    assert.equal((await boardingServicer({ servicerId: made.value.id, servicerName: "", contactEmail: "", currentId: made.value.id })).servicerId, made.value.id);
    assert.ok(!(await boardingChoices(["FL"])).some((choice) => choice.id === made.value.id));
    assert.equal((await boardingChoices(["FL"], made.value.id)).find((choice) => choice.id === made.value.id)?.active, false);

    // What the boarding action saves: the link sits on the boarding row beside the name.
    const listing = await prisma.listing.create({ data: { kind: "SINGLE", sellerId: seller.id, status: "SOLD", title: `FSearch boarded ${tag}` } });
    listingIds.push(listing.id);
    const closing = await prisma.closing.create({ data: { listingId: listing.id, status: "COMPLETE", salePrice: 1, buyerPremiumCents: 0, sellerCommissionCents: 0, buyerTotalCents: 100, netToSellerCents: 100 } });
    const { servicerId, servicerName, contactEmail } = picked;
    await prisma.servicerBoarding.create({ data: { closingId: closing.id, servicerId, servicerName, contactEmail } });
    assert.equal((await prisma.servicerBoarding.findUniqueOrThrow({ where: { closingId: closing.id } })).servicerId, made.value.id);
  } finally {
    await prisma.servicerBoarding.deleteMany({ where: { closing: { listingId: { in: listingIds } } } });
    await prisma.closing.deleteMany({ where: { listingId: { in: listingIds } } });
    await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
    await prisma.auditEvent.deleteMany({ where: { entityType: "servicer", entityId: { in: servicerIds } } });
    await prisma.servicer.deleteMany({ where: { id: { in: servicerIds } } });
    await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Discount accretion.

test("constant yield accretes the whole discount by maturity, month by month on the carrying value", () => {
  const acquiredAt = utc("2025-01-15");
  const loan = { upb: 100000, annualRate: 6, monthlyPi: 1110.21, termMonths: 120 };
  const schedule = accretionSchedule({ costBasis: 80000, upb: 100000, acquiredAt, loans: [loan] });
  assert.ok(schedule);
  assert.equal(schedule.method, "constant-yield");
  assert.equal(schedule.discount, 20000);
  assert.equal(schedule.periods.length, 120);
  assert.ok(schedule.yieldPct != null && schedule.yieldPct > 6, String(schedule.yieldPct));
  assert.match(schedule.label, /^Constant yield at \d+\.\d\d% a year over 120 months/);
  // Every dollar of discount is in by the last scheduled payment, and none after it.
  const total = schedule.periods.reduce((sum, period) => sum + period.amount, 0);
  assert.equal(Math.round(total * 100) / 100, 20000);
  assert.equal(accretedThrough(schedule, addMonths(acquiredAt, 120)), 20000);
  assert.equal(accretedThrough(schedule, addMonths(acquiredAt, 600)), 20000);
  assert.ok(schedule.periods.every((period) => period.amount > 0));

  // An independent check a year in: what has accreted is the discount less the gap still open between the balance
  // and the carrying value, which is the scheduled payments left, discounted at the yield.
  const payments = projectFlows({ bid: 0, upb: 100000, annualRate: 6, monthlyPi: 1110.21, termMonths: 120 }).slice(1);
  const monthly = (1 + (schedule.yieldPct as number) / 100) ** (1 / 12) - 1;
  const carrying = payments.slice(12).reduce((sum, payment, index) => sum + payment / (1 + monthly) ** (index + 1), 0);
  let balance = 100000;
  for (const payment of payments.slice(0, 12)) balance = balance * 1.005 - payment;
  const expected = 20000 - (balance - carrying);
  assert.ok(Math.abs(accretedThrough(schedule, addMonths(acquiredAt, 12)) - expected) < 0.1, `${accretedThrough(schedule, addMonths(acquiredAt, 12))} vs ${expected}`);
  // By calendar year, adding up to the discount. An amortizing loan returns principal early, so its discount comes
  // in faster at the start than straight-line would, and slows as the balance runs off.
  const years = accretionByYear(schedule);
  assert.ok(years[1].amount > 20000 / 10 && years[1].amount > years[years.length - 2].amount, JSON.stringify(years));
  // A share of the note scales the loan to the holding.
  assert.equal(years[0].year, 2025);
  assert.equal(Math.round(years.reduce((sum, row) => sum + row.amount, 0) * 100) / 100, 20000);
  assert.equal(accretedBetween(schedule, utc("2025-01-01"), utc("2026-01-01")), years[0].amount);
  const half = accretionSchedule({ costBasis: 40000, upb: 50000, acquiredAt, loans: [loan] });
  assert.equal(half?.method, "constant-yield");
  assert.ok(Math.abs((half?.yieldPct ?? 0) - (schedule.yieldPct as number)) < 1e-6, "half the note at half the price is the same yield");
});

test("without the rate, term or payment, accretion is straight-line over a stated horizon, and none at or above par", () => {
  const acquiredAt = utc("2025-01-01");
  const assumed = accretionSchedule({ costBasis: 70000, upb: 100000, acquiredAt, loans: [{ upb: 100000, annualRate: 7, monthlyPi: 700, termMonths: null }] });
  assert.equal(assumed?.method, "straight-line");
  assert.equal(assumed?.months, ASSUMED_HORIZON_MONTHS);
  assert.equal(assumed?.assumedHorizon, true);
  assert.match(assumed?.label ?? "", /Straight-line over 60 months, an assumed horizon/);
  assert.equal(assumed?.basis, "Straight-line, 60 months assumed");
  assert.equal(assumed?.periods[0].amount, 500);
  assert.equal(accretedThrough(assumed!, utc("2030-01-01")), 30000);
  // The term is known but the payment isn't: straight-line over the months left.
  const termed = accretionSchedule({ costBasis: 70000, upb: 100000, acquiredAt, loans: [{ upb: 100000, annualRate: 7, monthlyPi: null, termMonths: 84 }] });
  assert.deepEqual([termed?.method, termed?.months, termed?.assumedHorizon], ["straight-line", 84, false]);
  assert.match(termed?.label ?? "", /left to maturity/);
  assert.equal(Math.round(termed!.periods.reduce((sum, period) => sum + period.amount, 0) * 100) / 100, 30000);
  // A note added by hand has no loan on file.
  assert.equal(accretionSchedule({ costBasis: 1, upb: 3, acquiredAt, loans: [] })?.method, "straight-line");
  assert.equal(accretionSchedule({ costBasis: 100000, upb: 100000, acquiredAt, loans: [] }), null);
  assert.equal(accretionSchedule({ costBasis: 101000, upb: 100000, acquiredAt, loans: [] }), null);
  assert.match(ACCRETION_NOTE, /for your tax adviser\. It is not tax advice/);
});

test("the year-end statement adds an accretion column for a note bought at a discount, and keeps its note", () => {
  const base: StatementHolding = {
    id: "discounted",
    title: "Discounted",
    costBasis: 70000,
    upb: 100000,
    acquiredAt: utc("2025-01-01"),
    status: "CURRENT",
    sharePercent: 100,
    underwrittenYield: 11,
    annualRate: 7,
    receipts: [],
    proceeds: [],
  };
  const accretion = accretionSchedule({ costBasis: 70000, upb: 100000, acquiredAt: base.acquiredAt, loans: [] })!;
  const statement = taxYearStatement([{ ...base, accretion }, { ...base, id: "par", costBasis: 100000, accretion: null }], 2025);
  const [discounted, par] = statement.rows;
  // Months ending February through December 2025.
  assert.equal(discounted.accreted, 5500);
  assert.equal(discounted.accretionBasis, "Straight-line, 60 months assumed");
  assert.equal(par.accreted, null);
  assert.equal(statement.totals.accreted, 5500);
  assert.equal(statement.totals.received, 0, "accretion is not a receipt");
  const csv = statementCsv(statement).split("\n");
  assert.match(csv[0], /,Split,Discount accreted,Accretion method$/);
  assert.ok(csv.some((line) => line.startsWith(ACCRETION_NOTE)));
  assert.ok(csv.at(-1)?.startsWith(`${STATEMENT_NOTE},`));
  // A sale stops it: months ending before the sale count.
  const sold = taxYearStatement([{ ...base, accretion, proceeds: [{ amount: 90000, on: utc("2025-06-15"), listingId: "R" }] }], 2025);
  assert.equal(sold.rows[0].accreted, 2500);
  // A book with nothing to accrete keeps the statement as it was.
  const plain = taxYearStatement([base], 2025);
  assert.equal("accreted" in plain.totals, false);
  assert.match(statementCsv(plain).split("\n")[0], /,Split$/);
});

// ---------------------------------------------------------------------------------------------------------------
// Search across messages, Q&A, threads and files.

const note = (tag: string) => ({
  streetAddress: `9 Quiet${tag} Way`, borrowerName: `Ann Borrower${tag}`,
  city: "Tampa", state: "FL", zip: "33601", propertyType: "SFR", occupancy: "OWNER_OCCUPIED", lienPosition: "FIRST",
  upb: 100000, interestRate: 7, monthlyPi: 700, paymentStatus: "PERFORMING", monthsDelinquent: 0, askingPrice: 80000, estimatedValue: 150000,
});

async function searchWorld() {
  const { tag, users, person } = await people();
  const word = `fsearch${tag}`;
  const seller = await person("seller", "INDIVIDUAL_SELLER");
  const buyerA = await person("buyer-a", "BUYER", pro);
  const buyerB = await person("buyer-b", "BUYER", pro);
  const outsider = await person("outsider", "BUYER", pro);
  const sales = await person("sales", "ADMIN", { deskRole: "SALES" });
  const trader = await person("trader", "ADMIN", { deskRole: "TRADER" });
  const analyst = await person("analyst", "ADMIN", { deskRole: "ANALYST" });
  const listing = (title: string, extra: Record<string, unknown> = {}) =>
    prisma.listing.create({
      data: { kind: "SINGLE", sellerId: seller.id, status: "APPROVED", approvedAt: new Date(Date.now() - 30 * DAY), title: `${word} ${title}`, notes: { create: [note(tag)] as never }, ...extra },
      include: { notes: true },
    });
  // A sealed round still open, a live room buyer A signed into, and a room nobody signed.
  const sealed = await listing("sealed", { bidMode: "SEALED", bidDeadline: new Date(Date.now() + 5 * DAY) });
  const room = await listing("room");
  const other = await listing("other");
  await prisma.ndaAcknowledgment.create({ data: { userId: buyerA.id, listingId: room.id } });
  const file = (listingId: string, name: string, extra: Record<string, unknown> = {}) =>
    prisma.document.create({ data: { listingId, type: "OTHER", originalName: name, storedName: `${word}-${crypto.randomUUID()}`, mime: "application/pdf", size: 10, ...extra } });
  const roomDoc = await file(room.id, `${word}-rent-roll.pdf`);
  const loanDoc = await file(room.id, `${word}-oe-report.pdf`, { type: "OE_REPORT", noteId: room.notes[0].id });
  const otherDoc = await file(other.id, `${word}-other-file.pdf`);
  // Two sealed bids, each with a message quoting its amount.
  const bidA = await prisma.inquiry.create({ data: { listingId: sealed.id, buyerId: buyerA.id, type: "OFFER", status: "OPEN", amount: 91234 } });
  const bidB = await prisma.inquiry.create({ data: { listingId: sealed.id, buyerId: buyerB.id, type: "OFFER", status: "OPEN", amount: 87654 } });
  const askB = await prisma.inquiry.create({ data: { listingId: room.id, buyerId: buyerB.id, type: "INFO_REQUEST", status: "OPEN" } });
  const msgA = await prisma.offerMessage.create({ data: { inquiryId: bidA.id, authorId: buyerA.id, kind: "OFFER", amount: 91234, body: `${word} my bid stands at 91,234` } });
  const msgB = await prisma.offerMessage.create({ data: { inquiryId: bidB.id, authorId: buyerB.id, kind: "OFFER", amount: 87654, body: `${word} buyer b offers 87,654` } });
  // Room Q&A: one published, buyer A's own open question, and buyer B's.
  const published = await prisma.listingQuestion.create({ data: { listingId: room.id, askerId: buyerB.id, question: `${word} is the escrow current?`, answer: "Yes, current through October.", status: "ANSWERED", answeredAt: new Date() } });
  const mineOpen = await prisma.listingQuestion.create({ data: { listingId: room.id, askerId: buyerA.id, question: `${word} what does the pay history show?` } });
  const theirsOpen = await prisma.listingQuestion.create({ data: { listingId: room.id, askerId: buyerB.id, question: `${word} buyer b's own question` } });
  // Buyer A's bid thread, with a seller seat left from before the sealed round and two desk seats. Buyer B's own thread.
  const bidThread = await prisma.deskThread.create({
    data: {
      subject: `Offer · ${word} sealed`, listingId: sealed.id, inquiryId: bidA.id,
      members: { create: [buyerA, seller, trader, sales].map((user) => ({ userId: user.id })) },
      posts: { create: { authorId: buyerA.id, body: `${word} about my 91,234 bid` } },
    },
    include: { posts: true },
  });
  const askThread = await prisma.deskThread.create({
    data: { subject: `Inquiry · ${word} room`, listingId: room.id, inquiryId: askB.id, members: { create: [{ userId: buyerB.id }] }, posts: { create: { authorId: buyerB.id, body: `${word} buyer b thread` } } },
    include: { posts: true },
  });
  return {
    tag, word, users, seller, buyerA, buyerB, outsider, sales, trader, analyst,
    sealed, room, other, roomDoc, loanDoc, otherDoc, bidA, bidB, msgA, msgB, published, mineOpen, theirsOpen, bidThread, askThread,
    listingIds: [sealed.id, room.id, other.id],
    threadIds: [bidThread.id, askThread.id],
  };
}

type SearchWorld = Awaited<ReturnType<typeof searchWorld>>;

async function cleanSearch(world: SearchWorld) {
  await prisma.threadPost.deleteMany({ where: { threadId: { in: world.threadIds } } });
  await prisma.threadMember.deleteMany({ where: { threadId: { in: world.threadIds } } });
  await prisma.deskThread.deleteMany({ where: { id: { in: world.threadIds } } });
  await prisma.listingQuestion.deleteMany({ where: { listingId: { in: world.listingIds } } });
  await prisma.offerMessage.deleteMany({ where: { inquiry: { listingId: { in: world.listingIds } } } });
  await prisma.inquiry.deleteMany({ where: { listingId: { in: world.listingIds } } });
  await prisma.document.deleteMany({ where: { listingId: { in: world.listingIds } } });
  await prisma.ndaAcknowledgment.deleteMany({ where: { listingId: { in: world.listingIds } } });
  await prisma.listingView.deleteMany({ where: { listingId: { in: world.listingIds } } });
  await prisma.note.deleteMany({ where: { listingId: { in: world.listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: world.listingIds } } });
  await prisma.user.deleteMany({ where: { id: { in: world.users.map((user) => user.id) } } });
}

const search = (viewer: SearchWorld["buyerA"], term: string) => searchCommands(viewer, term, { settings: SETTINGS });
const ids = (items: CommandItem[], group?: string) => new Set(items.filter((item) => !group || item.group === group).map((item) => item.id));

test("a buyer finds their own messages, room Q&A, threads and files, linked to the right place", async () => {
  const world = await searchWorld();
  try {
    const found = await search(world.buyerA, world.word);
    const item = (id: string) => found.find((row) => row.id === id);
    assert.equal(item(`message:${world.msgA.id}`)?.href, `/buyer/offers#inquiry-${world.bidA.id}`);
    assert.equal(item(`message:${world.msgA.id}`)?.group, "Messages");
    assert.equal(item(`question:${world.published.id}`)?.href, `/marketplace/${world.room.id}?tab=room#questions`);
    assert.match(item(`question:${world.mineOpen.id}`)?.hint ?? "", /^Your question · Waiting for an answer/);
    assert.equal(item(`post:${world.bidThread.posts[0].id}`)?.href, `/inbox/${world.bidThread.id}#post-${world.bidThread.posts[0].id}`);
    assert.equal(item(`file:${world.roomDoc.id}`)?.href, `/marketplace/${world.room.id}?tab=room#room-heading`);
    assert.equal(item(`file:${world.loanDoc.id}`)?.href, `/marketplace/${world.room.id}?loan=${world.room.notes[0].id}&tab=file#loan-file`);
    // Message, question, post and file text is never kept as a recent item.
    assert.ok(found.filter((row) => ["Messages", "Questions", "Threads", "Files"].includes(row.group)).every((row) => row.private === true));
    // Nothing of buyer B's, and no file from a room buyer A never signed into.
    for (const id of [`message:${world.msgB.id}`, `question:${world.theirsOpen.id}`, `post:${world.askThread.posts[0].id}`, `file:${world.otherDoc.id}`]) assert.ok(!item(id), id);
    assert.doesNotMatch(JSON.stringify(found), /87,654|87654/);
    // The amount itself finds only buyer A's own words.
    assert.deepEqual([...ids(await search(world.buyerA, "87,654"))], []);
  } finally {
    await cleanSearch(world);
  }
});

test("search never shows another buyer's bid, an answer outside the room, or a file the route would refuse", async () => {
  const world = await searchWorld();
  try {
    const other = await search(world.buyerB, world.word);
    assert.ok(ids(other, "Messages").has(`message:${world.msgB.id}`), "their own message");
    assert.ok(!ids(other).has(`message:${world.msgA.id}`));
    assert.ok(!ids(other).has(`post:${world.bidThread.posts[0].id}`));
    assert.ok(ids(other, "Questions").has(`question:${world.theirsOpen.id}`), "their own open question");
    assert.ok(!ids(other).has(`question:${world.mineOpen.id}`));
    assert.equal(ids(other, "Files").size, 0, "no NDA, no file names");
    assert.doesNotMatch(JSON.stringify(other), /91,234|91234/);
    assert.deepEqual(await search(world.buyerB, "91,234"), []);

    // A Pro buyer who never signed finds no published answer and no file, though the listings open to them.
    const outside = await search(world.outsider, world.word);
    assert.ok(ids(outside, "Listings").has(`listing:${world.room.id}`));
    for (const group of ["Messages", "Questions", "Threads", "Files"]) assert.equal(ids(outside, group).size, 0, group);

    // The seller finds every question and file on their own listings, from their own pages. Bid messages stay on the
    // listing page, and a sealed bid's thread is closed to them though an old seat remains.
    const mine = await search(world.seller, world.word);
    assert.equal(mine.find((row) => row.id === `question:${world.theirsOpen.id}`)?.href, `/seller/listings/${world.room.id}#questions`);
    assert.equal(mine.find((row) => row.id === `file:${world.otherDoc.id}`)?.href, `/seller/listings/${world.other.id}#documents`);
    assert.equal(ids(mine, "Messages").size, 0);
    assert.ok(!ids(mine).has(`post:${world.bidThread.posts[0].id}`));
    assert.doesNotMatch(JSON.stringify(mine), /91,234|87,654/);
  } finally {
    await cleanSearch(world);
  }
});

test("the desk reads bid messages and threads only within the sealed-bid wall", async () => {
  const world = await searchWorld();
  try {
    const sales = await search(world.sales, world.word);
    assert.equal(sales.find((row) => row.id === `message:${world.msgA.id}`)?.href, `/admin/offers#offer-${world.bidA.id}`);
    assert.ok(ids(sales, "Messages").has(`message:${world.msgB.id}`));
    assert.ok(ids(sales, "Threads").has(`post:${world.bidThread.posts[0].id}`));
    assert.equal(sales.find((row) => row.id === `file:${world.roomDoc.id}`)?.href, `/admin/listings/${world.room.id}#documents`);
    assert.equal(sales.find((row) => row.id === `question:${world.published.id}`)?.href, `/admin/listings/${world.room.id}#questions`);
    // Not a member of buyer B's thread, so its post doesn't show.
    assert.ok(!ids(sales).has(`post:${world.askThread.posts[0].id}`));

    // The desk book's trader and a read-only seat are behind the wall until the deadline.
    for (const viewer of [world.trader, world.analyst]) {
      const walled = await search(viewer, world.word);
      assert.equal(ids(walled, "Messages").size, 0, viewer.email);
      assert.ok(!ids(walled).has(`post:${world.bidThread.posts[0].id}`), viewer.email);
      assert.doesNotMatch(JSON.stringify(walled), /91,234|87,654/, viewer.email);
      assert.ok(ids(walled, "Questions").has(`question:${world.published.id}`), "Q&A isn't behind the wall");
    }
    // Past the deadline the read-only seat reads the bids. The trader stays out while the listing is on the market.
    await prisma.listing.update({ where: { id: world.sealed.id }, data: { bidDeadline: new Date(Date.now() - DAY) } });
    assert.ok(ids(await search(world.analyst, world.word), "Messages").has(`message:${world.msgA.id}`));
    assert.equal(ids(await search(world.trader, world.word), "Messages").size, 0);
  } finally {
    await cleanSearch(world);
  }
});
