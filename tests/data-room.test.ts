import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { canManageRoom, ndaOpensRoom } from "../lib/acl";
import { accessLog, accessLogCsv, ACCESS_LOG_COLUMNS } from "../lib/access-log";
import { aliasAt, bidderAliases, bidderNamer, orderBidders, threadNamer } from "../lib/bidder-alias";
import { literal } from "../lib/db-filters";
import { prisma } from "../lib/prisma";
import { answerQuestion, askQuestion, declineQuestion, publishedQuestions, questionsAskedBy } from "../lib/questions";
import { decideRoomAccess, documentGate, ndaOnSign, roomRequests, setRoomApproval } from "../lib/room-access";
import { addPoolFiles } from "../lib/room-files";
import { uploadDir } from "../lib/storage";
import { bidderCopy, isPdf, watermarkLine, watermarkPdf } from "../lib/watermark";

// Files go to local disk, mail to the log, and rate limits to memory, whatever the shared .env says.
for (const key of ["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL"]) process.env[key] = "";
process.env.RATE_LIMIT_STORE = "memory";

const DAY = 24 * 60 * 60 * 1000;

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// Pure rules.

test("bidder letters run A to Z and on to AA, in order of each buyer's first event, and skip the seller", () => {
  assert.equal(aliasAt(0), "Bidder A");
  assert.equal(aliasAt(25), "Bidder Z");
  assert.equal(aliasAt(26), "Bidder AA");
  assert.equal(aliasAt(27), "Bidder AB");
  const at = (day: number) => new Date(Date.UTC(2026, 10, day));
  const order = orderBidders(
    [
      { userId: "late", at: at(9) },
      { userId: "seller", at: at(1) },
      { userId: "early", at: at(5) },
      // A later event doesn't move a buyer back.
      { userId: "early", at: at(10) },
      { userId: "late", at: at(4) },
      { userId: "tie-b", at: at(7) },
      { userId: "tie-a", at: at(7) },
    ],
    ["seller"],
  );
  assert.deepEqual([...order.entries()], [["late", "Bidder A"], ["early", "Bidder B"], ["tie-a", "Bidder C"], ["tie-b", "Bidder D"]]);
});

test("an NDA with no access status opens the room, a waiting or declined one doesn't, and a new one waits only where the seller approves", () => {
  assert.equal(ndaOpensRoom(null), false);
  assert.equal(ndaOpensRoom({}), true);
  assert.equal(ndaOpensRoom({ accessStatus: null }), true);
  assert.equal(ndaOpensRoom({ accessStatus: "APPROVED" }), true);
  assert.equal(ndaOpensRoom({ accessStatus: "PENDING" }), false);
  assert.equal(ndaOpensRoom({ accessStatus: "DECLINED" }), false);
  assert.deepEqual(ndaOnSign({ roomApproval: true }, null), { block: null, create: "PENDING" });
  assert.deepEqual(ndaOnSign({ roomApproval: null }, null), { block: null, create: undefined });
  // Signing again keeps what was decided, and can't reset a wait or a decline.
  assert.deepEqual(ndaOnSign({ roomApproval: true }, { accessStatus: null }), { block: null, create: undefined });
  assert.match(ndaOnSign({ roomApproval: true }, { accessStatus: "PENDING" }).block ?? "", /still deciding/);
  assert.match(ndaOnSign({ roomApproval: true }, { accessStatus: "DECLINED" }).block ?? "", /didn't approve/);
  assert.equal(canManageRoom({ id: "s", role: "INDIVIDUAL_SELLER" }, { sellerId: "s", brokerId: null }), true);
  assert.equal(canManageRoom({ id: "b", role: "BROKER" }, { sellerId: "s", brokerId: "b" }), true);
  assert.equal(canManageRoom({ id: "d", role: "ADMIN" }, { sellerId: "s", brokerId: null }), true);
  assert.equal(canManageRoom({ id: "x", role: "BUYER" }, { sellerId: "s", brokerId: null }), false);
});

// ---------------------------------------------------------------------------------------------------------------
// The watermark.

async function samplePdf(pages = 2) {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) pdf.addPage([612, 792]);
  return Buffer.from(await pdf.save());
}

// Every stream in the file, inflated where it was compressed, so the drawn text can be found.
function streamText(bytes: Uint8Array) {
  const raw = Buffer.from(bytes).toString("latin1");
  let out = "";
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    const body = Buffer.from(match[1], "latin1");
    try {
      out += inflateSync(body).toString("latin1");
    } catch {
      out += match[1];
    }
  }
  return out;
}

const hex = (text: string) => Buffer.from(text, "latin1").toString("hex").toUpperCase();

test("a bidder's PDF is stamped on every page with their name and the date, and an image or a photo goes out as stored", async () => {
  const at = new Date("2026-11-07T15:00:00.000Z");
  const line = watermarkLine("Harbor Point Capital LLC", at);
  assert.equal(line, "Confidential · Harbor Point Capital LLC · 2026-11-07 · UPB Capital");
  const original = await samplePdf(3);
  const copy = await bidderCopy({ type: "BPO", mime: "application/pdf", originalName: "bpo.pdf" }, original, "Harbor Point Capital LLC", at);
  assert.equal(copy.stamped, true);
  assert.equal(copy.failed, false);
  const stamped = await PDFDocument.load(copy.bytes);
  assert.equal(stamped.getPageCount(), 3);
  // Two lines a page, diagonal and footer, each carrying the whole line.
  const drawn = streamText(copy.bytes);
  assert.equal(drawn.split(hex(line)).length - 1, 6);
  // A name outside Latin-1 is stamped with stand-ins rather than failing.
  assert.ok(await watermarkPdf(original, watermarkLine("Fund 北京 LLC", at)));

  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f30000000049454e44ae426082", "hex");
  assert.equal(isPdf({ mime: "image/png", originalName: "front.png" }, png), false);
  const image = await bidderCopy({ type: "OTHER", mime: "image/png", originalName: "front.png" }, png, "Harbor Point Capital LLC", at);
  assert.equal(image.stamped, false);
  assert.equal(image.bytes, png);
  const photo = await bidderCopy({ type: "PHOTO", mime: "application/pdf", originalName: "photo.pdf" }, original, "Harbor Point Capital LLC", at);
  assert.equal(photo.stamped, false);
  assert.equal(photo.bytes, original);
  // A file named .pdf that doesn't parse goes out unstamped, and says so for the log.
  const broken = Buffer.from("%PDF-1.7 not really a pdf");
  const unstamped = await bidderCopy({ type: "OTHER", mime: "application/pdf", originalName: "scan.pdf" }, broken, "Harbor Point Capital LLC", at);
  assert.deepEqual({ stamped: unstamped.stamped, failed: unstamped.failed }, { stamped: false, failed: true });
  assert.equal(unstamped.bytes, broken);
});

// ---------------------------------------------------------------------------------------------------------------
// Timestamp-tagged people and listings nothing seeded touches.

const NOTE = {
  city: "Testville", state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
  lienPosition: "FIRST", upb: 200000, interestRate: 7, monthlyPi: 1400, paymentStatus: "PERFORMING", monthsDelinquent: 0,
  askingPrice: 120000, estimatedValue: 260000,
};

type BuyerKey = "asker" | "inRoom" | "signer" | "outsider" | "waiting" | "turnedAway";

async function makeRoom(opts: { roomApproval?: boolean; kind?: "SINGLE" | "POOL"; status?: "APPROVED" | "PENDING" | "SOLD" } = {}) {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const person = (prefix: string, role: "INDIVIDUAL_SELLER" | "INSTITUTIONAL_SELLER" | "BUYER" | "ADMIN") =>
    prisma.user.create({
      data: {
        email: `room-${prefix.toLowerCase()}-${tag}@example.org`,
        name: `${prefix} Person ${tag}`,
        companyName: role === "BUYER" ? `${prefix} Co ${tag}` : "",
        role,
        accountStatus: "APPROVED",
        passwordHash: "x",
        ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
      },
    });
  const seller = await person("Seller", opts.kind === "POOL" ? "INSTITUTIONAL_SELLER" : "INDIVIDUAL_SELLER");
  const desk = await person("Desk", "ADMIN");
  const keys: BuyerKey[] = ["asker", "inRoom", "signer", "outsider", "waiting", "turnedAway"];
  const buyers = {} as Record<BuyerKey, Awaited<ReturnType<typeof person>>>;
  for (const key of keys) {
    buyers[key] = await person(key, "BUYER");
    await prisma.buyerProfile.create({ data: { userId: buyers[key].id, status: "APPROVED", entityType: "LLC", entityName: `${key} Fund ${tag}` } });
  }
  const listing = await prisma.listing.create({
    data: {
      kind: opts.kind ?? "SINGLE",
      sellerId: seller.id,
      status: opts.status ?? "APPROVED",
      approvedAt: new Date(Date.now() - 10 * DAY),
      title: `Room ${tag}`,
      ...(opts.roomApproval ? { roomApproval: true } : {}),
      notes: { create: (opts.kind === "POOL" ? [1, 2] : [1]).map((index) => ({ ...NOTE, streetAddress: `${index} Room St` })) as never },
    },
    include: { notes: true },
  });
  const file = await prisma.document.create({ data: { listingId: listing.id, type: "BPO", originalName: `bpo-${tag}.pdf`, storedName: `room-test-${tag}.pdf`, mime: "application/pdf", size: 10 } });
  const ndaPdf = await prisma.document.create({ data: { listingId: listing.id, type: "NDA", originalName: `NDA-${tag}.pdf`, storedName: `ndas/${buyers.waiting.id}/${listing.id}.pdf`, mime: "application/pdf", size: 10 } });
  // Signed a day apart, so the letters are known: asker A, inRoom B, signer C, waiting D, turnedAway E.
  const signed = (key: BuyerKey, daysAgo: number, accessStatus?: string, documentId = "") =>
    prisma.ndaAcknowledgment.create({
      data: { userId: buyers[key].id, listingId: listing.id, acknowledgedAt: new Date(Date.now() - daysAgo * DAY), signerName: buyers[key].name, documentId, ...(accessStatus ? { accessStatus } : {}) },
    });
  const ndas = {
    asker: await signed("asker", 6, "APPROVED"),
    inRoom: await signed("inRoom", 5, "APPROVED"),
    // An NDA from before approvals existed carries no status at all.
    signer: await signed("signer", 4),
    waiting: await signed("waiting", 3, "PENDING", ndaPdf.id),
    turnedAway: await signed("turnedAway", 2, "DECLINED"),
  };
  for (const key of ["asker", "inRoom", "outsider", "waiting"] as BuyerKey[]) await prisma.favorite.create({ data: { userId: buyers[key].id, listingId: listing.id } });
  return { tag, seller, desk, buyers, listing, file, ndaPdf, ndas, users: [seller, desk, ...Object.values(buyers)] };
}

type Room = Awaited<ReturnType<typeof makeRoom>>;

async function cleanRoom(room: Room, extraListings: string[] = []) {
  const listingIds = [room.listing.id, ...extraListings];
  const userIds = room.users.map((user) => user.id);
  const stored = await prisma.document.findMany({ where: { listingId: { in: listingIds } }, select: { storedName: true } });
  for (const { storedName } of stored) await fs.unlink(path.join(uploadDir(), storedName)).catch(() => undefined);
  await prisma.listingQuestion.deleteMany({ where: { OR: [{ listingId: { in: listingIds } }, { askerId: { in: userIds } }] } });
  await prisma.ndaAcknowledgment.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.favorite.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listingView.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.document.deleteMany({ where: { listingId: { in: listingIds } } });
  const inquiryIds = (await prisma.inquiry.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((row) => row.id);
  await prisma.deskThread.deleteMany({ where: { OR: [{ listingId: { in: listingIds } }, { inquiryId: { in: inquiryIds } }] } });
  await prisma.inquiry.deleteMany({ where: { listingId: { in: listingIds } } });
  const noteIds = (await prisma.note.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((row) => row.id);
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...listingIds, ...noteIds, ...userIds] } }, { actorId: { in: userIds } }] } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: room.users.map((user) => user.email) } }, { subject: { contains: literal(room.tag) } }] } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

const notices = (email: string, subject: string) => prisma.notification.findMany({ where: { toEmail: email, subject: { contains: subject } } });

// ---------------------------------------------------------------------------------------------------------------
// Q&A.

test("an answer is published to every bidder in the room once each, without the asker, and nobody outside hears", async () => {
  const room = await makeRoom();
  const { asker, inRoom, signer, outsider, waiting, turnedAway } = room.buyers;
  try {
    const asked = await askQuestion(asker, { listingId: room.listing.id, question: "Is the borrower in a bankruptcy plan?" });
    assert.ok(asked.ok);
    // The seller hears the bidder's letter and the question, never the name; the desk hears who asked.
    const toSeller = await notices(room.seller.email, "Bidder question");
    assert.equal(toSeller.length, 1);
    assert.match(toSeller[0].body, /^Bidder A asked: "Is the borrower in a bankruptcy plan\?"/);
    assert.ok(!toSeller[0].body.includes(asker.name) && !toSeller[0].body.includes(asker.companyName) && !toSeller[0].body.includes(asker.email));
    const toDesk = await notices(room.desk.email, "Bidder question");
    assert.equal(toDesk.length, 1);
    assert.ok(toDesk[0].body.includes(asker.email));

    // Nobody but the seller, the broker or the desk answers.
    assert.equal((await answerQuestion(inRoom, { questionId: asked.value.id, answer: "No." })).ok, false);
    const answered = await answerQuestion(room.seller, { questionId: asked.value.id, answer: "No. The pay history is in the room." });
    assert.ok(answered.ok);
    assert.equal(answered.value.told, 3);
    // Once answered, it's closed: a second answer doesn't publish twice.
    assert.equal((await answerQuestion(room.desk, { questionId: asked.value.id, answer: "Again." })).ok, false);

    const heard = async (email: string) => (await notices(email, "Question answered")).length;
    assert.equal(await heard(asker.email), 1);
    assert.match((await notices(asker.email, "Question answered"))[0].body, /^Your question/);
    assert.equal(await heard(inRoom.email), 1, "a watcher in the room hears through the watch notice");
    assert.equal(await heard(signer.email), 1, "an NDA signer who isn't watching hears directly");
    assert.equal(await heard(outsider.email), 0, "a watcher outside the room isn't told");
    assert.equal(await heard(waiting.email), 0, "a bidder waiting on approval isn't told");
    assert.equal(await heard(turnedAway.email), 0);
    for (const row of await prisma.notification.findMany({ where: { subject: { contains: "Question answered" }, toEmail: { in: [inRoom.email, signer.email] } } })) {
      assert.ok(!row.body.includes(asker.name) && !row.body.includes(asker.companyName));
    }

    const published = await publishedQuestions(room.listing.id);
    assert.equal(published.length, 1);
    assert.equal(published[0].answer, "No. The pay history is in the room.");
    assert.ok(!("askerId" in published[0]));
    const audit = await prisma.auditEvent.findMany({ where: { entityId: room.listing.id, action: { in: ["QUESTION_ASK", "QUESTION_ANSWER"] } } });
    assert.equal(audit.length, 2);
  } finally {
    await cleanRoom(room);
  }
});

test("a declined question closes privately, with the note to the asker only", async () => {
  const room = await makeRoom();
  const { signer, inRoom } = room.buyers;
  try {
    const asked = await askQuestion(signer, { listingId: room.listing.id, question: "Who is your servicer contact?" });
    assert.ok(asked.ok);
    assert.equal((await declineQuestion(inRoom, { questionId: asked.value.id, note: "No." })).ok, false);
    const declined = await declineQuestion(room.desk, { questionId: asked.value.id, note: "The servicer is named in the pay history." });
    assert.ok(declined.ok);
    const toAsker = await notices(signer.email, "Your question");
    assert.equal(toAsker.length, 1);
    assert.match(toAsker[0].body, /closed without a published answer\. The note: The servicer is named in the pay history\./);
    assert.equal((await notices(inRoom.email, "Question answered")).length, 0);
    assert.equal((await publishedQuestions(room.listing.id)).length, 0);
    const mine = await questionsAskedBy(room.listing.id, signer.id);
    assert.deepEqual(mine.map((row) => [row.status, row.answer]), [["DECLINED", "The servicer is named in the pay history."]]);
    assert.equal((await answerQuestion(room.seller, { questionId: asked.value.id, answer: "Late." })).ok, false);
  } finally {
    await cleanRoom(room);
  }
});

test("only a bidder whose NDA opens a live room can ask, and a pool question names a loan of that pool", async () => {
  const room = await makeRoom({ kind: "POOL" });
  const { outsider, waiting, turnedAway, signer } = room.buyers;
  try {
    const ask = (user: { id: string; role: string; accountStatus: string; name: string; email: string }, extra: { noteId?: string } = {}) =>
      askQuestion(user, { listingId: room.listing.id, question: "What does the title show?", ...extra });
    for (const user of [outsider, waiting, turnedAway, room.seller]) {
      const refused = await ask(user);
      assert.equal(refused.ok, false);
    }
    const tooShort = await askQuestion(signer, { listingId: room.listing.id, question: "Hm" });
    assert.ok(!tooShort.ok && /sentence/.test(tooShort.error));
    const elsewhere = await ask(signer, { noteId: "000000000000000000000000" });
    assert.ok(!elsewhere.ok && /isn't on this listing/.test(elsewhere.error));
    const onLoan = await ask(signer, { noteId: room.listing.notes[1].id });
    assert.ok(onLoan.ok);
    assert.equal((await prisma.listingQuestion.findUnique({ where: { id: onLoan.value.id } }))?.noteId, room.listing.notes[1].id);
    await prisma.listing.update({ where: { id: room.listing.id }, data: { status: "PENDING" } });
    const closed = await ask(signer);
    assert.ok(!closed.ok && /isn't live/.test(closed.error));
  } finally {
    await cleanRoom(room);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Seller-approved access.

test("a waiting NDA opens only the buyer's own copy, approval opens the room, and a decline keeps it shut", async () => {
  const room = await makeRoom({ roomApproval: true });
  const { waiting, turnedAway, signer, outsider } = room.buyers;
  try {
    const gate = async (user: Parameters<typeof documentGate>[0], documentId = room.file.id) => (await documentGate(user, documentId)).allowed;
    assert.equal(await gate(waiting), false);
    assert.equal(await gate(waiting, room.ndaPdf.id), true, "the buyer's own signed NDA stays theirs");
    assert.equal(await gate(turnedAway), false);
    assert.equal(await gate(outsider), false);

    const requests = await roomRequests(room.listing.id);
    assert.deepEqual(requests.map((row) => [row.userId, row.status, row.entityName, row.entityType, row.verified]), [
      [waiting.id, "PENDING", `waiting Fund ${room.tag}`, "Limited liability company", true],
      [turnedAway.id, "DECLINED", `turnedAway Fund ${room.tag}`, "Limited liability company", true],
    ]);

    assert.equal((await decideRoomAccess(signer, { ndaId: room.ndas.waiting.id, decision: "APPROVED" })).ok, false);
    const approved = await decideRoomAccess(room.seller, { ndaId: room.ndas.waiting.id, decision: "APPROVED" });
    assert.ok(approved.ok);
    const after = await prisma.ndaAcknowledgment.findUnique({ where: { id: room.ndas.waiting.id } });
    assert.equal(after?.accessStatus, "APPROVED");
    assert.equal(after?.accessDecidedById, room.seller.id);
    assert.ok(after?.accessDecidedAt);
    assert.equal(await gate(waiting), true);
    assert.equal((await notices(waiting.email, "Data room open")).length, 1);
    assert.equal((await decideRoomAccess(room.desk, { ndaId: room.ndas.waiting.id, decision: "DECLINED" })).ok, false, "a decision stands once made");

    // A declined bidder can still be let in later, by the desk here, and that is logged too.
    const reversed = await decideRoomAccess(room.desk, { ndaId: room.ndas.turnedAway.id, decision: "APPROVED" });
    assert.ok(reversed.ok);
    assert.equal(await gate(turnedAway), true);
    const logged = await prisma.auditEvent.findMany({ where: { entityId: room.listing.id, action: { in: ["ROOM_ACCESS_APPROVED", "ROOM_ACCESS_DECLINED"] } } });
    assert.equal(logged.length, 2);
  } finally {
    await cleanRoom(room);
  }
});

test("a decline shuts the room and tells the buyer, and turning approval off lets the waiting in", async () => {
  const room = await makeRoom({ roomApproval: true });
  const { waiting, asker } = room.buyers;
  try {
    await prisma.ndaAcknowledgment.update({ where: { id: room.ndas.asker.id }, data: { accessStatus: "PENDING" } });
    const declined = await decideRoomAccess(room.seller, { ndaId: room.ndas.asker.id, decision: "DECLINED" });
    assert.ok(declined.ok);
    assert.equal((await documentGate(asker, room.file.id)).allowed, false);
    assert.match((await notices(asker.email, "Data room access"))[0]?.body ?? "", /didn't approve access/);

    assert.equal((await setRoomApproval(room.buyers.signer, { listingId: room.listing.id, on: false })).ok, false);
    const off = await setRoomApproval(room.seller, { listingId: room.listing.id, on: false });
    assert.ok(off.ok);
    assert.equal(off.value.released, 1);
    assert.equal((await prisma.listing.findUnique({ where: { id: room.listing.id } }))?.roomApproval, false);
    assert.equal((await documentGate(waiting, room.file.id)).allowed, true);
    assert.equal((await documentGate(asker, room.file.id)).allowed, false, "a decline stands when approval goes off");
  } finally {
    await cleanRoom(room);
  }
});

test("an NDA signed before approvals existed still opens the room, even after the seller turns approval on", async () => {
  const room = await makeRoom({ roomApproval: true });
  const { signer } = room.buyers;
  try {
    const legacy = await prisma.ndaAcknowledgment.findUnique({ where: { id: room.ndas.signer.id } });
    assert.equal(legacy?.accessStatus ?? null, null);
    const seen = await documentGate(signer, room.file.id);
    assert.equal(seen.allowed, true);
    assert.equal(seen.buyerCopy, true, "a bidder's download is stamped");
    const asSeller = await documentGate(room.seller, room.file.id);
    assert.deepEqual({ allowed: asSeller.allowed, buyerCopy: asSeller.buyerCopy }, { allowed: true, buyerCopy: false });
    const asDesk = await documentGate(room.desk, room.file.id);
    assert.deepEqual({ allowed: asDesk.allowed, buyerCopy: asDesk.buyerCopy }, { allowed: true, buyerCopy: false });
  } finally {
    await cleanRoom(room);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Bidder letters on the seller's side.

test("a seller reads bidders by a letter that doesn't move, an awarded buyer by name, and the desk always by name", async () => {
  const room = await makeRoom();
  const { asker, inRoom, outsider } = room.buyers;
  try {
    const before = await bidderAliases(room.listing.id);
    assert.equal(before.get(asker.id), "Bidder A");
    assert.equal(before.get(inRoom.id), "Bidder B");
    assert.equal(before.get(room.buyers.turnedAway.id), "Bidder E");
    assert.equal(before.has(room.seller.id), false);
    // A new bidder joins at the end; nobody already lettered moves.
    const bid = await prisma.inquiry.create({ data: { listingId: room.listing.id, buyerId: outsider.id, type: "OFFER", amount: 100000, status: "OPEN" } });
    const after = await bidderAliases(room.listing.id);
    assert.equal(after.get(outsider.id), "Bidder F");
    for (const [userId, alias] of before) assert.equal(after.get(userId), alias);

    const sellerSees = await bidderNamer(room.listing.id, room.seller);
    const deskSees = await bidderNamer(room.listing.id, room.desk);
    assert.equal(sellerSees(outsider), "Bidder F");
    assert.equal(deskSees(outsider), outsider.companyName);
    await prisma.inquiry.update({ where: { id: bid.id }, data: { status: "ACCEPTED" } });
    assert.equal((await bidderNamer(room.listing.id, room.seller))(outsider), outsider.companyName, "after the award the seller sees the party");
    assert.equal((await bidderNamer(room.listing.id, room.seller))(asker), "Bidder A");
    // The seller's bid threads follow the same letters; the desk, and threads off the listing, show names.
    const onThread = await threadNamer(room.seller, [room.listing.id, null]);
    assert.equal(onThread(room.listing.id, asker), "Bidder A");
    assert.equal(onThread(room.listing.id, room.desk), room.desk.name);
    assert.equal(onThread(null, asker), asker.name);
    assert.equal((await threadNamer(room.desk, [room.listing.id]))(room.listing.id, asker), asker.name);
    assert.equal((await threadNamer(asker, [room.listing.id]))(room.listing.id, inRoom), inRoom.name, "a bidder isn't the seller");
  } finally {
    await cleanRoom(room);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The access log.

test("the access log lists each NDA, decision and download by letter for the seller and by entity for the desk, and is closed to bidders", async () => {
  const room = await makeRoom({ roomApproval: true });
  const { asker, signer, waiting } = room.buyers;
  try {
    await decideRoomAccess(room.seller, { ndaId: room.ndas.waiting.id, decision: "APPROVED" });
    for (const [user, name] of [[asker, "bpo.pdf"], [asker, "bpo.pdf"], [asker, "title.pdf"], [signer, "bpo.pdf"], [room.seller, "bpo.pdf"], [room.desk, "bpo.pdf"]] as const) {
      await prisma.auditEvent.create({ data: { actorId: user.id, action: "DOCUMENT_DOWNLOAD", entityType: "listing", entityId: room.listing.id, detail: name } });
    }
    const seller = await accessLog(room.listing.id, room.seller);
    assert.equal(seller.status, 200);
    if (seller.status !== 200) return;
    const downloads = seller.rows.filter((row) => row.event === "Download");
    assert.equal(downloads.length, 4, "the seller's and the desk's own downloads aren't bidder activity");
    assert.deepEqual([...new Set(downloads.map((row) => row.bidder))].sort(), ["Bidder A", "Bidder C"]);
    const text = JSON.stringify(seller.rows) + JSON.stringify(seller.engagement);
    for (const buyer of Object.values(room.buyers)) assert.ok(!text.includes(buyer.name) && !text.includes(buyer.companyName) && !text.includes(`Fund ${room.tag}`));
    const decision = seller.rows.find((row) => row.event === "Access approved");
    assert.equal(decision?.bidder, "Bidder D");
    assert.ok(decision?.access_decided_at && decision.nda_signed_at);
    assert.equal(seller.rows.filter((row) => row.event === "NDA signed").length, 5);
    const lineA = seller.engagement.find((row) => row.bidder === "Bidder A");
    assert.deepEqual({ files: lineA?.files, downloads: lineA?.downloads, access: lineA?.access }, { files: 2, downloads: 3, access: "Open" });
    assert.equal(seller.engagement.find((row) => row.userId === room.buyers.turnedAway.id)?.access, "Declined");

    const desk = await accessLog(room.listing.id, room.desk);
    assert.equal(desk.status, 200);
    if (desk.status !== 200) return;
    assert.ok(desk.rows.some((row) => row.bidder === `asker Fund ${room.tag} (Bidder A)`));
    assert.equal(desk.engagement.find((row) => row.userId === waiting.id)?.bidder, `waiting Fund ${room.tag} (Bidder D)`);

    assert.equal((await accessLog(room.listing.id, asker)).status, 403);
    assert.equal((await accessLog("000000000000000000000000", room.desk)).status, 404);
    const csv = accessLogCsv(seller.rows);
    assert.equal(csv.split("\n")[0], ACCESS_LOG_COLUMNS.join(","));
    assert.equal(accessLogCsv([]), ACCESS_LOG_COLUMNS.join(","));
  } finally {
    await cleanRoom(room);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Pool files after filing.

test("a pool's seller adds files while it is live, to the pool or to one loan, and watchers are told", async () => {
  const room = await makeRoom({ kind: "POOL" });
  const single = await prisma.listing.create({
    data: { kind: "SINGLE", sellerId: room.seller.id, status: "APPROVED", title: `Single ${room.tag}`, notes: { create: [{ ...NOTE, streetAddress: "9 Room St" }] as never } },
  });
  try {
    const pdf = await samplePdf(1);
    const added = await addPoolFiles(room.seller, {
      listingId: room.listing.id,
      files: [
        { name: "updated-tape.pdf", bytes: pdf, mime: "application/pdf", type: "TAPE" },
        { name: "bad.exe", bytes: Buffer.from("MZ not allowed"), mime: "application/octet-stream", type: "OTHER" },
      ],
    });
    assert.equal(added.error, null);
    assert.equal(added.added, 1);
    assert.deepEqual(added.skipped, ["bad.exe"]);
    const poolFile = await prisma.document.findFirst({ where: { listingId: room.listing.id, originalName: "updated-tape.pdf" } });
    assert.equal(poolFile?.type, "TAPE");
    assert.equal(poolFile?.noteId ?? null, null);
    assert.ok((await fs.stat(path.join(uploadDir(), poolFile!.storedName))).size > 0);

    // One loan's own file: a tape type makes no sense there, so it files as Other.
    const onLoan = await addPoolFiles(room.seller, { listingId: room.listing.id, noteId: room.listing.notes[0].id, files: [{ name: "loan-1-title.pdf", bytes: pdf, type: "TAPE" }] });
    assert.equal(onLoan.added, 1);
    const loanFile = await prisma.document.findFirst({ where: { listingId: room.listing.id, originalName: "loan-1-title.pdf" } });
    assert.deepEqual({ noteId: loanFile?.noteId, type: loanFile?.type }, { noteId: room.listing.notes[0].id, type: "OTHER" });

    // Watchers hear, once per upload, and only the buyers among them.
    assert.equal((await notices(room.buyers.outsider.email, "New files")).length, 2);
    assert.equal((await notices(room.buyers.signer.email, "New files")).length, 0, "not a watcher");
    assert.ok((await notices(room.desk.email, "Files added")).length >= 2);

    assert.ok(/isn't yours/.test((await addPoolFiles(room.buyers.asker, { listingId: room.listing.id, files: [{ name: "x.pdf", bytes: pdf, type: "OTHER" }] })).error ?? ""));
    assert.ok(/single note/.test((await addPoolFiles(room.seller, { listingId: single.id, files: [{ name: "x.pdf", bytes: pdf, type: "OTHER" }] })).error ?? ""));
    assert.ok(/isn't in this pool/.test((await addPoolFiles(room.seller, { listingId: room.listing.id, noteId: "000000000000000000000000", files: [{ name: "x.pdf", bytes: pdf, type: "OTHER" }] })).error ?? ""));
    await prisma.listing.update({ where: { id: room.listing.id }, data: { status: "SOLD" } });
    assert.ok(/past the point/.test((await addPoolFiles(room.seller, { listingId: room.listing.id, files: [{ name: "x.pdf", bytes: pdf, type: "OTHER" }] })).error ?? ""));

    // In review, files go in for the desk, and watchers aren't told about a room they can't open yet.
    await prisma.listing.update({ where: { id: room.listing.id }, data: { status: "UNDER_REVIEW" } });
    const inReview = await addPoolFiles(room.seller, { listingId: room.listing.id, files: [{ name: "late.pdf", bytes: pdf, type: "OTHER" }] });
    assert.equal(inReview.added, 1);
    assert.equal((await notices(room.buyers.outsider.email, "New files")).length, 2);
  } finally {
    await cleanRoom(room, [single.id]);
  }
});
