import type { ChatChannel } from "@prisma/client";
import { buyerApiProblem, proLapse } from "@/lib/api-keys";
import { audit } from "@/lib/audit";
import { readIn } from "@/lib/bulk-read";
import { keptWithinLimit, OLDEST_FIRST, unset } from "@/lib/db-filters";
import { DESK_DENIED, deskCan, type DeskCapability, type Staff } from "@/lib/desk-roles";
import { notify, notifyDesk } from "@/lib/email";
import { money } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { pushLink, pushTitle } from "@/lib/push";
import { canManageSeats, personId, type ActingUser } from "@/lib/seats";
import { dollars } from "@/lib/target-alerts";
import { watchLink } from "@/lib/watchers";
import { BUYER_WEBHOOK_EVENTS, cleanEvents, endpointEvents, wantsEvent, type BuyerEvent } from "@/lib/webhooks";

// Short alerts in a Slack or Microsoft Teams channel. A Pro buyer firm picks the events a channel gets, the same
// events its webhooks can take plus a price alert being hit, and the desk keeps one channel for its own notices. A
// channel is anyone in it, so an alert says what happened and links into UPB: a buyer's says what the buyer's own
// email says, from public fields only, and the desk's carries the notice's event name alone, as a push does. Neither
// ever carries a borrower, a street, a sealed bid amount or another party's name. A send never throws into the
// action it rides on.

export const CHAT_KINDS = ["SLACK", "TEAMS"] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];
export const CHAT_KIND_LABELS: Record<ChatKind, string> = { SLACK: "Slack", TEAMS: "Microsoft Teams" };

export function isChatKind(value: unknown): value is ChatKind {
  return typeof value === "string" && (CHAT_KINDS as readonly string[]).includes(value);
}

export const PRICE_ALERT_EVENT = "price_alert.hit";
export type ChatBuyerEvent = BuyerEvent | typeof PRICE_ALERT_EVENT;

// What a buyer's channel can take: every buyer webhook event, and a price alert being hit (lib/target-alerts.ts).
export const CHAT_BUYER_EVENTS: readonly { event: ChatBuyerEvent; label: string }[] = [
  ...BUYER_WEBHOOK_EVENTS,
  { event: PRICE_ALERT_EVENT, label: "A price alert you set is hit" },
];

// The desk's channel gets every notice all desk members get. A notice that names a power (notifyDesk's capability)
// goes only when the channel has that power ticked, as it reaches only the desk members who hold it.
export const DESK_CHAT_POWERS: readonly { event: DeskCapability; label: string }[] = [
  { event: "sales", label: "Sales: listings, offers and awards" },
  { event: "sealedBids", label: "Sealed bids" },
  { event: "closings", label: "Closings and wires" },
  { event: "approveWires", label: "Wire approvals" },
  { event: "compliance", label: "Compliance: buyer files, claims and sanctions" },
  { event: "deskBook", label: "The desk's own book" },
  { event: "admin", label: "Fees, settings and staff" },
  { event: "content", label: "Content" },
];

export function deskChannelWants(channel: { events: string }, capability?: DeskCapability) {
  return !capability || wantsEvent(channel, capability);
}

// A firm keeps a few channels, and the desk one.
export const MAX_BUYER_CHANNELS = 5;
// Consecutive failed sends before a channel pauses and its owner hears.
export const PAUSE_AFTER = 10;
const MAX_URL = 600;
const TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------------------------------------------
// Addresses. A chat webhook is a bearer secret, and the server posts to it, so only the vendors' own webhook hosts
// are taken: Slack's incoming webhooks and workflows, Teams' Workflows (Power Automate on Logic Apps or Power
// Platform) and the older Office 365 connectors. A host matches exactly or as a whole-label subdomain, so
// hooks.slack.com.evil.example or evilwebhook.office.com never passes.

const SLACK_HOST = "hooks.slack.com";
const SLACK_PATHS = ["/services/", "/workflows/"];
const TEAMS_SUFFIXES = [".logic.azure.com", ".environment.api.powerplatform.com", ".webhook.office.com"];
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function underSuffix(host: string, suffix: string) {
  if (!host.endsWith(suffix)) return false;
  const lead = host.slice(0, -suffix.length);
  return lead.length > 0 && lead.split(".").every((label) => LABEL.test(label));
}

function parseChatUrl(kind: unknown, raw: unknown): { url: URL } | { error: string } {
  if (!isChatKind(kind)) return { error: "Pick Slack or Microsoft Teams." };
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { error: "Paste the channel's webhook address." };
  if (text.length > MAX_URL) return { error: `That address runs past ${MAX_URL} characters. Paste the webhook address alone.` };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { error: "Paste the full webhook address, starting with https." };
  }
  if (url.protocol !== "https:") return { error: "Chat webhooks go to https addresses only." };
  if (url.username || url.password) return { error: "Leave any name or password out of the address." };
  if (url.port) return { error: "Leave the port out of the address." };
  const host = url.hostname.toLowerCase();
  if (kind === "SLACK") {
    const path = SLACK_PATHS.some((prefix) => url.pathname.startsWith(prefix) && url.pathname.length > prefix.length);
    if (host !== SLACK_HOST || !path) return { error: "A Slack webhook address is on hooks.slack.com, under /services/ or /workflows/." };
  } else if (!TEAMS_SUFFIXES.some((suffix) => underSuffix(host, suffix))) {
    return { error: "A Teams webhook address is on logic.azure.com, environment.api.powerplatform.com or webhook.office.com." };
  }
  if (url.href.length > MAX_URL) return { error: `That address runs past ${MAX_URL} characters. Paste the webhook address alone.` };
  return { url };
}

export function chatUrlProblem(kind: unknown, raw: unknown) {
  const parsed = parseChatUrl(kind, raw);
  return "error" in parsed ? parsed.error : null;
}

// What the page shows once the address is saved: its host and last four characters, never the whole address.
export function chatUrlHint(href: string) {
  let host = "";
  try {
    host = new URL(href).hostname;
  } catch {
    host = "";
  }
  return `${host} …${href.slice(-4)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Messages. Each is a title, a line or two and a link. Builders read named fields only, so whatever else a payload
// carries never reaches a channel.

export type ChatMessage = { title: string; lines: string[]; link: { url: string; label: string } | null };

const appUrl = () => process.env.NEXT_PUBLIC_APP_URL || "";

// A link goes only when it is a full web address, so a desk with no NEXT_PUBLIC_APP_URL sends none.
function linkTo(url: string, label: string) {
  return /^https?:\/\/[^\s<>|]+$/i.test(url) ? { url, label } : null;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const idOf = (value: unknown) => (typeof value === "string" && ID.test(value) ? value : null);
const textOf = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 140) : "");
const numberOf = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

function deadlineOf(value: unknown) {
  if (typeof value !== "string") return "";
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? "" : `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const STATUS_WORDS: Record<string, string> = {
  OPEN: "open",
  REVIEWED: "under review",
  ACCEPTED: "accepted",
  DECLINED: "declined",
  WITHDRAWN: "withdrawn",
  EXPIRED: "expired",
};

// A buyer event as the buyer's email notice reads it. offer.status carries no title, so the caller adds the
// listing's. A figure here is the listing's ask or the buyer's own target, never a bid.
export function buyerChatMessage(event: ChatBuyerEvent, payload: Record<string, unknown>): ChatMessage {
  const listingId = idOf(payload.listingId);
  const title = textOf(payload.title) || "A listing";
  const listing = listingId ? linkTo(watchLink(listingId), "Open the listing") : null;
  if (event === "listing.matched") {
    const score = numberOf(payload.score);
    return { title: `Buy box match · ${title}`, lines: [`${title} is live and ${score == null ? "fits one of your buy boxes" : `scores ${Math.round(score)} against one of your buy boxes`}.`], link: listing };
  }
  if (event === "listing.repriced") {
    const before = numberOf(payload.previousAsk);
    const after = numberOf(payload.ask);
    const loans = numberOf(payload.loansRepriced);
    const which = loans && loans > 1 ? `The ask on ${loans} loans` : "The ask";
    const moved = before != null && after != null && before !== after ? ` ${which} moved ${after < before ? "down" : "up"} from ${money(before)} to ${money(after)}.` : "";
    return { title: `New price · ${title}`, lines: [`${title}, a listing you saved, has a new price.${moved}`], link: listing };
  }
  if (event === "listing.deadline") {
    const when = deadlineOf(payload.bidDeadline);
    return { title: `Bid deadline · ${title}`, lines: [`Bids on ${title}, a listing you saved, close ${when ? `at ${when}` : "within a day"}.`], link: listing };
  }
  if (event === PRICE_ALERT_EVENT) {
    const ask = numberOf(payload.ask);
    const target = numberOf(payload.targetAsk);
    const line = ask != null && target != null ? `The ask on ${title} is now ${dollars(ask)}, at or under your target of ${dollars(target)}.` : `The ask on ${title} reached your target.`;
    return { title: `Price alert · ${title}`, lines: [line], link: listing };
  }
  const bid = payload.type === "OFFER";
  const closingId = idOf(payload.closingId);
  const inquiryId = idOf(payload.inquiryId);
  const line = payload.change === "countered"
    ? `The desk countered your bid on ${title}.`
    : `Your ${bid ? "bid" : "request"} on ${title} is ${STATUS_WORDS[String(payload.status)] ?? "updated"}.`;
  return {
    title: `${bid ? "Bid" : "Request"} update · ${title}`,
    lines: [line],
    link: closingId ? linkTo(`${appUrl()}/closings/${closingId}`, "Open the closing") : linkTo(`${appUrl()}/buyer/offers${inquiryId ? `#inquiry-${inquiryId}` : ""}`, "Open your inquiries"),
  };
}

// A desk notice by its event name and the page it points to, as a push reads it (lib/push.ts): the subject's
// first part only, since a title, a name or a figure in it could be anyone's.
export function deskChatMessage(subject: string, body: string): ChatMessage {
  return { title: pushTitle(subject), lines: ["Open the desk to read it."], link: linkTo(`${appUrl()}${pushLink(body)}`, "Open in UPB Capital") };
}

export function testChatMessage(desk: boolean): ChatMessage {
  return {
    title: "Test from UPB Capital",
    lines: [desk ? "Desk notices for this channel will arrive here." : "The alerts you picked will arrive here."],
    link: linkTo(`${appUrl()}${desk ? "/admin/settings#desk-chat" : "/account/notifications#chat"}`, "Open the settings"),
  };
}

const slackEscape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Slack takes { text } in its mrkdwn. Teams' Workflows and its older connectors both take a message with one
// Adaptive Card.
export function chatBody(kind: ChatKind, message: ChatMessage) {
  if (kind === "SLACK") {
    const parts = [`*${slackEscape(message.title)}*`, ...message.lines.map(slackEscape)];
    if (message.link) parts.push(`<${message.link.url}|${slackEscape(message.link.label)}>`);
    return { text: parts.join("\n") };
  }
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: message.title, weight: "Bolder", wrap: true },
            ...message.lines.map((text) => ({ type: "TextBlock", text, wrap: true })),
          ],
          actions: message.link ? [{ type: "Action.OpenUrl", title: message.link.label, url: message.link.url }] : [],
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Sending. Redirects aren't followed, and each send gives up after five seconds.

export type ChatSender = (url: string, body: string) => Promise<{ status: number; detail: string }>;

const fetchSender: ChatSender = async (url, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const detail = await response.text().catch(() => "");
  return { status: response.status, detail: detail.slice(0, 300) };
};

// Tests swap the network out, as they do for mail and push. Nothing else should.
let sender: ChatSender = fetchSender;
export function setChatSender(send: ChatSender | null) {
  sender = send ?? fetchSender;
}

// Test files run at once against one database, so another file's notice could reach a channel a test made. Under
// the test runner (node --test sets NODE_TEST_CONTEXT) the real sender sends nothing and records nothing.
function sendsOff(send: ChatSender) {
  return send === fetchSender && Boolean(process.env.NODE_TEST_CONTEXT);
}

// Alerts run beside the action that raised them. A failure is logged and goes no further.
const pending = new Set<Promise<unknown>>();
function later(task: Promise<unknown>) {
  const tracked: Promise<unknown> = task
    .catch((error) => console.error("[upb-chat] alert failed:", error instanceof Error ? error.message : error))
    .finally(() => pending.delete(tracked));
  pending.add(tracked);
}

// For tests: waits until every alert started so far has finished.
export async function chatAlertsIdle() {
  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    while (pending.size) await Promise.allSettled([...pending]);
  }
}

type Deliverable = Pick<ChatChannel, "id" | "kind" | "url" | "urlHint" | "label" | "ownerId" | "desk" | "pausedAt">;

const delivered = (status: number) => status >= 200 && status < 300;

// One send to one channel, recorded on it. A paused channel is skipped unless this is a test the owner asked for.
// The tenth failure in a row pauses it, and the claim on pausedAt means its owner hears once.
export async function deliverChat(channel: Deliverable, message: ChatMessage, send: ChatSender = sender, options: { evenPaused?: boolean } = {}) {
  if ((channel.pausedAt && !options.evenPaused) || sendsOff(send)) return null;
  const kind: ChatKind = channel.kind === "TEAMS" ? "TEAMS" : "SLACK";
  const problem = chatUrlProblem(kind, channel.url);
  let result: { status: number; detail: string };
  if (problem) result = { status: 0, detail: problem };
  else {
    try {
      result = await send(channel.url, JSON.stringify(chatBody(kind, message)));
    } catch (error) {
      result = { status: 0, detail: error instanceof Error ? error.message : "The send failed." };
    }
  }
  const now = new Date();
  if (delivered(result.status)) {
    await prisma.chatChannel.updateMany({ where: { id: channel.id }, data: { lastSentAt: now, lastError: null, failures: 0 } });
    return { ok: true, error: "" };
  }
  // The vendor's answer, never the address itself.
  const detail = result.detail.split(channel.url).join("…").replace(/\s+/g, " ").trim();
  const error = (result.status ? `Answered ${result.status}${detail ? `: ${detail}` : ""}` : detail || "No answer.").slice(0, 300);
  const after = await prisma.chatChannel.update({ where: { id: channel.id }, data: { lastError: error, failures: { increment: 1 } }, select: { failures: true } }).catch(() => null);
  if (after && after.failures >= PAUSE_AFTER) {
    const claim = await prisma.chatChannel.updateMany({ where: { id: channel.id, ...unset("pausedAt") }, data: { pausedAt: now } });
    if (claim.count === 1) await tellPaused(channel, kind, error);
  }
  return { ok: false, error };
}

async function tellPaused(channel: Deliverable, kind: ChatKind, error: string) {
  const vendor = CHAT_KIND_LABELS[kind];
  const name = `${channel.label ? `“${channel.label}” ` : ""}(${channel.urlHint})`;
  const subject = `Chat alerts paused · ${vendor}`;
  const fix = `Check the webhook in ${vendor}, send a test, then resume the channel`;
  if (channel.desk) {
    await notifyDesk(subject, `The desk's ${vendor} channel ${name} stopped taking alerts: ${PAUSE_AFTER} sends in a row failed, so it is paused. The last answer: ${error}\n\n${fix}: ${appUrl()}/admin/settings#desk-chat`, { capability: "admin" });
    return;
  }
  if (!channel.ownerId) return;
  const owner = await prisma.user.findUnique({ where: { id: channel.ownerId }, select: { email: true, deletedAt: true } });
  if (!owner || owner.deletedAt) return;
  await notify(owner.email, subject, `Your ${vendor} channel ${name} stopped taking alerts: ${PAUSE_AFTER} sends in a row failed, so it is paused. The last answer: ${error}\n\n${fix}: ${appUrl()}/account/notifications#chat`);
}

// ---------------------------------------------------------------------------------------------------------------
// Who hears what.

const OWNER_PICK = ["id", "role", "accountStatus", "subscriptionTier", "subscriptionStatus", "subscriptionCurrentPeriodEnd", "trialEndsAt", "deletedAt"] as const;

// A buyer event to the live channels of these buyers that take it. The audience is the buyer webhooks' (lib/webhooks.ts
// emitBuyerWebhook): an account that is still there and on Pro now, a trial included. Returns how many channels it
// went to.
export async function sendBuyerChat(userIds: string[], event: ChatBuyerEvent, payload: Record<string, unknown>, send: ChatSender = sender) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length || sendsOff(send)) return 0;
  // A plain $in, which the ownerId index serves, however many watchers a listing has (lib/bulk-read.ts).
  const rows = (await prisma.chatChannel.findRaw({
    filter: { ownerId: { $in: ids }, desk: false, pausedAt: null },
    options: { projection: { ownerId: 1, events: 1 } },
  })) as unknown as { ownerId?: string; events?: string }[];
  const wanting = [...new Set(rows.filter((row) => row.ownerId && wantsEvent({ events: row.events ?? "" }, event)).map((row) => row.ownerId as string))];
  if (!wanting.length) return 0;
  const owners = (await readIn("User", "id", wanting, { pick: OWNER_PICK })).filter((user) => !user.deletedAt && !buyerApiProblem(user));
  if (!owners.length) return 0;
  let message = payload;
  if (event === "offer.status" && !textOf(payload.title)) {
    const listingId = idOf(payload.listingId);
    const listing = listingId ? await prisma.listing.findUnique({ where: { id: listingId }, select: { title: true } }) : null;
    message = { ...payload, title: listing?.title ?? "" };
  }
  const built = buyerChatMessage(event, message);
  let sent = 0;
  for (const owner of owners) {
    const channels = await prisma.chatChannel.findMany({ where: { ownerId: owner.id, desk: false, ...unset("pausedAt") }, orderBy: OLDEST_FIRST });
    for (const channel of channels) {
      if (!wantsEvent(channel, event)) continue;
      if ((await deliverChat(channel, built, send))?.ok) sent += 1;
    }
  }
  return sent;
}

// A notifyDesk notice to the desk's channel, when it takes notices for that power.
export async function sendDeskChat(subject: string, body: string, capability?: DeskCapability, send: ChatSender = sender) {
  if (sendsOff(send)) return 0;
  const channels = await prisma.chatChannel.findMany({ where: { desk: true, ...unset("pausedAt") }, orderBy: OLDEST_FIRST });
  const message = deskChatMessage(subject, body);
  let sent = 0;
  for (const channel of channels) {
    if (!deskChannelWants(channel, capability)) continue;
    if ((await deliverChat(channel, message, send))?.ok) sent += 1;
  }
  return sent;
}

// The hooks in lib/webhooks.ts, lib/email.ts and lib/target-alerts.ts. Each starts the sends and returns at once.
export function alertBuyerChannels(userIds: string[], event: ChatBuyerEvent, payload: Record<string, unknown>) {
  later(sendBuyerChat(userIds, event, payload));
}

export function alertDeskChannel(subject: string, body: string, capability?: DeskCapability) {
  later(sendDeskChat(subject, body, capability));
}

// ---------------------------------------------------------------------------------------------------------------
// Managing channels. The address never leaves the server once saved: the page reads CHANNEL_VIEW.

type Outcome = { ok: true; message: string; id?: string } | { ok: false; error: string };
const fail = (error: string) => ({ ok: false as const, error });

export const CHANNEL_VIEW = {
  id: true,
  kind: true,
  urlHint: true,
  label: true,
  events: true,
  lastSentAt: true,
  lastError: true,
  failures: true,
  pausedAt: true,
  createdAt: true,
} as const;

export type ChannelView = Pick<ChatChannel, keyof typeof CHANNEL_VIEW>;

export function buyerChannels(ownerId: string): Promise<ChannelView[]> {
  return prisma.chatChannel.findMany({ where: { ownerId, desk: false }, select: CHANNEL_VIEW, orderBy: OLDEST_FIRST });
}

export function deskChannels(): Promise<ChannelView[]> {
  return prisma.chatChannel.findMany({ where: { desk: true }, select: CHANNEL_VIEW, orderBy: OLDEST_FIRST });
}

// The same rule as the firm's API keys and webhooks (actions/buyer-api.ts): a channel posts for the whole firm, so
// only the owner or a managing seat changes one.
export const BUYER_MANAGE_DENIED = "Only a managing seat or the account owner can change chat alerts.";

function buyerManageProblem(user: ActingUser) {
  if (user.role !== "BUYER") return "Chat alerts here are for buyer accounts.";
  if (!canManageSeats(user)) return BUYER_MANAGE_DENIED;
  return null;
}

// Pro runs chat alerts, as it runs the buyer API's keys and webhooks (lib/api-keys.ts buyerApiProblem), a trial
// included. Null while the account may add and test channels.
export function chatProProblem(user: Parameters<typeof buyerApiProblem>[0], now = new Date()) {
  if (!buyerApiProblem(user, now)) return null;
  if (user.role !== "BUYER" || user.accountStatus !== "APPROVED") return "Chat alerts are for approved buyer accounts.";
  return `${proLapse(user, now) ?? ""} Chat alerts come with Pro, as webhooks do.`.trim();
}

function cleanLabel(raw: unknown) {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, 60) : "";
}

type NewChannel = { kind: unknown; url: unknown; label: unknown; events: unknown[] };

async function createChannel(input: NewChannel, data: { ownerId?: string; desk: boolean; createdById: string; events: string }, limit: number) {
  const parsed = parseChatUrl(input.kind, input.url);
  if ("error" in parsed) return fail(parsed.error);
  const kind = input.kind as ChatKind;
  const href = parsed.url.href;
  const row = await prisma.chatChannel.create({
    data: { ...(data.ownerId ? { ownerId: data.ownerId } : {}), desk: data.desk, kind, url: href, urlHint: chatUrlHint(href), label: cleanLabel(input.label), events: data.events, createdById: data.createdById },
    select: { id: true, urlHint: true },
  });
  const rivals = () => prisma.chatChannel.findMany({ where: data.desk ? { desk: true } : { ownerId: data.ownerId, desk: false }, select: { id: true }, orderBy: OLDEST_FIRST });
  if (!(await keptWithinLimit(row.id, limit, rivals))) {
    await prisma.chatChannel.deleteMany({ where: { id: row.id } });
    return fail(data.desk ? "The desk already has a chat channel. Remove it to add another." : `An account keeps up to ${limit} chat channels. Remove one to add another.`);
  }
  return { ok: true as const, id: row.id, kind, urlHint: row.urlHint };
}

export async function addBuyerChannel(user: ActingUser, input: NewChannel): Promise<Outcome> {
  const denied = buyerManageProblem(user);
  if (denied) return fail(denied);
  const problem = chatProProblem(user);
  if (problem) return fail(problem);
  const events = cleanEvents(input.events, CHAT_BUYER_EVENTS);
  if (!events) return fail("Pick at least one alert for the channel.");
  const made = await createChannel(input, { ownerId: user.id, desk: false, createdById: personId(user), events }, MAX_BUYER_CHANNELS);
  if (!made.ok) return made;
  await audit(user.id, "CHAT_CHANNEL_ADDED", "chatChannel", made.id, `${CHAT_KIND_LABELS[made.kind]} · ${made.urlHint} · ${events}`, user.actor?.id);
  return { ok: true, id: made.id, message: `The ${CHAT_KIND_LABELS[made.kind]} channel is added. Send a test to check it.` };
}

export async function addDeskChannel(user: Staff & { id: string }, input: NewChannel): Promise<Outcome> {
  if (!deskCan(user, "admin")) return fail(DESK_DENIED);
  // No power ticked still leaves the notices every desk member gets.
  const events = cleanEvents(input.events, DESK_CHAT_POWERS);
  const made = await createChannel(input, { desk: true, createdById: user.id, events }, 1);
  if (!made.ok) return made;
  await audit(user.id, "CHAT_CHANNEL_ADDED", "chatChannel", made.id, `Desk · ${CHAT_KIND_LABELS[made.kind]} · ${made.urlHint} · ${events || "general notices only"}`);
  return { ok: true, id: made.id, message: `The desk's ${CHAT_KIND_LABELS[made.kind]} channel is added. Send a test to check it.` };
}

export const CHANNEL_INTENTS = ["test", "pause", "resume", "remove"] as const;
export type ChannelIntent = (typeof CHANNEL_INTENTS)[number];

// A test, a pause, a resume or a removal, on a channel this person may change: a desk owner on the desk's, a buyer's
// owner or managing seat on the firm's.
export async function changeChannel(user: ActingUser, id: string, intent: unknown, send: ChatSender = sender): Promise<Outcome> {
  if (!(CHANNEL_INTENTS as readonly unknown[]).includes(intent)) return fail("Pick what to do with the channel.");
  const desk = user.role === "ADMIN";
  const denied = desk ? (deskCan(user, "admin") ? null : DESK_DENIED) : buyerManageProblem(user);
  if (denied) return fail(denied);
  const channel = id ? await prisma.chatChannel.findFirst({ where: desk ? { id, desk: true } : { id, ownerId: user.id, desk: false } }) : null;
  if (!channel) return fail("That chat channel isn't on this account.");
  const vendor = CHAT_KIND_LABELS[channel.kind === "TEAMS" ? "TEAMS" : "SLACK"];
  const detail = `${desk ? "Desk · " : ""}${vendor} · ${channel.urlHint}`;
  const seat = desk ? undefined : user.actor?.id;
  if (intent === "test") {
    const problem = desk ? null : chatProProblem(user);
    if (problem) return fail(problem);
    const result = await deliverChat(channel, testChatMessage(desk), send, { evenPaused: true });
    await audit(user.id, "CHAT_CHANNEL_TESTED", "chatChannel", channel.id, `${detail} · ${result?.ok ? "delivered" : "failed"}`, seat);
    if (!result) return fail("Test messages aren't sent from this server.");
    if (!result.ok) return fail(`${vendor} refused the test. ${result.error}`.slice(0, 280));
    return { ok: true, message: `${vendor} took the test message.${channel.pausedAt ? " The channel is still paused. Resume it to get alerts again." : ""}` };
  }
  if (intent === "pause") {
    await prisma.chatChannel.updateMany({ where: { id: channel.id, ...unset("pausedAt") }, data: { pausedAt: new Date() } });
    await audit(user.id, "CHAT_CHANNEL_PAUSED", "chatChannel", channel.id, detail, seat);
    return { ok: true, message: "The channel is paused. Nothing goes to it until it is resumed." };
  }
  if (intent === "resume") {
    await prisma.chatChannel.updateMany({ where: { id: channel.id }, data: { pausedAt: null, failures: 0 } });
    await audit(user.id, "CHAT_CHANNEL_RESUMED", "chatChannel", channel.id, detail, seat);
    return { ok: true, message: "The channel is back on." };
  }
  await prisma.chatChannel.deleteMany({ where: { id: channel.id } });
  await audit(user.id, "CHAT_CHANNEL_REMOVED", "chatChannel", channel.id, detail, seat);
  return { ok: true, message: `The ${vendor} channel is removed. Remove the webhook in ${vendor} too if nothing else uses it.` };
}

// How a channel's picks read on its card.
export function channelEventsText(channel: { events: string }, desk: boolean) {
  const picked = new Set(endpointEvents(channel.events));
  if (desk) {
    const powers = DESK_CHAT_POWERS.filter((item) => picked.has(item.event));
    if (powers.length === DESK_CHAT_POWERS.length) return "Every desk notice.";
    if (!powers.length) return "The notices every desk member gets.";
    return `The notices every desk member gets, and: ${powers.map((item) => item.label).join("; ")}.`;
  }
  const events = CHAT_BUYER_EVENTS.filter((item) => picked.has(item.event));
  return events.length ? `${events.map((item) => item.label).join("; ")}.` : "No alerts picked.";
}
