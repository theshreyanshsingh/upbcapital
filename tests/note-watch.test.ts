import assert from "node:assert/strict";
import test from "node:test";
import { navFor } from "../components/desk-nav";
import { navPages } from "../lib/command-search";
import { literal } from "../lib/db-filters";
import { mailParts } from "../lib/email";
import {
  addWatchedNote,
  changeText,
  demandText,
  editWatchedNote,
  FEWER_LINE,
  LIMIT_TEXT,
  linkWatchedListings,
  MAX_WATCHED,
  noteWatchEmail,
  readWatchForm,
  sendNoteWatch,
  setWatchAlerts,
  watchFromValuation,
  watchedNotes,
  wizardDraft,
} from "../lib/note-watch";
import { prisma } from "../lib/prisma";
import { applyMailings, applyUnsubscribe, mailingsFor, readUnsubscribeToken, unsubscribeToken } from "../lib/unsubscribe";
import { requestValuation } from "../lib/valuations";

// Unsubscribe tokens are signed with the auth secret. Mail stays in the log, whatever the local .env carries.
process.env.AUTH_SECRET = "note-watch-test-secret-not-for-production-01";
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL", "OFAC_SDN_URL", "OFAC_API_URL", "OFAC_API_KEY"]) process.env[key] = "";
globalThis.fetch = (async (input: unknown) => {
  throw new Error(`A test tried to reach the network: ${String(input)}`);
}) as typeof fetch;

test.after(async () => {
  await prisma.$disconnect();
});

const DAY = 24 * 60 * 60 * 1000;

function tagOf() {
  return `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
}

const person = (tag: string, who: string, data: Record<string, unknown>) =>
  prisma.user.create({ data: { email: `watch-${tag}-${who}@example.org`, name: `${who} ${tag}`, accountStatus: "APPROVED", passwordHash: "x", ...data } as never });

const FORM = {
  label: "Maple Street note",
  state: "FL",
  propertyType: "SFR",
  lienPosition: "FIRST",
  paymentStatus: "PERFORMING",
  upb: "150000",
  interestRate: "7",
  monthlyPi: "1100",
  estimatedValue: "240000",
  originationDate: "2021-03-01",
  maturityDate: "2051-03-01",
  occupancy: "",
  seniorLienBalance: "",
  loanProgram: "",
};

// A tracked note written straight to the database, with a reading as old as asked.
const tracked = (userId: string, label: string, data: Record<string, unknown> = {}) =>
  prisma.trackedNote.create({
    data: { userId, label, state: "FL", propertyType: "SFR", lienPosition: "FIRST", paymentStatus: "PERFORMING", upb: 150000, interestRate: 7, monthlyPi: 1100, estimatedValue: 240000, ...data } as never,
  });

const loan = (street: string, extra: Record<string, unknown> = {}) => ({
  streetAddress: street, city: "Tampa", state: "FL", zip: "33601", propertyType: "SFR", occupancy: "OWNER_OCCUPIED",
  lienPosition: "FIRST", upb: 150000, interestRate: 7, monthlyPi: 1100, paymentStatus: "PERFORMING", monthsDelinquent: 0,
  askingPrice: 120000, estimatedValue: 240000, ...extra,
});

async function cleanUp(tag: string, userIds: string[]) {
  const emails = (await prisma.user.findMany({ where: { id: { in: userIds } }, select: { email: true } })).map((row) => row.email);
  const notes = await prisma.trackedNote.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
  const listings = await prisma.listing.findMany({ where: { sellerId: { in: userIds } }, select: { id: true } });
  const requests = await prisma.valuationRequest.findMany({ where: { email: { contains: literal(tag) } }, select: { id: true } });
  const entityIds = [...userIds, ...notes.map((row) => row.id), ...listings.map((row) => row.id), ...requests.map((row) => row.id)];
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: entityIds } }, { actorId: { in: userIds } }] } });
  await prisma.trackedNote.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.reviewComment.deleteMany({ where: { listingId: { in: listings.map((row) => row.id) } } });
  await prisma.listing.deleteMany({ where: { id: { in: listings.map((row) => row.id) } } });
  await prisma.valuationRequest.deleteMany({ where: { id: { in: requests.map((row) => row.id) } } });
  await prisma.buyBox.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: emails } }, { subject: { contains: literal(tag) } }] } });
  await prisma.rateWindow.deleteMany({ where: { key: { contains: literal(tag) } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

// ---------------------------------------------------------------------------------------------------------------

test("the short form takes the wizard's options and checks, and a label only the holder sees", () => {
  const ok = readWatchForm({ ...FORM, state: "fl" });
  assert.equal(ok.error, null);
  assert.equal(ok.data?.state, "FL");
  assert.equal(ok.data?.originationDate?.toISOString().slice(0, 10), "2021-03-01");
  assert.equal(ok.data?.occupancy, null);
  assert.equal(ok.data?.loanProgram, null);
  // The label is one line, since it can head the email.
  assert.equal(readWatchForm({ ...FORM, label: " Maple\r\nStreet " }).data?.label, "Maple Street");
  const cases: [Record<string, string>, string][] = [
    [{ label: " " }, "Give the note a label. Only you see it."],
    [{ label: "\n\t" }, "Give the note a label. Only you see it."],
    [{ label: "x".repeat(81) }, "Keep the label under 80 characters."],
    [{ state: "ZZ" }, "Use a two-letter state."],
    [{ upb: "" }, "UPB must be greater than zero."],
    [{ interestRate: "" }, "Enter a note rate between 0 and 40."],
    [{ interestRate: "41" }, "Enter a note rate between 0 and 40."],
    [{ monthlyPi: "" }, "Enter monthly principal and interest."],
    [{ estimatedValue: "0" }, "Estimated value must be greater than zero."],
    [{ seniorLienBalance: "-5", lienPosition: "SECOND" }, "The senior lien balance can't be below zero."],
    [{ loanProgram: "CRYPTO" }, "Choose the loan program."],
  ];
  for (const [change, message] of cases) assert.equal(readWatchForm({ ...FORM, ...change }).error, message, JSON.stringify(change));
  // A first lien keeps no senior balance; a second keeps the one typed.
  assert.equal(readWatchForm({ ...FORM, seniorLienBalance: "50000" }).data?.seniorLienBalance, null);
  assert.equal(readWatchForm({ ...FORM, lienPosition: "SECOND", seniorLienBalance: "50000" }).data?.seniorLienBalance, 50000);
});

test("sellers find Note watch in the nav and the command palette, and nobody else does", () => {
  const nav = (role: string) => navFor({ role, name: "", email: "", tier: "", unread: 0 }).map((item) => item.href);
  for (const role of ["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER"]) {
    assert.ok(nav(role).includes("/seller/watch"), role);
    assert.ok(navPages(role).some((page) => page.href === "/seller/watch" && page.label === "Note watch"), role);
  }
  for (const role of ["BUYER", "BROKER", "ADMIN"]) assert.ok(!nav(role).includes("/seller/watch") && !navPages(role).some((page) => page.href === "/seller/watch"), role);
});

test("a seller adds a note, it is read at once, and a holder keeps at most 25", async () => {
  const tag = tagOf();
  const users: string[] = [];
  try {
    const seller = await person(tag, "seller", { role: "INDIVIDUAL_SELLER" });
    const buyer = await person(tag, "buyer", { role: "BUYER" });
    users.push(seller.id, buyer.id);
    assert.equal((await addWatchedNote(buyer, FORM, { buyerIds: [] })).error, "Note watch is for seller accounts.");
    assert.equal((await addWatchedNote(seller, { ...FORM, upb: "0" }, { buyerIds: [] })).error, "UPB must be greater than zero.");

    const added = await addWatchedNote(seller, FORM, { buyerIds: [] });
    assert.equal(added.error, null);
    const note = await prisma.trackedNote.findUniqueOrThrow({ where: { id: added.id! } });
    assert.equal(note.label, "Maple Street note");
    assert.equal(note.alertsOn, true);
    assert.ok(note.lastValuedAt && note.lastLow != null && note.lastHigh != null);
    assert.equal(note.prevValuedAt ?? null, null);
    // The label and figures stay out of the audit log.
    const logged = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: note.id, action: "NOTE_WATCH_ADDED" } });
    assert.equal(logged.detail, "");

    // 24 more fill the watch; the 26th is refused.
    for (let index = 0; index < MAX_WATCHED - 2; index += 1) await tracked(seller.id, `Filler ${index}`);
    assert.equal((await addWatchedNote(seller, { ...FORM, label: "Twenty-fifth" }, { buyerIds: [] })).error, null);
    assert.equal(await prisma.trackedNote.count({ where: { userId: seller.id } }), MAX_WATCHED);
    assert.equal((await addWatchedNote(seller, { ...FORM, label: "Twenty-sixth" }, { buyerIds: [] })).error, LIMIT_TEXT);
    assert.equal(await prisma.trackedNote.count({ where: { userId: seller.id } }), MAX_WATCHED);
    // Another holder's note can't be edited, stopped or seen.
    const other = await person(tag, "other", { role: "INSTITUTIONAL_SELLER" });
    users.push(other.id);
    assert.equal((await editWatchedNote(other, note.id, FORM, { buyerIds: [] })).error, "That note isn't on your watch.");
    assert.equal((await setWatchAlerts(other, note.id, false)).error, "That note isn't on your watch.");
    assert.equal((await watchedNotes(other.id)).length, 0);
  } finally {
    await cleanUp(tag, users);
  }
});

test("a reading sets the range and counts distinct buyer firms whose boxes fit, never exactly under three", async () => {
  const tag = tagOf();
  const users: string[] = [];
  try {
    const seller = await person(tag, "seller", { role: "INDIVIDUAL_SELLER" });
    const firms = await Promise.all([1, 2, 3].map((n) => person(tag, `firm${n}`, { role: "BUYER" })));
    // A firm's seat acts for the firm, so its box doesn't count again. A buyer still in review doesn't count.
    const seat = await person(tag, "seat", { role: "BUYER", principalId: firms[0].id });
    const pending = await person(tag, "pending", { role: "BUYER", accountStatus: "PENDING" });
    users.push(seller.id, ...firms.map((firm) => firm.id), seat.id, pending.id);
    const box = { states: "FL", liens: "FIRST", statuses: "PERFORMING" };
    await prisma.buyBox.createMany({
      data: [
        ...firms.map((firm) => ({ userId: firm.id, name: `Florida ${tag}`, ...box })),
        { userId: seat.id, name: `Seat ${tag}`, ...box },
        { userId: pending.id, name: `Pending ${tag}`, ...box },
        { userId: firms[1].id, name: `Texas ${tag}`, states: "TX", liens: "FIRST", statuses: "PERFORMING" },
        { userId: firms[2].id, name: `Paused ${tag}`, states: "TX", liens: "FIRST", statuses: "PERFORMING", active: false },
      ],
    });
    const buyerIds = [...firms.map((firm) => firm.id), seat.id, pending.id];

    const added = await addWatchedNote(seller, FORM, { buyerIds });
    assert.equal(added.error, null);
    const first = await prisma.trackedNote.findUniqueOrThrow({ where: { id: added.id! } });
    assert.ok(first.lastLow! > 0 && first.lastHigh! >= first.lastLow!);
    assert.equal(first.lastDemand, 3);
    assert.equal(demandText(first.lastDemand), "3 buyers");
    assert.equal(changeText(first), null);

    // Moved to Texas: one firm's box fits, which shows as fewer than three, before and after.
    assert.equal((await editWatchedNote(seller, first.id, { ...FORM, state: "TX" }, { buyerIds })).error, null);
    const moved = await prisma.trackedNote.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(moved.lastDemand, 1);
    assert.equal(demandText(moved.lastDemand), FEWER_LINE);
    assert.equal(moved.prevDemand, 3);
    assert.equal(moved.prevLow, first.lastLow);
    assert.equal(moved.prevValuedAt?.getTime(), first.lastValuedAt?.getTime());
    const change = changeText(moved)!;
    assert.match(change, /buyers down from 3 to fewer than 3/);
    assert.doesNotMatch(change, /\b1\b buyer|to 1\b/);
    const email = noteWatchEmail([moved], "https://upb.example");
    assert.match(email.body, /Fewer than 3 buyers whose boxes fit it/);
    assert.doesNotMatch(email.body, /\b1 buyers?\b/);
    assert.ok(email.body.includes(change), "the email says what the page says");

    // A new label alone keeps the month's change; it doesn't read the note again.
    assert.equal((await editWatchedNote(seller, first.id, { ...FORM, state: "TX", label: "Renamed" }, { buyerIds })).error, null);
    const renamed = await prisma.trackedNote.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(renamed.label, "Renamed");
    assert.equal(renamed.lastValuedAt?.getTime(), moved.lastValuedAt?.getTime());

    // Two counts under three say only that, whichever way they moved.
    const base = { lastLow: 100, lastHigh: 120, prevLow: 100, prevHigh: 120, prevValuedAt: new Date("2026-10-01T00:00:00Z"), lastValuedAt: new Date() };
    assert.match(changeText({ ...base, prevDemand: 1, lastDemand: 2 })!, /still fewer than 3 buyers/);
    assert.match(changeText({ ...base, prevDemand: 0, lastDemand: 4 })!, /buyers up from fewer than 3 to 4/);
    assert.match(changeText({ ...base, prevDemand: 4, lastDemand: 6, lastLow: 110, lastHigh: 130 })!, /the range is up from \$100–\$120; buyers up from 4 to 6/);
    assert.equal(demandText(0), FEWER_LINE);
    assert.equal(demandText(2), FEWER_LINE);
    assert.equal(demandText(null), "Not read yet");
  } finally {
    await cleanUp(tag, users);
  }
});

test("the monthly job reads a holder's notes together once any is stale, sends one email, and does nothing the second time", async () => {
  const tag = tagOf();
  const users: string[] = [];
  const now = new Date();
  const old = new Date(now.getTime() - 40 * DAY);
  const recent = new Date(now.getTime() - 5 * DAY);
  try {
    const alice = await person(tag, "alice", { role: "INDIVIDUAL_SELLER" });
    const bob = await person(tag, "bob", { role: "INSTITUTIONAL_SELLER" });
    const suspended = await person(tag, "suspended", { role: "INDIVIDUAL_SELLER", accountStatus: "SUSPENDED" });
    const quiet = await person(tag, "quiet", { role: "INDIVIDUAL_SELLER" });
    users.push(alice.id, bob.id, suspended.id, quiet.id);
    const reading = { lastLow: 90000, lastHigh: 100000, lastDemand: 4, lastValuedAt: old };
    const stale = await tracked(alice.id, `Alice stale ${tag}`, reading);
    const fresh = await tracked(alice.id, `Alice fresh ${tag}`, { ...reading, lastValuedAt: recent });
    // Never read, as when the reading at add failed: due at once.
    const unread = await tracked(bob.id, `Bob unread ${tag}`);
    const barred = await tracked(suspended.id, `Suspended ${tag}`, reading);
    const stopped = await tracked(quiet.id, `Stopped ${tag}`, { ...reading, alertsOn: false });
    const scope = { userIds: users, buyerIds: [] as string[] };

    const run = await sendNoteWatch(now, scope);
    assert.deepEqual(run, { sent: 2, failed: 0, error: "" });

    const reread = await prisma.trackedNote.findUniqueOrThrow({ where: { id: stale.id } });
    assert.equal(reread.lastValuedAt?.getTime(), now.getTime());
    assert.equal(reread.prevLow, 90000);
    assert.equal(reread.prevDemand, 4);
    assert.equal(reread.prevValuedAt?.getTime(), old.getTime());
    assert.equal(reread.lastDemand, 0);
    // Alice's fresher note is read with her stale one, so her notes share a date and she gets one email a month.
    const together = await prisma.trackedNote.findUniqueOrThrow({ where: { id: fresh.id } });
    assert.equal(together.lastValuedAt?.getTime(), now.getTime());
    assert.equal(together.prevValuedAt?.getTime(), recent.getTime());
    assert.ok((await prisma.trackedNote.findUniqueOrThrow({ where: { id: unread.id } })).lastValuedAt);
    for (const id of [barred.id, stopped.id]) assert.equal((await prisma.trackedNote.findUniqueOrThrow({ where: { id } })).lastValuedAt?.getTime(), old.getTime());

    // One email to each holder, covering every note they watch, with what changed as the page shows it.
    const aliceMail = await prisma.notification.findMany({ where: { toEmail: alice.email } });
    assert.equal(aliceMail.length, 1);
    assert.equal(aliceMail[0].subject, "Note watch · 2 notes");
    assert.ok(aliceMail[0].body.includes(`Alice stale ${tag}`) && aliceMail[0].body.includes(`Alice fresh ${tag}`));
    assert.ok(aliceMail[0].body.includes(changeText(reread)!));
    assert.ok(aliceMail[0].body.includes(`/seller/watch/${stale.id}/list`));
    assert.match(aliceMail[0].body, /Fewer than 3 buyers/);
    const bobMail = await prisma.notification.findMany({ where: { toEmail: bob.email } });
    assert.equal(bobMail.length, 1);
    assert.equal(bobMail[0].subject, `Note watch · Bob unread ${tag}`);
    assert.match(bobMail[0].body, /First reading/);
    assert.equal(await prisma.notification.count({ where: { toEmail: { in: [suspended.email, quiet.email] } } }), 0);

    // The second run finds nothing due.
    assert.deepEqual(await sendNoteWatch(now, scope), { sent: 0, failed: 0, error: "" });
    assert.equal(await prisma.notification.count({ where: { toEmail: { in: [alice.email, bob.email] } } }), 2);
  } finally {
    await cleanUp(tag, users);
  }
});

test("the signed stop link turns note watch alerts off, and the preference page turns them back on", async () => {
  const tag = tagOf();
  const users: string[] = [];
  try {
    const seller = await person(tag, "seller", { role: "INDIVIDUAL_SELLER" });
    users.push(seller.id);
    const one = await tracked(seller.id, "One");
    const two = await tracked(seller.id, "Two");

    // The email carries the stop link and the one-click header.
    const parts = mailParts("body", { category: "notewatch", userId: seller.id });
    assert.match(parts.text, /To stop the monthly note watch email, open .*\/unsubscribe\?token=/);
    assert.match(parts.headers["List-Unsubscribe"] ?? "", /\/unsubscribe\/one-click\?token=/);

    // The preference page lists it for a holder with notes on watch.
    assert.deepEqual((await mailingsFor(seller.email)).find((row) => row.key === "notewatch"), { key: "notewatch", label: "Note watch", on: true });

    const token = unsubscribeToken({ category: "notewatch", userId: seller.id });
    const found = readUnsubscribeToken(token);
    assert.deepEqual(found, { userId: seller.id, category: "notewatch", searchId: null });
    // An edited link turns nothing off.
    assert.equal(readUnsubscribeToken(`${token}x`), null);
    await applyUnsubscribe(found!);
    for (const id of [one.id, two.id]) assert.equal((await prisma.trackedNote.findUniqueOrThrow({ where: { id } })).alertsOn, false);
    assert.ok((await mailingsFor(seller.email)).some((row) => row.key === "notewatch" && !row.on));

    assert.deepEqual(await applyMailings(seller.email, { notewatch: true }), ["notewatch"]);
    for (const id of [one.id, two.id]) assert.equal((await prisma.trackedNote.findUniqueOrThrow({ where: { id } })).alertsOn, true);

    // Stop alerts on one note leaves the other.
    assert.equal((await setWatchAlerts(seller, one.id, false)).error, null);
    assert.equal((await prisma.trackedNote.findUniqueOrThrow({ where: { id: one.id } })).alertsOn, false);
    assert.equal((await prisma.trackedNote.findUniqueOrThrow({ where: { id: two.id } })).alertsOn, true);
  } finally {
    await cleanUp(tag, users);
  }
});

test("a listing filed from the watched note links it, and the job then leaves it alone", async () => {
  const tag = tagOf();
  const users: string[] = [];
  try {
    const seller = await person(tag, "seller", { role: "INDIVIDUAL_SELLER" });
    users.push(seller.id);
    // A listing filed before the note went on watch never links it.
    await prisma.listing.create({ data: { kind: "SINGLE", sellerId: seller.id, status: "SUBMITTED", title: `Before ${tag}`, createdAt: new Date(Date.now() - DAY), notes: { create: [loan("1 Early Row")] as never } } as never });
    const note = await tracked(seller.id, "Watched", { originationDate: new Date("2021-03-01T00:00:00Z"), lastValuedAt: new Date(Date.now() - 40 * DAY), lastLow: 90000, lastHigh: 100000 });

    // "List it" prefills the wizard from the note, with the ask left to the holder.
    const draft = wizardDraft(note);
    assert.equal(draft.state, "FL");
    assert.equal(draft.upb, "150000");
    assert.equal(draft.originationDate, "2021-03-01");
    assert.equal("askingPrice" in draft, false);

    await prisma.listing.create({ data: { kind: "SINGLE", sellerId: seller.id, status: "SUBMITTED", title: `Other ${tag}`, notes: { create: [loan("2 Other Row", { upb: 99000 })] as never } } });
    assert.equal(await linkWatchedListings({ userIds: [seller.id] }), 0);
    const listing = await prisma.listing.create({ data: { kind: "SINGLE", sellerId: seller.id, status: "SUBMITTED", title: `From watch ${tag}`, notes: { create: [loan("3 Maple Row")] as never } } });
    const [shown] = await watchedNotes(seller.id);
    assert.equal(shown.listingId, listing.id);
    assert.ok(await prisma.auditEvent.findFirst({ where: { entityId: note.id, action: "NOTE_WATCH_LISTED" } }));
    assert.equal(await linkWatchedListings({ userIds: [seller.id] }), 0);
    // Listed, it is out of the monthly email and can't be edited here.
    assert.deepEqual(await sendNoteWatch(new Date(), { userIds: [seller.id], buyerIds: [] }), { sent: 0, failed: 0, error: "" });
    assert.equal((await editWatchedNote(seller, note.id, FORM, { buyerIds: [] })).error, "This note is listed. Change the listing instead.");
  } finally {
    await cleanUp(tag, users);
  }
});

test("keep watching from a Value my loans result joins only the account with the request's own email", async () => {
  const tag = tagOf();
  const users: string[] = [];
  const email = `watch-${tag}-valuer@example.org`;
  const typed = { state: "GA", lienPosition: "SECOND", paymentStatus: "PERFORMING", upb: "90000", interestRate: "8", monthlyPi: "760", estimatedValue: "160000" };
  const ask = async (loans: (typeof typed)[]) => {
    const made = await requestValuation({ name: `Valuer ${tag}`, email, company: `Holdings ${tag}`, terms: "yes", typed: loans, ipAddress: `ip-${tag}`, screen: () => undefined, store: async () => undefined });
    if (made.error !== null) throw new Error(made.error);
    return made.id;
  };
  try {
    const id = await ask([typed]);
    const pool = await ask([typed, { ...typed, upb: "50000" }]);
    const stranger = await person(tag, "stranger", { role: "INDIVIDUAL_SELLER" });
    users.push(stranger.id);
    const refused = "This valuation can't join this account. Note watch takes a single-loan valuation sent from the account's own email.";
    assert.equal((await watchFromValuation(stranger, { valuationId: id, label: "" }, { buyerIds: [] })).error, refused);
    assert.equal(await prisma.trackedNote.count({ where: { userId: stranger.id } }), 0);

    // A buyer with the address is not a holder here.
    const buyer = await prisma.user.create({ data: { email, name: `Valuer ${tag}`, role: "BUYER", accountStatus: "APPROVED", passwordHash: "x" } });
    users.push(buyer.id);
    assert.equal((await watchFromValuation(buyer, { valuationId: id, label: "" }, { buyerIds: [] })).error, "Sign in with a seller account to watch a note.");
    await prisma.user.delete({ where: { id: buyer.id } });
    users.pop();

    // The seller with the request's email, however typed, gets the loan on watch, with a label made from it.
    const seller = await prisma.user.create({ data: { email, name: `Valuer ${tag}`, role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" } });
    users.push(seller.id);
    assert.equal((await watchFromValuation({ ...seller, email: ` ${email.toUpperCase()}` }, { valuationId: pool, label: "" }, { buyerIds: [] })).error, refused);
    const made = await watchFromValuation({ ...seller, email: ` ${email.toUpperCase()}` }, { valuationId: id, label: "" }, { buyerIds: [] });
    assert.equal(made.error, null);
    const note = await prisma.trackedNote.findUniqueOrThrow({ where: { id: made.id! } });
    assert.deepEqual([note.userId, note.label, note.state, note.lienPosition, note.upb, note.propertyType ?? null], [seller.id, "Second lien in GA, $90,000", "GA", "SECOND", 90000, null]);
    assert.ok(note.lastValuedAt);
    // Pressed again, it is the same note.
    const again = await watchFromValuation(seller, { valuationId: id, label: "" }, { buyerIds: [] });
    assert.deepEqual([again.id, again.already], [note.id, true]);

    // A request already on another account never joins this one, even from the same address.
    await prisma.valuationRequest.update({ where: { id }, data: { userId: stranger.id } });
    await prisma.trackedNote.deleteMany({ where: { id: note.id } });
    assert.equal((await watchFromValuation(seller, { valuationId: id, label: "" }, { buyerIds: [] })).error, refused);
  } finally {
    await cleanUp(tag, users);
  }
});
