import assert from "node:assert/strict";
import test from "node:test";
import { navFor } from "../components/desk-nav";
import { mintKey, userForApiKey } from "../lib/api-keys";
import { askSeller, partAsked } from "../lib/awards";
import { paletteCommands } from "../lib/command-search";
import { literal } from "../lib/db-filters";
import { DESK_ROLES, deskPowers } from "../lib/desk-roles";
import { reminderMarker, sendDestructionReminder, certifyDestruction } from "../lib/destruction";
import { dispatchEmail, dispatchIssue, dispatchIssues, dispatchMonth, issueBlocks, issueKey, archiveIssue, linkParts, loadDispatch, sendMarketDispatch } from "../lib/dispatch";
import { escapeHtml, mailHtml, mailMessage, notify, sendSecret, setSmtpSender } from "../lib/email";
import { durationText, jobHistory, jobSummary, readJobSummary, remindDestruction, runJobList } from "../lib/jobs";
import { launchNow, moveLaunch, runLaunches } from "../lib/launch";
import { prisma } from "../lib/prisma";
import { ensureInquiryThread, notifyThread, threadWall, threadWalls, THREAD_WALLED, THREAD_WALLED_BOOK } from "../lib/threads";

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
// Mail stays in the log unless a test stubs a transport, whatever keys the local .env carries.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL", "EMAIL_FROM"]) process.env[key] = "";
process.env.AUTH_SECRET = "polish-test-secret-not-for-production-0001";
process.env.NEXT_PUBLIC_APP_URL = "https://desk.upb-polish.test";

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// Timestamp-tagged people and listings nothing seeded touches.

type Role = "INDIVIDUAL_SELLER" | "INSTITUTIONAL_SELLER" | "BUYER" | "ADMIN";

const loan = (index: number, tag: string) => ({
  streetAddress: `${index} Polish St`, city: `Polishville${tag}`, state: "ZZ", zip: "00000", propertyType: "SFR", occupancy: "VACANT",
  lienPosition: "FIRST", upb: 100000, interestRate: 7, monthlyPi: 700, paymentStatus: "PERFORMING", monthsDelinquent: 0,
  askingPrice: 60000, estimatedValue: 130000,
});

async function makeWorld() {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const users: { id: string; email: string }[] = [];
  const listingIds: string[] = [];
  const person = async (prefix: string, role: Role, extra: Record<string, unknown> = {}) => {
    const user = await prisma.user.create({
      data: { email: `polish-${prefix}-${tag}@example.org`, name: `${prefix} ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x", ...extra },
    });
    users.push(user);
    return user;
  };
  const listing = async (sellerId: string, data: Record<string, unknown> = {}, loans = 1) => {
    const made = await prisma.listing.create({
      data: {
        kind: loans > 1 ? "POOL" : "SINGLE",
        sellerId,
        status: "APPROVED",
        approvedAt: new Date(Date.now() - 10 * DAY),
        title: `Polish ${listingIds.length} ${tag}`,
        notes: { create: Array.from({ length: loans }, (_, index) => loan(index + 1, tag)) as never },
        ...data,
      },
      include: { notes: true },
    });
    listingIds.push(made.id);
    return made;
  };
  return { tag, users, listingIds, person, listing };
}

type World = Awaited<ReturnType<typeof makeWorld>>;

async function cleanWorld(world: World) {
  const userIds = world.users.map((user) => user.id);
  const listingIds = world.listingIds;
  const inquiries = await prisma.inquiry.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } });
  const inquiryIds = inquiries.map((row) => row.id);
  const ndas = await prisma.ndaAcknowledgment.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } });
  const threads = await prisma.deskThread.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } });
  const threadIds = threads.map((row) => row.id);
  await prisma.threadPost.deleteMany({ where: { threadId: { in: threadIds } } });
  await prisma.threadMember.deleteMany({ where: { threadId: { in: threadIds } } });
  await prisma.deskThread.deleteMany({ where: { id: { in: threadIds } } });
  await prisma.rateWindow.deleteMany({ where: { key: { in: ndas.map((nda) => reminderMarker(nda.id)) } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...listingIds, ...userIds, ...inquiryIds] } }, { actorId: { in: userIds } }] } });
  await prisma.reviewComment.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.favorite.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listingMatch.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.ndaAcknowledgment.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.offerMessage.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await prisma.inquiry.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.note.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.apiKey.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: world.users.map((user) => user.email) } }, { subject: { contains: literal(world.tag) } }] } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

// ---------------------------------------------------------------------------------------------------------------
// Branded HTML mail.

test("the HTML notice escapes the body, links its addresses and keeps the plain text as the alternative", () => {
  const body = [
    `Your bid <script>alert("x")</script> & "quotes" were seen.`,
    "Open the closing: https://desk.upb-polish.test/closings/abc?x=1&y=2.",
    "",
    "- First point",
    "- Second (see https://desk.upb-polish.test/market)",
  ].join("\n");
  const html = mailHtml(`Offer <b>accepted</b> · Test`, body);
  assert.ok(!html.includes("<script>"), "no markup from the body survives");
  assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;quotes&quot;"));
  assert.ok(html.includes("<title>Offer &lt;b&gt;accepted&lt;/b&gt; · Test</title>"));
  // The address is a link; the full stop after it isn't part of it.
  assert.match(html, /<a href="https:\/\/desk\.upb-polish\.test\/closings\/abc\?x=1&amp;y=2" [^>]*>https:\/\/desk\.upb-polish\.test\/closings\/abc\?x=1&amp;y=2<\/a>\./);
  assert.match(html, /\(see <a href="https:\/\/desk\.upb-polish\.test\/market" [^>]*>https:\/\/desk\.upb-polish\.test\/market<\/a>\)/);
  // A run of "- " lines is a list, and lines in one paragraph keep their break.
  assert.match(html, /<ul [^>]*><li [^>]*>First point<\/li><li [^>]*>Second/);
  assert.match(html, /were seen\.<br>Open the closing/);
  // The wordmark is text, the page names its language, and dark mail clients get their own colours.
  assert.match(html, /<html lang="en">/);
  assert.match(html, />UPB Capital<\/td>/);
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.match(html, /\[data-ogsc\] \.upb-body/);
  assert.match(html, /href="https:\/\/desk\.upb-polish\.test\/account\/notifications"/);
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");

  // Categorized mail carries the unsubscribe link in both versions; transactional mail in neither.
  const watched = mailMessage("Watched", "A new price.", { category: "watch", userId: "user123" });
  assert.match(watched.text, /^A new price\.\n\nTo stop notices about listings you saved, open https:\/\/desk\.upb-polish\.test\/unsubscribe\?token=/);
  assert.match(watched.html ?? "", /To stop notices about listings you saved, <a href="https:\/\/desk\.upb-polish\.test\/unsubscribe\?token=user123\.watch\.all\.[^"]+"[^>]*>open the unsubscribe page<\/a>\./);
  assert.match(watched.headers["List-Unsubscribe"], /one-click/);
  const plain = mailMessage("Plain", "Your closing moved.");
  assert.equal(plain.text, "Your closing moved.");
  assert.doesNotMatch(plain.html ?? "", /unsubscribe/);
  assert.deepEqual(plain.headers, {});
});

test("attachments go to Resend as base64 and to SMTP as bytes, and the in-app copy keeps none", async () => {
  const world = await makeWorld();
  const realFetch = globalThis.fetch;
  const resend: Record<string, unknown>[] = [];
  const smtp: Record<string, unknown>[] = [];
  const pdf = Buffer.from(`%PDF-1.4 polish ${world.tag}`);
  const attachments = [{ filename: "certificate.pdf", content: pdf, contentType: "application/pdf" }];
  try {
    // A deliverable address, sent through stubbed transports so nothing leaves the machine.
    const user = await prisma.user.create({ data: { email: `polish-mail-${world.tag}@upb-polish-mail.com`, name: `Mail ${world.tag}`, role: "BUYER", accountStatus: "APPROVED", passwordHash: "x" } });
    world.users.push(user);
    process.env.EMAIL_FROM = "UPB Capital <desk@upb-polish-mail.com>";
    process.env.RESEND_API_KEY = "re_test_stub";
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      resend.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await notify(user.email, `Certificate ${world.tag}`, "Your certificate is attached.\n\nIt stays at https://desk.upb-polish.test/api/destruction/x", { attachments });
    await notify(user.email, `Watched ${world.tag}`, "A new price.", { category: "watch", userId: user.id });
    await sendSecret(user.email, `Code ${world.tag}`, "Your code is 123456.");
    assert.equal(resend.length, 3);
    const [certificate, watched, secret] = resend as { text: string; html?: string; headers?: Record<string, string>; attachments?: { filename: string; content: string; content_type: string }[] }[];
    assert.equal(certificate.text, "Your certificate is attached.\n\nIt stays at https://desk.upb-polish.test/api/destruction/x");
    assert.match(certificate.html ?? "", /<a href="https:\/\/desk\.upb-polish\.test\/api\/destruction\/x"/);
    assert.deepEqual(certificate.attachments, [{ filename: "certificate.pdf", content: pdf.toString("base64"), content_type: "application/pdf" }]);
    assert.equal(certificate.headers, undefined);
    assert.match(watched.html ?? "", /open the unsubscribe page/);
    assert.match(watched.headers?.["List-Unsubscribe"] ?? "", /^<https:\/\/desk\.upb-polish\.test\/unsubscribe\/one-click\?token=/);
    assert.equal(watched.attachments, undefined);
    // A code stays plain text.
    assert.equal(secret.html, undefined);
    assert.equal(secret.text, "Your code is 123456.");

    // SMTP gets the same message through nodemailer's shape.
    process.env.RESEND_API_KEY = "";
    process.env.SMTP_HOST = "smtp.upb-polish.test";
    setSmtpSender(async (mail) => {
      smtp.push(mail);
      return {};
    });
    await notify(user.email, `Statement ${world.tag}`, "Your statement is attached.", { attachments });
    assert.equal(smtp.length, 1);
    const mail = smtp[0] as { to: string; text: string; html: string; attachments: { filename: string; content: Buffer; contentType: string }[] };
    assert.equal(mail.to, user.email);
    assert.equal(mail.text, "Your statement is attached.");
    assert.match(mail.html, /<p class="upb-body"[^>]*>Your statement is attached\.<\/p>/);
    assert.equal(mail.attachments[0].filename, "certificate.pdf");
    assert.equal(mail.attachments[0].contentType, "application/pdf");
    assert.ok(Buffer.isBuffer(mail.attachments[0].content) && mail.attachments[0].content.equals(pdf));

    // The in-app copies are the bodies as written, with no file bytes.
    const copies = await prisma.notification.findMany({ where: { toEmail: user.email } });
    const copy = copies.find((row) => row.subject === `Certificate ${world.tag}`);
    assert.equal(copy?.body, "Your certificate is attached.\n\nIt stays at https://desk.upb-polish.test/api/destruction/x");
    assert.equal(copy?.delivery, "resend");
    assert.equal(copies.find((row) => row.subject === `Statement ${world.tag}`)?.delivery, "smtp");
    assert.ok(!copies.some((row) => row.body.includes(pdf.toString("base64"))));
    assert.ok(!copies.some((row) => row.subject === `Code ${world.tag}`), "a code keeps no copy");
  } finally {
    globalThis.fetch = realFetch;
    setSmtpSender(null);
    process.env.RESEND_API_KEY = "";
    process.env.SMTP_HOST = "";
    process.env.EMAIL_FROM = "";
    await cleanWorld(world);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The desk's wall on the inbox, and the palette by role.

test("a trader's inbox holds back an offer thread on a sealed listing, and the thread never mails them", async () => {
  const world = await makeWorld();
  try {
    const seller = await world.person("seller", "INDIVIDUAL_SELLER");
    const buyer = await world.person("buyer", "BUYER");
    const trader = await world.person("trader", "ADMIN", { deskRole: "TRADER" });
    const sales = await world.person("sales", "ADMIN", { deskRole: "SALES" });
    const analyst = await world.person("analyst", "ADMIN", { deskRole: "ANALYST" });
    const sealed = await world.listing(seller.id, { bidMode: "SEALED", bidDeadline: new Date(Date.now() + 3 * DAY) });
    const open = await world.listing(seller.id);
    const bid = await prisma.inquiry.create({ data: { listingId: sealed.id, buyerId: buyer.id, type: "OFFER", amount: 90000, message: `I bid $90,000 ${world.tag}`, status: "OPEN" } });
    const question = await prisma.inquiry.create({ data: { listingId: sealed.id, buyerId: buyer.id, type: "INFO_REQUEST", message: `A question ${world.tag}`, status: "OPEN" } });
    const openBid = await prisma.inquiry.create({ data: { listingId: open.id, buyerId: buyer.id, type: "OFFER", amount: 80000, status: "OPEN" } });
    const [bidThread, questionThread, openThread] = await Promise.all([bid, question, openBid].map((row) => ensureInquiryThread(row.id)));
    assert.ok(bidThread && questionThread && openThread);
    const threads = [bidThread, questionThread, openThread];

    const walls = await threadWalls(trader, threads);
    assert.equal(walls.get(bidThread.id), THREAD_WALLED);
    assert.equal(walls.size, 1, "a question and an open listing's offer stay readable");
    assert.equal((await threadWalls(analyst, threads)).get(bidThread.id), THREAD_WALLED);
    assert.equal((await threadWalls(sales, threads)).size, 0, "sales reads sealed bids");
    assert.equal(await threadWall(buyer, bidThread), null, "the wall is the desk's, not the bidder's");
    assert.equal(THREAD_WALLED, "This thread is hidden from your desk role until the deadline.");

    // A trader seated on the thread before (say, by opening it) hears nothing of a post that quotes the amount.
    await prisma.threadMember.createMany({ data: [{ threadId: bidThread.id, userId: trader.id }, { threadId: bidThread.id, userId: sales.id }] });
    await notifyThread(bidThread.id, buyer.id, `Raising to $95,000 ${world.tag}`);
    assert.equal(await prisma.notification.count({ where: { toEmail: trader.email, body: { contains: literal(world.tag) } } }), 0);
    assert.equal(await prisma.notification.count({ where: { toEmail: sales.email, body: { contains: literal(world.tag) } } }), 1);

    // After the deadline a read-only seat reads it, but the desk book's buyer waits until the listing leaves the market.
    await prisma.listing.update({ where: { id: sealed.id }, data: { bidDeadline: new Date(Date.now() - MINUTE) } });
    assert.equal(await threadWall(trader, bidThread), THREAD_WALLED_BOOK);
    assert.equal(await threadWall(analyst, bidThread), null);
    await prisma.listing.update({ where: { id: sealed.id }, data: { status: "SOLD" } });
    assert.equal(await threadWall(trader, bidThread), null);
  } finally {
    await cleanWorld(world);
  }
});

test("the palette lists the same desk pages as the sidebar for each desk role", () => {
  const base = { subscriptionTier: "FREE" as const, subscriptionStatus: "INCOMPLETE" as const, subscriptionCurrentPeriodEnd: null };
  const pagesOf = (deskRole: string | null) =>
    paletteCommands({ ...base, role: "ADMIN", deskRole }).commands.filter((item) => item.group === "Pages").map((item) => item.href);
  const account = ["/account/notifications", "/account/security"];
  for (const role of DESK_ROLES) {
    const sidebar = navFor({ role: "ADMIN", name: "", email: "", tier: "", unread: 0, can: deskPowers({ role: "ADMIN", deskRole: role }) }).map((item) => item.href);
    assert.deepEqual(pagesOf(role), [...sidebar, ...account], role);
  }
  const trader = pagesOf("TRADER");
  assert.ok(!trader.includes("/admin/assistant") && !trader.includes("/seller/api"), "a trader's palette leaves out the pages that only write");
  assert.ok(trader.includes("/admin/jobs") && trader.includes("/admin/book"));
  const owner = pagesOf(null);
  assert.ok(owner.includes("/admin/assistant") && owner.includes("/seller/api") && owner.includes("/admin/jobs"));
  // Listing paper is for the sales side, so the trader's palette has no listing actions either.
  const actions = (deskRole: string | null) => paletteCommands({ ...base, role: "ADMIN", deskRole }).commands.filter((item) => item.group === "Actions").map((item) => item.id);
  assert.ok(!actions("TRADER").includes("action:new-note") && !actions("TRADER").includes("action:tape"));
  assert.ok(actions("SALES").includes("action:tape"));
  assert.ok(actions("TRADER").includes("action:desk-search"));
  // Other roles are unchanged.
  assert.ok(paletteCommands({ ...base, role: "INSTITUTIONAL_SELLER" }).commands.some((item) => item.id === "action:tape"));
});

// ---------------------------------------------------------------------------------------------------------------
// Moving and cancelling a launch.

const utcInput = (at: Date) => at.toISOString().slice(0, 16);

test("the desk moves a coming-soon launch within the approval limits, or puts it live now", async () => {
  const world = await makeWorld();
  try {
    const seller = await world.person("seller", "INDIVIDUAL_SELLER");
    const watcher = await world.person("watcher", "BUYER");
    const desk = await world.person("desk", "ADMIN", { deskRole: "SALES" });
    const now = new Date();
    const first = new Date(Math.floor((now.getTime() + 5 * DAY) / MINUTE) * MINUTE);
    const listing = await world.listing(seller.id, { approvedAt: first, launchAt: first });
    await prisma.favorite.create({ data: { userId: watcher.id, listingId: listing.id } });
    const move = (launchAt: string) => moveLaunch({ listingId: listing.id, actorId: desk.id, launchAt }, now);

    assert.equal((await move("")).error, "Enter the new launch time.");
    assert.match((await move(utcInput(new Date(now.getTime() - DAY)))).error ?? "", /in the future/);
    assert.match((await move(utcInput(new Date(now.getTime() + 120 * DAY)))).error ?? "", /within 90 days/);
    assert.equal((await move(utcInput(first))).error, "That is already the launch time.");

    const later = new Date(first.getTime() + 3 * DAY);
    const moved = await move(utcInput(later));
    assert.equal(moved.error, null);
    const row = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.equal(row.launchAt?.getTime(), later.getTime());
    assert.equal(row.approvedAt?.getTime(), later.getTime(), "early access counts from the new launch");
    assert.ok(await prisma.auditEvent.findFirst({ where: { action: "LAUNCH_MOVED", entityId: listing.id, actorId: desk.id } }));
    const heard = await prisma.notification.findFirst({ where: { toEmail: watcher.email, subject: `New launch date · ${listing.title}` } });
    assert.match(heard?.body ?? "", /now goes live on/);
    assert.ok(await prisma.notification.findFirst({ where: { toEmail: seller.email, subject: `Launch moved · ${listing.title}` } }));
    // The job doesn't launch it at the old time.
    assert.equal((await runLaunches(new Date(first.getTime() + MINUTE), { listingIds: [listing.id] })).sent, 0);

    // Going live now runs the launch's own work once, so the job finds nothing left.
    const live = await launchNow({ listingId: listing.id, actorId: desk.id }, now);
    assert.deepEqual(live, { error: null, launched: true });
    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.ok(after.launchNotifiedAt);
    assert.ok(after.launchAt && after.launchAt.getTime() <= Date.now());
    assert.ok(await prisma.notification.findFirst({ where: { toEmail: watcher.email, subject: `Now live · ${listing.title}` } }));
    assert.ok(await prisma.auditEvent.findFirst({ where: { action: "LAUNCH_NOW", entityId: listing.id } }));
    assert.equal((await runLaunches(new Date(), { listingIds: [listing.id] })).sent, 0);
    assert.match((await launchNow({ listingId: listing.id, actorId: desk.id })).error ?? "", /isn't coming soon/);
    assert.match((await move(utcInput(later))).error ?? "", /isn't coming soon/);
  } finally {
    await cleanWorld(world);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The dispatch archive.

test("each monthly dispatch files an archive row with its subject and body", async () => {
  const world = await makeWorld();
  const settingsId = `polish-dispatch-${world.tag}`;
  // A month long before UPB, so the row can't be a real issue's.
  const realMonth = `1999-0${(Date.now() % 9) + 1}`;
  await prisma.platformSettings.create({ data: { id: settingsId } });
  try {
    const reader = await world.person("reader", "BUYER", { marketDispatch: true });
    const now = new Date();
    const sent = await sendMarketDispatch(now, { settingsId, userIds: [reader.id] });
    assert.equal(sent.claimed, true);
    const issue = await prisma.dispatchIssue.findUniqueOrThrow({ where: { month: issueKey(dispatchMonth(now), settingsId) } });
    const email = dispatchEmail(await loadDispatch(now));
    assert.equal(issue.subject, email.subject);
    assert.match(issue.body, /^UPB Capital note-market dispatch, /);
    assert.match(issue.body, /second-highest bid/);
    // A scoped run never stands in for the real month in the archive.
    assert.ok(!(await dispatchIssues(500)).some((row) => row.month.includes(":")));
    assert.equal(await dispatchIssue(issue.month), null);

    await archiveIssue({ month: realMonth, subject: `Archive ${world.tag}`, body: `UPB Capital note-market dispatch\n\n- One line\n- See https://desk.upb-polish.test/market.\n\nLast line.` });
    const found = await dispatchIssue(realMonth);
    assert.equal(found?.subject, `Archive ${world.tag}`);
    assert.match(found?.title ?? "", /1999$/);
    assert.ok((await dispatchIssues(500)).some((row) => row.month === realMonth));
    assert.equal(await dispatchIssue("1999-13"), null);
    assert.equal(await dispatchIssue("../x"), null);
    const blocks = issueBlocks(found!.body);
    assert.deepEqual(blocks.map((block) => block.kind), ["text", "list", "text"]);
    assert.deepEqual(linkParts("See https://desk.upb-polish.test/market."), [{ text: "See " }, { text: "https://desk.upb-polish.test/market", href: "https://desk.upb-polish.test/market" }, { text: "." }]);
  } finally {
    await prisma.dispatchIssue.deleteMany({ where: { OR: [{ month: { startsWith: `${settingsId}:` } }, { month: realMonth, subject: `Archive ${world.tag}` }] } });
    await prisma.auditEvent.deleteMany({ where: { entityId: settingsId } });
    await prisma.platformSettings.deleteMany({ where: { id: settingsId } });
    await cleanWorld(world);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Job history and API key use.

test("the job history reads the structured summary, old sentence summaries and how long each run took", async () => {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const legacy = readJobSummary(`Digests 3. Bid expiry failed: boom ${tag}. Partial 2, 1 failed (item 2: bad item). Closed auctions checked.`);
  assert.deepEqual(legacy.jobs.map((job) => [job.job, job.ok]), [["Digests", true], ["Bid expiry", false], ["Partial", false], ["Closed auctions checked", true]]);
  assert.deepEqual(legacy.failed, ["Bid expiry", "Partial"]);
  assert.deepEqual(readJobSummary(""), { text: "", jobs: [], failed: [] });
  const round = readJobSummary(jobSummary([{ job: "Works", ok: true, line: "Works 2.", ms: 12 }, { job: "Breaks", ok: false, line: "Breaks failed: x." }]));
  assert.equal(round.text, "Works 2. Breaks failed: x.");
  assert.deepEqual(round.failed, ["Breaks"]);
  assert.equal(round.jobs[0].ms, 12);
  assert.equal(durationText(null), "Didn't finish");
  assert.equal(durationText(400), "Under a second");
  assert.equal(durationText(42_000), "42 seconds");
  assert.equal(durationText(125_000), "2 min 5 s");

  const result = await runJobList([
    ["Works", async () => ({ sent: 2, failed: 0, error: "" })],
    ["Breaks", async () => {
      throw new Error(`boom ${tag}`);
    }],
  ]);
  try {
    // The run's own answer is the sentence, as before; the record holds the structure.
    assert.match(result.summary, new RegExp(`Works 2\\. Breaks failed: boom ${tag}\\.`));
    const row = await prisma.jobRun.findFirstOrThrow({ where: { summary: { contains: `boom ${tag}` } } });
    const parsed = readJobSummary(row.summary);
    assert.equal(parsed.text, result.summary);
    assert.deepEqual(parsed.failed, ["Breaks"]);
    assert.ok(parsed.jobs.every((job) => typeof job.ms === "number"));
    const shown = (await jobHistory(50)).find((run) => run.id === row.id);
    assert.ok(shown?.failed);
    assert.ok(shown.durationMs != null && shown.durationMs >= 0);
  } finally {
    await prisma.jobRun.deleteMany({ where: { summary: { contains: `boom ${tag}` } } });
  }
});

test("an API key records when it was last used, to the minute", async () => {
  const world = await makeWorld();
  try {
    const seller = await world.person("api", "INSTITUTIONAL_SELLER");
    const minted = mintKey();
    const key = await prisma.apiKey.create({ data: { userId: seller.id, name: "Polish", prefix: minted.prefix, hash: minted.hash } });
    assert.equal(key.lastUsedAt ?? null, null);
    const now = new Date();
    assert.equal((await userForApiKey(`Bearer ${minted.token}`, now))?.id, seller.id);
    const lastUsed = async () => (await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } })).lastUsedAt?.getTime();
    assert.equal(await lastUsed(), now.getTime());
    // A busy key writes once a minute.
    await userForApiKey(`Bearer ${minted.token}`, new Date(now.getTime() + 30 * 1000));
    assert.equal(await lastUsed(), now.getTime());
    const later = new Date(now.getTime() + 2 * MINUTE);
    await userForApiKey(`Bearer ${minted.token}`, later);
    assert.equal(await lastUsed(), later.getTime());
    // A key on a locked account answers nothing and records nothing.
    await prisma.user.update({ where: { id: seller.id }, data: { accountStatus: "SUSPENDED" } });
    assert.equal(await userForApiKey(`Bearer ${minted.token}`, new Date(now.getTime() + 10 * MINUTE)), null);
    assert.equal(await lastUsed(), later.getTime());
    assert.equal(await userForApiKey("Bearer upb_not-a-key"), null);
  } finally {
    await cleanWorld(world);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The two workarounds, on their real fields.

test("destruction reminders claim destroyRemindedAt, and a reminder sent under the old marker isn't sent again", async (t) => {
  const world = await makeWorld();
  const logged: string[] = [];
  t.mock.method(console, "info", (line: unknown) => {
    logged.push(String(line));
  });
  try {
    const seller = await world.person("seller", "INDIVIDUAL_SELLER");
    const [old, fresh, raced] = await Promise.all(["old", "fresh", "raced"].map((name) => world.person(name, "BUYER")));
    const listing = await world.listing(seller.id, { status: "PENDING" });
    const now = new Date();
    const asked = new Date(now.getTime() - 8 * DAY);
    const nda = (userId: string) => prisma.ndaAcknowledgment.create({ data: { userId, listingId: listing.id, signerName: `signer ${world.tag}`, destroyRequestedAt: asked } });
    const [oldNda, freshNda, racedNda] = await Promise.all([nda(old.id), nda(fresh.id), nda(raced.id)]);
    // Reminded two days ago under the old claim: the marker row expires 400 days after it was written.
    const remindedAt = new Date(now.getTime() - 2 * DAY);
    await prisma.rateWindow.create({ data: { key: reminderMarker(oldNda.id), count: 1, expiresAt: new Date(remindedAt.getTime() + 400 * DAY) } });

    // Two runs at once remind the raced NDA once.
    const target = { id: racedNda.id, userId: raced.id, listingId: listing.id, user: { email: raced.email, name: raced.email }, listing: { title: listing.title } };
    const both = await Promise.all([sendDestructionReminder(target, now), sendDestructionReminder(target, now)]);
    assert.deepEqual(both.sort(), [false, true]);

    const run = await remindDestruction(now, { listingIds: [listing.id] });
    assert.deepEqual(run, { sent: 1, failed: 0, error: "" });
    const rows = new Map((await prisma.ndaAcknowledgment.findMany({ where: { listingId: listing.id } })).map((row) => [row.id, row]));
    assert.equal(rows.get(freshNda.id)?.destroyRemindedAt?.getTime(), now.getTime());
    assert.equal(rows.get(oldNda.id)?.destroyRemindedAt?.getTime(), remindedAt.getTime(), "the old reminder's date is carried onto the field");
    const subject = `Reminder: destroy the data room files · ${listing.title}`;
    assert.equal(await prisma.notification.count({ where: { toEmail: old.email, subject } }), 0);
    assert.equal(await prisma.notification.count({ where: { toEmail: fresh.email, subject } }), 1);
    assert.equal(await prisma.notification.count({ where: { toEmail: raced.email, subject } }), 1);
    assert.equal((await remindDestruction(new Date(now.getTime() + DAY), { listingIds: [listing.id] })).sent, 0, "reminded once");

    // The certificate goes to the bidder and the seller as a PDF attached, as well as linked.
    assert.deepEqual(await certifyDestruction({ ndaId: freshNda.id, userId: fresh.id }), { ok: true });
    const file = `attachments=destruction-certificate-${freshNda.id}.pdf`;
    assert.ok(logged.some((line) => line.includes(`to=${fresh.email}`) && line.includes(file)));
    assert.ok(logged.some((line) => line.includes(`to=${seller.email}`) && line.includes(file)));
    const copy = await prisma.notification.findFirstOrThrow({ where: { toEmail: seller.email, subject: `Destruction certificate · ${listing.title}` } });
    assert.match(copy.body, /^Bidder [A-Z]+ certified .* attached as a PDF, and stays at https:\/\/desk\.upb-polish\.test\/api\/destruction\//);
  } finally {
    await cleanWorld(world);
  }
});

test("a part-pool ask is read from sellerAskedNoteIds, and an ask recorded before the field from its audit event", async () => {
  const world = await makeWorld();
  try {
    const seller = await world.person("seller", "INSTITUTIONAL_SELLER");
    const buyer = await world.person("buyer", "BUYER");
    const desk = await world.person("desk", "ADMIN", { deskRole: "SALES" });
    const pool = await world.listing(seller.id, {}, 3);
    const [a, b, c] = pool.notes;
    const bid = await prisma.inquiry.create({
      data: { listingId: pool.id, buyerId: buyer.id, type: "OFFER", amount: 100000, status: "OPEN", loanPrices: { [a.id]: 50000, [b.id]: 30000, [c.id]: 20000 }, allowPartial: true },
    });
    const offer = await prisma.inquiry.findUniqueOrThrow({ where: { id: bid.id }, include: { buyer: true, listing: { include: { seller: true } } } });
    await askSeller(offer as never, 80000, { noteIds: [a.id, b.id], actorId: desk.id });
    const asked = await prisma.inquiry.findUniqueOrThrow({ where: { id: bid.id } });
    assert.deepEqual([...asked.sellerAskedNoteIds].sort(), [a.id, b.id].sort());
    // The field answers on its own, with the audit record gone.
    await prisma.auditEvent.deleteMany({ where: { entityId: bid.id, action: "SELLER_ASKED_PART" } });
    assert.deepEqual((await partAsked(asked))?.sort(), [a.id, b.id].sort());
    // A question about the whole bid clears it.
    await askSeller(offer as never, 100000);
    const whole = await prisma.inquiry.findUniqueOrThrow({ where: { id: bid.id } });
    assert.deepEqual(whole.sellerAskedNoteIds, []);
    assert.equal(await partAsked(whole), null);

    // An ask from before the field: the loans are in the audit event keyed to the moment of the question.
    const at = new Date(Date.now() - DAY);
    const before = await prisma.inquiry.create({ data: { listingId: pool.id, buyerId: buyer.id, type: "OFFER", amount: 90000, status: "OPEN", sellerAskedAt: at, sellerAskedAmount: 70000 } });
    await prisma.auditEvent.create({ data: { actorId: desk.id, action: "SELLER_ASKED_PART", entityType: "inquiry", entityId: before.id, detail: `asked ${at.toISOString()} · 2 loans · ${a.id},${c.id}` } });
    assert.deepEqual(await partAsked(before), [a.id, c.id]);
    // An event for an earlier question doesn't answer for a later one.
    assert.equal(await partAsked({ ...before, sellerAskedAt: new Date(at.getTime() + MINUTE) }), null);
  } finally {
    await cleanWorld(world);
  }
});
