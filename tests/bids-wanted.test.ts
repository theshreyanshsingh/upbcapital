import assert from "node:assert/strict";
import test from "node:test";
import {
  answerChoices,
  answerRequest,
  boardRequest,
  buyerRequests,
  createRequest,
  criteriaLines,
  declineResponse,
  deskCloseRequest,
  deskRequests,
  OPEN_LIMIT,
  publicRequestCounts,
  readCriteria,
  readRequest,
  REQUEST_INVITE,
  requestBlock,
  requestBoard,
  requestCounts,
  requestInputFrom,
  setRequestStatus,
  updateRequest,
  type RequestInput,
} from "../lib/bids-wanted";
import { MIN_FIRMS } from "../lib/demand-board";
import { writeInquiry } from "../lib/inquiry";
import { rememberView } from "../lib/listing-intel";
import { prisma } from "../lib/prisma";
import { addExclusion, canSeeListing } from "../lib/private-listings";
import { resolveSessionUser } from "../lib/seats";

const DAY = 24 * 60 * 60 * 1000;
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
const email = (who: string) => `a-wanted-${who}-${tag}@example.org`;
const made = { users: [] as string[], listings: [] as string[], emails: [] as string[] };

type Role = "BUYER" | "INSTITUTIONAL_SELLER" | "INDIVIDUAL_SELLER" | "BROKER" | "ADMIN";

async function person(
  who: string,
  role: Role,
  extra: { status?: "APPROVED" | "PENDING"; pro?: boolean; companyName?: string; file?: "APPROVED" | "SUBMITTED" | null; entityType?: "FUND" | "BANK" | "LLC"; principalId?: string } = {},
) {
  const user = await prisma.user.create({
    data: {
      email: email(who),
      name: `Wanted ${who} ${tag}`,
      role,
      accountStatus: extra.status ?? "APPROVED",
      passwordHash: "x",
      companyName: extra.companyName ?? "",
      ...(role === "BUYER" && extra.pro !== false ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
      ...(extra.principalId ? { principalId: extra.principalId, seatRole: "TRADE", seatAddedAt: new Date() } : {}),
    },
  });
  made.users.push(user.id);
  made.emails.push(user.email);
  const file = extra.file === undefined ? (role === "BUYER" && !extra.principalId ? "APPROVED" : null) : extra.file;
  if (file) {
    await prisma.buyerProfile.create({
      data: {
        userId: user.id,
        entityType: extra.entityType ?? "FUND",
        entityName: `${extra.companyName || `Entity ${who}`}`,
        status: file,
        ...(extra.entityType === "BANK" ? { charterNumber: "57890", regulator: "FDIC" } : {}),
      },
    });
  }
  return user;
}

async function listing(sellerId: string, input: { title: string; visibility?: string; status?: "APPROVED" | "SUBMITTED"; brokerId?: string }) {
  const row = await prisma.listing.create({
    data: {
      kind: "POOL",
      sellerId,
      ...(input.brokerId ? { brokerId: input.brokerId } : {}),
      status: input.status ?? "APPROVED",
      approvedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      standingBidsNotifiedAt: new Date(),
      title: input.title,
      ...(input.visibility ? { visibility: input.visibility } : {}),
      notes: {
        create: [{
          streetAddress: "1 Wanted Way", city: "Askville", state: "QZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
          lienPosition: "FIRST", upb: 300000, interestRate: 6.5, monthlyPi: 1900, paymentStatus: "PERFORMING", monthsDelinquent: 0,
          askingPrice: 240000, estimatedValue: 400000,
        }] as never,
      },
    },
  });
  made.listings.push(row.id);
  return row;
}

const WANT: RequestInput = {
  title: `VA performing firsts ${tag}`,
  kind: "POOL",
  liens: ["FIRST"],
  statuses: ["PERFORMING"],
  programs: ["VA"],
  states: "tx, ok",
  upbMin: "$5M",
  upbMax: "20,000,000",
  minLoans: "10",
  maxLoans: "",
  priceToUpbMax: "85%",
  targetYield: "",
  notes: "Servicing released preferred.",
  expiryDays: "60",
};

let world: Awaited<ReturnType<typeof build>>;

async function build() {
  const buyer = await person("buyer", "BUYER", { companyName: "Zephyrine Holdings LLC", entityType: "FUND" });
  const bank = await person("bank", "BUYER", { pro: false, entityType: "BANK", companyName: "Quillfeather Bank" });
  const third = await person("third", "BUYER", { entityType: "LLC" });
  const pending = await person("pending", "BUYER", { status: "PENDING" });
  const unfiled = await person("unfiled", "BUYER", { file: "SUBMITTED" });
  const free = await person("free", "BUYER", { pro: false, entityType: "FUND" });
  const outsider = await person("outsider", "BUYER");
  const limited = await person("limited", "BUYER");
  const seat = await person("seat", "BUYER", { principalId: limited.id, file: null });
  const seller = await person("seller", "INSTITUTIONAL_SELLER");
  const picky = await person("picky", "INDIVIDUAL_SELLER");
  const newSeller = await person("newseller", "INDIVIDUAL_SELLER", { status: "PENDING" });
  const broker = await person("broker", "BROKER");
  const desk = await person("desk", "ADMIN");
  const hidden = await listing(seller.id, { title: `Private pool ${tag}`, visibility: "PRIVATE" });
  const open = await listing(seller.id, { title: `Public pool ${tag}` });
  const filed = await listing(seller.id, { title: `Filed pool ${tag}`, visibility: "PRIVATE", status: "SUBMITTED" });
  const pickyPool = await listing(picky.id, { title: `Picky pool ${tag}`, visibility: "PRIVATE" });
  return { buyer, bank, third, pending, unfiled, free, outsider, limited, seat, seller, picky, newSeller, broker, desk, hidden, open, filed, pickyPool };
}

test.before(async () => {
  world = await build();
});

test.after(async () => {
  const listingIds = made.listings;
  const userIds = made.users;
  const requestIds = (await prisma.buyerRequest.findMany({ where: { userId: { in: userIds } }, select: { id: true } })).map((row) => row.id);
  const inquiryIds = (await prisma.inquiry.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((row) => row.id);
  await prisma.requestResponse.deleteMany({ where: { OR: [{ requestId: { in: requestIds } }, { listingId: { in: listingIds } }] } });
  await prisma.buyerRequest.deleteMany({ where: { id: { in: requestIds } } });
  await prisma.offerMessage.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await prisma.deskThread.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await prisma.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await prisma.listingMatch.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listingView.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listingInvite.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.sellerExclusion.deleteMany({ where: { sellerId: { in: userIds } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...listingIds, ...userIds, ...requestIds] } }, { actorId: { in: userIds } }] } });
  await prisma.note.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: made.emails } }, { subject: { contains: tag } }] } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

async function post(user: { id: string }, input: Partial<RequestInput> = {}) {
  const outcome = await createRequest(user, { ...WANT, ...input });
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.error);
  return outcome.value.id;
}

test("the form is read and checked: titles, notes, states, ranges, the price guide and contact details", () => {
  const form = new FormData();
  for (const [key, value] of Object.entries({ title: " VA  firsts ", kind: "POOL", lien_FIRST: "on", status_PERFORMING: "on", program_VA: "on", program_BOGUS: "on", states: "TX", upbMin: "5M", expiryDays: "30" })) form.set(key, value);
  const read = readRequest(requestInputFrom(form));
  assert.equal(read.error, null);
  if (read.error === null) {
    assert.equal(read.title, "VA firsts");
    assert.equal(read.expiryDays, 30);
    assert.deepEqual(read.criteria.liens, ["FIRST"]);
    assert.deepEqual(read.criteria.programs, ["VA"], "a checkbox the form doesn't offer is never read");
    assert.equal(read.criteria.upbMin, 5_000_000);
  }
  const ok = readRequest(WANT);
  assert.equal(ok.error, null);
  if (ok.error === null) {
    assert.deepEqual(ok.criteria.states, ["TX", "OK"]);
    assert.equal(ok.criteria.priceToUpbMax, 85);
    assert.equal(ok.criteria.targetYield, null, "the price guide never needs both");
    assert.deepEqual(criteriaLines(ok.criteria), [
      "Pools only",
      "First lien, performing",
      "VA loans",
      "In TX or OK",
      "$5M to $20M of UPB",
      "At least 10 loans",
      "Price guide: up to 85% of UPB",
    ]);
  }
  const refused = (input: Partial<RequestInput>) => readRequest({ ...WANT, ...input }).error;
  assert.match(refused({ title: "VA" }) ?? "", /title/);
  assert.match(refused({ notes: "x".repeat(501) }) ?? "", /500/);
  assert.match(refused({ states: "TX, ZZ" }) ?? "", /ZZ/);
  assert.match(refused({ upbMin: "30M" }) ?? "", /above the maximum/);
  assert.match(refused({ upbMin: "lots" }) ?? "", /UPB minimum/);
  assert.match(refused({ minLoans: "2.5" }) ?? "", /whole number/);
  assert.match(refused({ kind: "SINGLE" }) ?? "", /single note is one loan/);
  assert.match(refused({ priceToUpbMax: "180" }) ?? "", /up to 150/);
  assert.match(refused({ targetYield: "0" }) ?? "", /target yield/);
  assert.match(refused({ expiryDays: "45" }) ?? "", /30, 60 or 90/);
  assert.match(refused({ liens: ["FIRST", "FOURTH"] }) ?? "", /liens/);
  assert.match(refused({ notes: "Call me at 212-555-0100" }) ?? "", /phone/);
  assert.match(refused({ notes: "Write to deals@example.com" }) ?? "", /emails/);
  assert.match(refused({ kind: "ANY", liens: [], statuses: [], programs: [], states: "", upbMin: "", upbMax: "", minLoans: "" }) ?? "", /at least one limit/);
  assert.equal(readRequest({ ...WANT, priceToUpbMax: "", targetYield: "9" }).error, null, "a yield alone is a price guide");
  // Old or odd JSON reads as any.
  assert.deepEqual(readCriteria({ liens: ["FIRST", 3], kind: "BOTH", upbMin: "5" }), {
    liens: ["FIRST"], statuses: [], states: [], programs: [], upbMin: null, upbMax: null, minLoans: null, maxLoans: null, priceToUpbMax: null, targetYield: null, kind: "ANY",
  });
});

test("only an approved buyer on a current file, on Pro or a checked bank, posts", async () => {
  const pending = await createRequest(world.pending, WANT);
  assert.equal(pending.ok, false);
  assert.match(pending.ok ? "" : pending.error, /approves your account/);
  const block = async (user: { id: string }) => (await requestBlock(user)) ?? "";
  assert.match(await block(world.unfiled), /buyer file the desk approved/);
  assert.match(await block(world.free), /Pro privilege/);
  assert.match(await block(world.seller), /buyer accounts/);
  // A file past its re-certification date stops new requests until the desk approves it again.
  await prisma.buyerProfile.update({ where: { userId: world.outsider.id }, data: { recertifyBy: new Date(Date.now() - DAY) } });
  assert.match(await block(world.outsider), /re-certification/);
  await prisma.buyerProfile.update({ where: { userId: world.outsider.id }, data: { recertifyBy: null } });
  assert.equal(await requestBlock(world.bank), null, "a desk-checked bank posts on the free plan");
  assert.equal(await requestBlock(world.buyer), null);
  const named = await createRequest(world.buyer, { ...WANT, title: `Zephyrine Holdings wants VA ${tag}` });
  assert.equal(named.ok, false);
  assert.match(named.ok ? "" : named.error, /firm's name/);
  assert.equal(await prisma.buyerRequest.count({ where: { userId: { in: [world.pending.id, world.free.id, world.unfiled.id] } } }), 0);
});

test("a firm keeps at most five open requests, its seats included", async () => {
  const acting = await resolveSessionUser(world.seat.id);
  assert.ok(acting);
  assert.equal(acting.user.id, world.limited.id, "a seat acts as its firm");
  const ids: string[] = [];
  for (let i = 0; i < OPEN_LIMIT - 1; i++) ids.push(await post(world.limited, { title: `Firm want ${i} ${tag}` }));
  ids.push(await post(acting.user, { title: `Seat want ${tag}` }));
  const sixth = await createRequest({ id: world.seat.id }, { ...WANT, title: `One too many ${tag}` });
  assert.equal(sixth.ok, false, "the seat's own row counts as the firm too");
  assert.match(sixth.ok ? "" : sixth.error, /5 open requests/);
  assert.equal(await prisma.buyerRequest.count({ where: { userId: world.seat.id } }), 0);
  // A paused request frees a place, and resuming it needs one back.
  assert.equal((await setRequestStatus(world.limited, ids[0], "PAUSE")).ok, true);
  const fresh = await post(world.limited, { title: `Fills the place ${tag}` });
  const resume = await setRequestStatus(world.limited, ids[0], "RESUME");
  assert.equal(resume.ok, false);
  assert.equal((await setRequestStatus(world.limited, fresh, "FILLED")).ok, true);
  assert.equal((await setRequestStatus(world.limited, ids[0], "RESUME")).ok, true);
  assert.equal((await setRequestStatus(world.limited, fresh, "RESUME")).ok, false, "filled is for good");
  // An expired request is off the count, and an edit brings it back with a new expiry.
  await prisma.buyerRequest.update({ where: { id: ids[1] }, data: { expiresAt: new Date(Date.now() - DAY) } });
  const another = await post(world.limited, { title: `After expiry ${tag}` });
  assert.equal((await updateRequest(world.limited, ids[1], WANT)).ok, false, "renewing it would make six");
  assert.equal((await setRequestStatus(world.limited, another, "CLOSE")).ok, true);
  assert.equal((await updateRequest(world.limited, ids[1], { ...WANT, expiryDays: "90" })).ok, true);
  const renewed = await prisma.buyerRequest.findUniqueOrThrow({ where: { id: ids[1] } });
  assert.ok(renewed.expiresAt && renewed.expiresAt.getTime() > Date.now() + 89 * DAY);
  assert.equal((await updateRequest(world.buyer, ids[1], WANT)).ok, false, "another firm can't edit it");
});

test("the board shows open, unexpired requests with the buyer as a type, never its name", async () => {
  const live = await post(world.buyer);
  const paused = await post(world.buyer, { title: `Paused want ${tag}` });
  await setRequestStatus(world.buyer, paused, "PAUSE");
  const lapsed = await post(world.buyer, { title: `Lapsed want ${tag}` });
  await prisma.buyerRequest.update({ where: { id: lapsed }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const banked = await post(world.bank, { title: `Bank want ${tag}` });

  const board = (await requestBoard(world.seller)).filter((row) => row.title.includes(tag));
  const ids = board.map((row) => row.id);
  assert.ok(ids.includes(live) && ids.includes(banked));
  assert.ok(!ids.includes(paused) && !ids.includes(lapsed));
  const row = board.find((one) => one.id === live)!;
  assert.equal(row.buyerType, "Fund");
  assert.equal(board.find((one) => one.id === banked)?.buyerType, "Bank");
  assert.deepEqual(row.track, ["No closings on UPB yet"]);
  assert.ok(row.criteria.includes("Price guide: up to 85% of UPB"));
  const text = JSON.stringify(board);
  for (const secret of [world.buyer.email, world.buyer.name, "Zephyrine", world.buyer.id, world.bank.email, "Quillfeather"]) {
    assert.ok(!text.includes(secret), `the board never shows ${secret}`);
  }
  assert.ok((await requestBoard(world.broker)).some((one) => one.id === live), "brokers see the board");
  assert.ok((await requestBoard(world.desk)).some((one) => one.id === live), "the desk sees it");
  assert.deepEqual(await requestBoard(world.newSeller), [], "an unapproved seller sees nothing");
  assert.deepEqual(await requestBoard(world.outsider), [], "buyers don't see the board");
  assert.equal(await boardRequest(world.seller, paused), null);

  // A seller who excludes the buyer never sees its requests, and can't answer them.
  const excluded = await addExclusion(world.picky, { kind: "EMAIL", value: world.buyer.email, reason: "" });
  assert.ok(excluded.ok);
  assert.ok(!(await requestBoard(world.picky)).some((one) => one.id === live));
  assert.ok((await requestBoard(world.picky)).some((one) => one.id === banked));
  const blocked = await answerRequest(world.picky, { requestId: live, listingId: world.pickyPool.id });
  assert.equal(blocked.ok, false);
  assert.match(blocked.ok ? "" : blocked.error, /no longer open/);

  // A buyer who stops qualifying drops off the board until they do.
  await prisma.user.update({ where: { id: world.bank.id }, data: { accountStatus: "SUSPENDED" } });
  assert.ok(!(await requestBoard(world.seller)).some((one) => one.id === banked));
  await prisma.user.update({ where: { id: world.bank.id }, data: { accountStatus: "APPROVED" } });
});

test("answering with a private listing invites the buyer alone, once, and the view and bid move the answer", async () => {
  const requestId = await post(world.buyer, { title: `Answer me ${tag}` });
  assert.equal(await canSeeListing(world.buyer, world.hidden), false);
  const choices = await answerChoices(world.seller, requestId);
  assert.deepEqual(new Set(choices.map((choice) => choice.id)), new Set([world.hidden.id, world.open.id, world.filed.id]));

  const sent = await answerRequest(world.seller, { requestId, listingId: world.hidden.id });
  assert.ok(sent.ok, sent.ok ? "" : sent.error);
  assert.equal(sent.value.invited, true);
  const invite = await prisma.listingInvite.findFirstOrThrow({ where: { listingId: world.hidden.id, userId: world.buyer.id } });
  assert.ok(invite.email.startsWith(REQUEST_INVITE), "the seller's audience list shows the answer, not the buyer's address");
  assert.ok(!invite.email.includes(world.buyer.email));
  assert.equal(await canSeeListing(world.buyer, world.hidden), true);
  assert.equal(await canSeeListing(world.outsider, world.hidden), false, "no one else is invited");
  assert.equal(await canSeeListing(world.bank, world.hidden), false);
  const response = await prisma.requestResponse.findFirstOrThrow({ where: { requestId, listingId: world.hidden.id } });
  assert.equal(response.status, "SENT");
  assert.equal(response.sellerId, world.seller.id);
  assert.ok(await prisma.notification.findFirst({ where: { toEmail: world.buyer.email, subject: { contains: "Answer to your request" } } }));

  const again = await answerRequest(world.seller, { requestId, listingId: world.hidden.id });
  assert.equal(again.ok, false, "a listing answers a request once");
  assert.match(again.ok ? "" : again.error, /already went/);
  assert.equal((await answerChoices(world.seller, requestId)).find((choice) => choice.id === world.hidden.id)?.sent, true);
  assert.equal((await answerRequest(world.broker, { requestId, listingId: world.open.id })).ok, false, "only the listing's own seller or broker sends it");

  // A public listing stays public: the buyer hears, and no invitation is made.
  const pub = await answerRequest(world.seller, { requestId, listingId: world.open.id });
  assert.ok(pub.ok && !pub.value.invited);
  assert.equal(await prisma.listingInvite.count({ where: { listingId: world.open.id } }), 0);
  assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: world.open.id } })).visibility, null);

  // The buyer opens the listing, then bids on it.
  await rememberView(world.hidden.id, world.buyer.id);
  assert.equal((await prisma.requestResponse.findUniqueOrThrow({ where: { id: response.id } })).status, "VIEWED");
  assert.ok((await prisma.listingInvite.findUniqueOrThrow({ where: { id: invite.id } })).openedAt, "the seller's list reads it as opened");
  await rememberView(world.hidden.id, world.outsider.id);
  assert.equal((await prisma.requestResponse.findUniqueOrThrow({ where: { id: response.id } })).status, "VIEWED", "someone else's view changes nothing");
  await writeInquiry({
    user: world.buyer,
    listing: { ...world.hidden, seller: { email: world.seller.email } },
    type: "OFFER",
    noteId: "",
    amount: 230000,
    message: "Opening bid.",
    expiresAt: null,
  });
  assert.equal((await prisma.requestResponse.findUniqueOrThrow({ where: { id: response.id } })).status, "BID");
  assert.equal((await declineResponse(world.buyer, response.id)).ok, false, "a bid can't be passed on");

  // The buyer's page shows both answers, and the board shows the seller its own.
  const mine = (await buyerRequests(world.buyer.id)).find((row) => row.id === requestId)!;
  assert.deepEqual(new Set(mine.answers.map((answer) => answer.listingId)), new Set([world.hidden.id, world.open.id]));
  assert.equal(mine.answers.find((answer) => answer.listingId === world.hidden.id)?.private, true);
  const card = await boardRequest(world.seller, requestId);
  assert.equal(card?.answers.length, 2);
  const pubResponse = await prisma.requestResponse.findFirstOrThrow({ where: { requestId, listingId: world.open.id } });
  assert.equal((await declineResponse(world.outsider, pubResponse.id)).ok, false, "only the buyer passes");
  assert.equal((await declineResponse(world.buyer, pubResponse.id)).ok, true);
  assert.equal((await prisma.requestResponse.findUniqueOrThrow({ where: { id: pubResponse.id } })).status, "DECLINED");
  assert.ok(await prisma.notification.findFirst({ where: { toEmail: world.seller.email, subject: { contains: "A buyer passed" } } }));

  // A seller who revokes the invitation takes the answer off the buyer's page with it.
  await prisma.listingInvite.update({ where: { id: invite.id }, data: { revokedAt: new Date() } });
  assert.ok(!(await buyerRequests(world.buyer.id)).find((row) => row.id === requestId)!.answers.some((answer) => answer.listingId === world.hidden.id));
  await prisma.listingInvite.update({ where: { id: invite.id }, data: { revokedAt: null } });
});

test("a listing in review answers too, and a filled request takes no more", async () => {
  const requestId = await post(world.bank, { title: `Review answer ${tag}` });
  const sent = await answerRequest(world.seller, { requestId, listingId: world.filed.id });
  assert.ok(sent.ok && sent.value.invited);
  const answer = (await buyerRequests(world.bank.id)).find((row) => row.id === requestId)!.answers[0];
  assert.equal(answer.inReview, true);
  assert.equal(answer.opens, false, "the listing page opens once the desk approves it");
  assert.equal((await setRequestStatus(world.bank, requestId, "FILLED")).ok, true);
  const late = await answerRequest(world.seller, { requestId, listingId: world.hidden.id });
  assert.equal(late.ok, false);
  assert.match(late.ok ? "" : late.error, /no longer open/);
});

test("the desk sees every request named, and closes one with a reason it audits", async () => {
  const requestId = await post(world.third, { title: `Desk closes ${tag}` });
  const { requests, counts } = await deskRequests();
  const row = requests.find((one) => one.id === requestId)!;
  assert.equal(row.buyer.email, world.third.email, "the desk sees who posted it");
  assert.equal(row.buyerType, "Private buyer");
  assert.ok(counts.open >= 1);
  assert.equal((await deskCloseRequest(world.desk, { requestId, reason: "x" })).ok, false, "a reason is required");
  const closed = await deskCloseRequest(world.desk, { requestId, reason: `Duplicate of another request ${tag}` });
  assert.ok(closed.ok);
  assert.equal((await prisma.buyerRequest.findUniqueOrThrow({ where: { id: requestId } })).status, "CLOSED");
  const event = await prisma.auditEvent.findFirst({ where: { entityType: "buyerRequest", entityId: requestId, action: "BUYER_REQUEST_DESK_CLOSED" } });
  assert.equal(event?.actorId, world.desk.id);
  assert.match(event?.detail ?? "", /Duplicate/);
  assert.ok(await prisma.notification.findFirst({ where: { toEmail: world.third.email, subject: { contains: "Request closed" } } }));
  assert.match((await buyerRequests(world.third.id)).find((one) => one.id === requestId)?.deskReason ?? "", /Duplicate/);
  assert.equal((await deskCloseRequest(world.desk, { requestId, reason: "Again" })).ok, false);
  assert.equal(await boardRequest(world.seller, requestId), null);
});

test("the public counts hold back any cell from fewer than three firms", async () => {
  const two = requestCounts([
    { firm: "a", liens: ["FIRST"], statuses: ["PERFORMING"] },
    { firm: "a", liens: ["FIRST"], statuses: [] },
    { firm: "b", liens: [], statuses: ["NON_PERFORMING"] },
  ]);
  assert.equal(MIN_FIRMS, 3);
  assert.equal(two.total, null, "two firms show nothing, however many requests they have");
  assert.ok(two.liens.every((cell) => cell.requests == null));
  const three = requestCounts([
    { firm: "a", liens: ["FIRST"], statuses: ["PERFORMING"] },
    { firm: "a", liens: ["FIRST"], statuses: ["PERFORMING"] },
    { firm: "b", liens: [], statuses: ["PERFORMING"] },
    { firm: "c", liens: ["FIRST", "SECOND"], statuses: [] },
  ]);
  assert.equal(three.total, 4);
  assert.equal(three.liens.find((cell) => cell.value === "FIRST")?.requests, 4, "a request with no lien named takes any");
  assert.equal(three.liens.find((cell) => cell.value === "SECOND")?.requests, null, "two firms take seconds, so it is withheld");
  assert.equal(three.statuses.find((cell) => cell.value === "PERFORMING")?.requests, 4);
  assert.equal(three.statuses.find((cell) => cell.value === "NON_PERFORMING")?.requests, null);
  // The loader reads only live requests from qualifying buyers, and says nothing else.
  const counts = await publicRequestCounts();
  assert.deepEqual(Object.keys(counts).sort(), ["liens", "statuses", "total"]);
  assert.ok(!JSON.stringify(counts).includes(tag));
});
