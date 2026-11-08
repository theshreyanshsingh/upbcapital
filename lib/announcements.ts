import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { audit } from "@/lib/audit";
import { appOrigin } from "@/lib/billing";
import { unset } from "@/lib/db-filters";
import { escapeHtml, mailHtml, mailMessage, sendListMail, type MailMessage } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { liveCards, type IndexCard } from "@/lib/public-index";
import { unsubscribeLinks, unsubscribeParts } from "@/lib/unsubscribe";

// The deal-announcement list: members who turned it on under Notices (User.announcements), and people without an
// account who signed up on /announcements and confirmed from the email (Subscriber). The desk sends live public
// listings to it and sees how many opened and clicked. Opens and clicks are kept against a keyed hash of the address,
// never the address, and each reader counts once per kind.

const DAY = 24 * 60 * 60 * 1000;
const ID = /^[\w-]{1,64}$/;
const TOKEN = /^[\w-]{20,64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const MAX_ANNOUNCE_LISTINGS = 12;

export function siteOrigin() {
  return appOrigin().replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------------------------------------------
// Subscribers, with double opt-in

export function readSubscriberEmail(raw: string) {
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

export function newListToken() {
  return randomBytes(24).toString("base64url");
}

// The confirmation and leave links carry the subscriber's own token. Opening either shows a button, so a mail scanner
// that follows links neither confirms nor removes anyone. The one-click link takes a mail client's RFC 8058 POST.
export function listLinks(token: string, origin = siteOrigin()) {
  const query = `token=${encodeURIComponent(token)}`;
  return {
    confirm: `${origin}/announcements/confirm?${query}`,
    leave: `${origin}/announcements/leave?${query}`,
    oneClick: `${origin}/announcements/leave/one-click?${query}`,
  };
}

export function confirmationEmail(token: string, origin = siteOrigin()) {
  const links = listLinks(token, origin);
  const body = [
    "Someone, we hope you, asked for UPB Capital's deal announcements at this address.",
    `Confirm it here: ${links.confirm}`,
    "If it wasn't you, ignore this email. Nothing more is sent until the address is confirmed.",
  ].join("\n\n");
  return mailMessage("Confirm the UPB deal list", body);
}

// Signing up only ever sends the confirmation. The answer is the same whatever the address's state, so the form
// tells nobody who is on the list. An address already confirmed gets nothing.
export async function subscribe(input: { email: string; name?: string; source?: string }) {
  const email = readSubscriberEmail(input.email);
  if (!email) return { error: "Enter a valid email address.", sent: false } as const;
  const name = (input.name ?? "").trim().slice(0, 120);
  const source = (input.source ?? "").trim().slice(0, 40) || "PUBLIC";
  let row = await prisma.subscriber.findUnique({ where: { email } });
  if (row?.confirmedAt && !row.unsubscribedAt) return { error: null, sent: false } as const;
  if (!row) {
    try {
      row = await prisma.subscriber.create({ data: { email, name, source, token: newListToken() } });
    } catch (error) {
      // Two sign-ups at once: the other one made the row.
      row = await prisma.subscriber.findUnique({ where: { email } });
      if (!row) throw error;
    }
  } else if (row.unsubscribedAt) {
    // Coming back after leaving takes a fresh confirmation.
    row = await prisma.subscriber.update({ where: { id: row.id }, data: { confirmedAt: null, unsubscribedAt: null, ...(name ? { name } : {}) } });
  }
  const sent = await sendListMail(email, confirmationEmail(row.token));
  return { error: null, sent } as const;
}

// What the confirm and leave pages show. The address is masked, in case the link was forwarded.
export async function subscriberByToken(token: string | null | undefined) {
  const text = (token ?? "").trim();
  if (!TOKEN.test(text)) return null;
  const row = await prisma.subscriber.findUnique({ where: { token: text } });
  if (!row) return null;
  return { email: maskEmail(row.email), confirmed: Boolean(row.confirmedAt), left: Boolean(row.unsubscribedAt) };
}

export function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}${"•".repeat(Math.min(Math.max(local.length - 1, 1), 6))}@${domain ?? ""}`;
}

export async function confirmSubscriber(token: string, now = new Date()) {
  if (!TOKEN.test(token)) return false;
  const { count } = await prisma.subscriber.updateMany({ where: { token }, data: { confirmedAt: now, unsubscribedAt: null } });
  return count === 1;
}

// Leaving is one write. A token that matches no one counts as done and says nothing about whether it existed.
export async function leaveList(token: string, now = new Date()) {
  if (!TOKEN.test(token)) return false;
  const row = await prisma.subscriber.findUnique({ where: { token }, select: { id: true, unsubscribedAt: true } });
  if (!row) return false;
  if (!row.unsubscribedAt) await prisma.subscriber.update({ where: { id: row.id }, data: { unsubscribedAt: now } });
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Who gets an announcement

export type Recipient = { email: string; kind: "member"; userId: string } | { email: string; kind: "subscriber"; token: string };

// Approved members who turned the list on, with email on, and confirmed subscribers who haven't left. When a
// subscriber's address has an account, the account decides: it is mailed as a member, or not at all if the member
// turned the list or email off. scope.emails limits a test run to its own people.
export async function announcementRecipients(scope: { emails?: string[] } = {}): Promise<Recipient[]> {
  const only = scope.emails?.map((email) => email.trim().toLowerCase());
  const [members, subscribers] = await Promise.all([
    prisma.user.findMany({
      // A firm's seat reads the firm's mail, so it isn't a member of its own (lib/seats.ts).
      where: { announcements: true, notifyEmail: true, accountStatus: "APPROVED", AND: [unset("deletedAt"), unset("principalId")], ...(only ? { email: { in: only } } : {}) },
      select: { id: true, email: true },
    }),
    prisma.subscriber.findMany({
      where: { confirmedAt: { not: null }, ...unset("unsubscribedAt"), ...(only ? { email: { in: only } } : {}) },
      select: { email: true, token: true },
    }),
  ]);
  const recipients: Recipient[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    const email = member.email.trim().toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    recipients.push({ email, kind: "member", userId: member.id });
  }
  const accounts = subscribers.length
    ? await prisma.user.findMany({
        where: { email: { in: subscribers.map((row) => row.email) } },
        select: { email: true, announcements: true, notifyEmail: true, deletedAt: true },
      })
    : [];
  const byEmail = new Map(accounts.map((account) => [account.email.trim().toLowerCase(), account]));
  for (const subscriber of subscribers) {
    const email = subscriber.email.trim().toLowerCase();
    if (seen.has(email)) continue;
    const account = byEmail.get(email);
    if (account && !account.deletedAt && (account.announcements != null || account.notifyEmail === false)) continue;
    seen.add(email);
    recipients.push({ email, kind: "subscriber", token: subscriber.token });
  }
  return recipients;
}

export async function recipientCount() {
  const recipients = await announcementRecipients();
  const members = recipients.filter((recipient) => recipient.kind === "member").length;
  return { total: recipients.length, members, subscribers: recipients.length - members };
}

// ---------------------------------------------------------------------------------------------------------------
// Open and click tracking

function trackingKey() {
  return process.env.AUTH_SECRET || "";
}

// A one-way code for an address, keyed by the auth secret: the same reader always gets the same code, so they count
// once, and nobody without the secret can turn the code back into an address.
export function recipientHash(email: string, secret = trackingKey()) {
  return createHmac("sha256", secret).update(`upb-announce-recipient:${email.trim().toLowerCase()}`).digest("base64url");
}

export type TrackKind = "OPEN" | "CLICK";

function trackSig(payload: string, secret: string) {
  return createHmac("sha256", secret).update(`upb-announce-track:${payload}`).digest("base64url");
}

// The token in a pixel or link names the reader's code and signs it with the announcement, the kind and the target,
// so a made-up address can't add opens and a link can't be pointed somewhere else. Null without a secret.
export function trackToken(announcementId: string, recipient: string, kind: TrackKind, target = "") {
  const secret = trackingKey();
  if (!secret || !ID.test(announcementId)) return null;
  return `${recipient}.${trackSig(`${announcementId}.${recipient}.${kind}.${target}`, secret)}`;
}

export function readTrackToken(announcementId: string, token: string | null | undefined, kind: TrackKind, target = "") {
  const secret = trackingKey();
  const parts = (token ?? "").split(".");
  if (!secret || !ID.test(announcementId) || parts.length !== 2) return null;
  const [recipient, given] = parts;
  if (!/^[\w-]{43}$/.test(recipient)) return null;
  const expected = Buffer.from(trackSig(`${announcementId}.${recipient}.${kind}.${target}`, secret));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return recipient;
}

// The only places an announcement link may lead: the index, a listing's public page, and the sale events page, all
// on this site. Anything else, a full address included, is refused.
const TARGETS = [/^\/open$/, /^\/open\/[\w-]{1,64}$/, /^\/events$/];

export function trackTarget(raw: string | null | undefined) {
  const text = (raw ?? "").trim();
  return TARGETS.some((pattern) => pattern.test(text)) ? text : null;
}

export function clickUrl(announcementId: string, recipient: string, target: string, origin = siteOrigin()) {
  const token = trackToken(announcementId, recipient, "CLICK", target);
  if (!token) return `${origin}${target}`;
  return `${origin}/api/announcements/${announcementId}/click?to=${encodeURIComponent(target)}&t=${token}`;
}

export function openPixelUrl(announcementId: string, recipient: string, origin = siteOrigin()) {
  const token = trackToken(announcementId, recipient, "OPEN");
  return token ? `${origin}/api/announcements/${announcementId}/open?t=${token}` : null;
}

// One row per reader per kind. A second open or click from the same reader adds nothing; the counts below dedupe
// too, in case two arrive at once.
export async function recordEmailEvent(input: { announcementId: string; token: string | null | undefined; kind: TrackKind; target?: string }) {
  const target = input.target ?? "";
  const recipient = readTrackToken(input.announcementId, input.token, input.kind, target);
  if (!recipient) return false;
  const announcement = await prisma.announcement.findUnique({ where: { id: input.announcementId }, select: { id: true } });
  if (!announcement) return false;
  const seen = await prisma.emailEvent.findFirst({ where: { announcementId: announcement.id, recipient, kind: input.kind }, select: { id: true } });
  if (seen) return false;
  await prisma.emailEvent.create({ data: { announcementId: announcement.id, recipient, kind: input.kind, url: input.kind === "CLICK" ? target : null } });
  return true;
}

export function uniqueCounts(events: { recipient: string; kind: string }[]) {
  const opens = new Set<string>();
  const clicks = new Set<string>();
  for (const event of events) {
    if (event.kind === "OPEN") opens.add(event.recipient);
    if (event.kind === "CLICK") clicks.add(event.recipient);
  }
  return { opens: opens.size, clicks: clicks.size };
}

// Unique opens and clicks for each announcement named.
export async function announcementStats(ids: string[]) {
  const events = ids.length
    ? await prisma.emailEvent.findMany({ where: { announcementId: { in: ids } }, select: { announcementId: true, recipient: true, kind: true } })
    : [];
  return new Map(ids.map((id) => [id, uniqueCounts(events.filter((event) => event.announcementId === id))]));
}

// ---------------------------------------------------------------------------------------------------------------
// Writing and sending

export type AnnouncementDraft = { subject: string; body: string; listingIds: string[]; linkEvents: boolean };

export function readDraft(input: { subject: string; body: string; listingIds: string[]; linkEvents?: boolean }): { draft: AnnouncementDraft | null; error: string | null } {
  const subject = input.subject.replace(/\s+/g, " ").trim();
  const body = input.body.replace(/\r\n?/g, "\n").trim();
  const listingIds = [...new Set(input.listingIds.map((id) => id.trim()).filter(Boolean))];
  if (subject.length < 4 || subject.length > 140) return { draft: null, error: "Write a subject of 4 to 140 characters." };
  if (!body || body.length > 5000) return { draft: null, error: "Write a short note to go above the listings, up to 5,000 characters." };
  if (!listingIds.length) return { draft: null, error: "Pick at least one listing." };
  if (listingIds.length > MAX_ANNOUNCE_LISTINGS) return { draft: null, error: `Pick up to ${MAX_ANNOUNCE_LISTINGS} listings.` };
  if (listingIds.some((id) => !ID.test(id))) return { draft: null, error: "Pick the listings from the list." };
  return { draft: { subject, body, listingIds, linkEvents: Boolean(input.linkEvents) }, error: null };
}

export function newAnnouncementId() {
  return randomBytes(12).toString("hex");
}

export function cardLine(card: IndexCard) {
  const where = card.kind === "Pool" ? `Pool of ${card.loans} loans in ${card.states}` : `${card.city}, ${card.state}`;
  return `${where} · ${card.lien} lien, ${card.performance.toLowerCase()} · ${card.collateral} · UPB ${card.band}`;
}

// One reader's email. Every link goes through the click route, and the HTML carries the open pixel. A member leaves
// with the signed link on their account; a subscriber with their own token. Both get the List-Unsubscribe headers.
export function announcementEmail(input: {
  id: string;
  subject: string;
  body: string;
  cards: IndexCard[];
  linkEvents: boolean;
  recipient: Recipient;
  origin?: string;
}): MailMessage {
  const origin = input.origin ?? siteOrigin();
  const hash = recipientHash(input.recipient.email);
  const link = (target: string) => clickUrl(input.id, hash, target, origin);
  const main = [
    input.body,
    input.cards.map((card) => `- ${cardLine(card)}: ${link(`/open/${card.id}`)}`).join("\n"),
    [`Every live listing: ${link("/open")}`, ...(input.linkEvents ? [`Sale events: ${link("/events")}`] : [])].join("\n"),
    "You get this because you joined UPB Capital's deal list. Listings are anonymised; the street, borrower and price open on the desk.",
  ].join("\n\n");
  let footer = "";
  let headers: Record<string, string> = {};
  let unsubscribe: { text: string; href: string } | null = null;
  if (input.recipient.kind === "member") {
    const category = { category: "announcements" as const, userId: input.recipient.userId };
    const parts = unsubscribeParts(category, origin);
    const links = unsubscribeLinks(category, origin);
    if (parts && links) {
      footer = parts.footer;
      headers = parts.headers;
      unsubscribe = { text: "deal announcements", href: links.page };
    }
  } else {
    const links = listLinks(input.recipient.token, origin);
    footer = `To stop deal announcements, open ${links.leave}`;
    if (/^https?:\/\//.test(links.oneClick)) headers = { "List-Unsubscribe": `<${links.oneClick}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
    unsubscribe = { text: "deal announcements", href: links.leave };
  }
  const pixel = openPixelUrl(input.id, hash, origin);
  const html = mailHtml(input.subject, main, unsubscribe);
  const tracked = pixel
    ? html.replace("</body>", `<img src="${escapeHtml(pixel)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;">\n</body>`)
    : html;
  return { subject: input.subject, text: footer ? `${main}\n\n${footer}` : main, html: tracked, headers, attachments: [] };
}

export type SendResult = { error: string } | { error: null; id: string; sent: number; failed: number; already: boolean };

// How many emails are in flight at once. Enough for a list of a few thousand to finish inside a request, few enough
// to stay under a mail provider's rate limit.
export const SEND_CONCURRENCY = 8;

export type ListSender = (toEmail: string, message: MailMessage) => Promise<boolean>;

// Runs each item through at most `limit` workers at a time.
export async function eachLimited<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

// The failures of one send, kept as a named count beside the announcement, since its row holds only the sent count.
export function failedKey(announcementId: string) {
  return `announce-failed:${announcementId}`;
}

// Sends one announcement. The id comes from the compose page, so a second press of Send finds it taken and sends
// nothing. Every listing must still be live and public when it goes; a private or withdrawn one stops the send.
// One reader's failure, whether a refusal or a thrown error, is counted and the rest still go. send stands in for
// the mail module in a test.
export async function sendAnnouncement(input: {
  id: string;
  draft: AnnouncementDraft;
  sentById: string;
  now?: Date;
  scope?: { emails?: string[] };
  send?: ListSender;
}): Promise<SendResult> {
  const now = input.now ?? new Date();
  if (!/^[a-f0-9]{24}$/.test(input.id)) return { error: "Open the page again and resend." };
  const { draft } = input;
  const found = await liveCards(draft.listingIds, now, MAX_ANNOUNCE_LISTINGS);
  if (found.length !== draft.listingIds.length) return { error: "A listing you picked is no longer live and public. Pick again." };
  const cards = draft.listingIds.map((id) => found.find((card) => card.id === id)!);
  const recipients = await announcementRecipients(input.scope);
  if (!recipients.length) return { error: "Nobody is on the list yet." };
  const sentAlready = { error: null, id: input.id, sent: 0, failed: 0, already: true } as const;
  if (await prisma.announcement.findUnique({ where: { id: input.id }, select: { id: true } })) return sentAlready;
  try {
    await prisma.announcement.create({
      data: { id: input.id, subject: draft.subject, body: draft.body, listingIds: draft.listingIds, sentById: input.sentById, recipients: 0, sentAt: now },
    });
  } catch (error) {
    if (await prisma.announcement.findUnique({ where: { id: input.id }, select: { id: true } })) return sentAlready;
    throw error;
  }
  const send = input.send ?? sendListMail;
  let sent = 0;
  let failed = 0;
  await eachLimited(recipients, SEND_CONCURRENCY, async (recipient) => {
    try {
      const message = announcementEmail({ id: input.id, subject: draft.subject, body: draft.body, cards, linkEvents: draft.linkEvents, recipient });
      if (await send(recipient.email, message)) sent += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      console.error(`[upb-mail] announcement ${input.id} failed for one reader:`, error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : "unknown error");
    }
  });
  // The row counts only what went out.
  await prisma.announcement.update({ where: { id: input.id }, data: { recipients: sent } });
  if (failed) await prisma.counter.upsert({ where: { id: failedKey(input.id) }, create: { id: failedKey(input.id), value: failed }, update: { value: failed } });
  await audit(input.sentById, "ANNOUNCEMENT", "announcement", input.id, `${draft.subject}: ${cards.length} listing${cards.length === 1 ? "" : "s"} to ${sent} reader${sent === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}.`);
  return { error: null, id: input.id, sent, failed, already: false };
}

// The desk's history: each announcement with its reach, newest first.
export async function announcementHistory(take = 30, since = new Date(Date.now() - 365 * DAY)) {
  const rows = await prisma.announcement.findMany({ where: { sentAt: { gte: since } }, orderBy: { sentAt: "desc" }, take });
  const stats = await announcementStats(rows.map((row) => row.id));
  const senders = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.sentById))] } }, select: { id: true, name: true } });
  const failures = rows.length ? await prisma.counter.findMany({ where: { id: { in: rows.map((row) => failedKey(row.id)) } } }) : [];
  return rows.map((row) => ({
    ...row,
    sender: senders.find((sender) => sender.id === row.sentById)?.name ?? "The desk",
    failed: failures.find((counter) => counter.id === failedKey(row.id))?.value ?? 0,
    ...(stats.get(row.id) ?? { opens: 0, clicks: 0 }),
  }));
}
