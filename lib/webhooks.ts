import { createHmac } from "node:crypto";
import { lookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { buyerApiProblem } from "@/lib/api-keys";
import { unset } from "@/lib/db-filters";
import { prisma } from "@/lib/prisma";

export function signWebhook(secret: string, body: string) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

// Webhooks go only to public https hosts. The address is checked again when it is dialed, so a seller can't aim
// the server at the cloud metadata service or anything else inside its network, even through DNS.
const PRIVATE = new BlockList();
for (const [net, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv6");
}

// An IPv4-mapped IPv6 address (::ffff:7f00:1 is 127.0.0.1) is judged by its IPv4 address. It is decoded here
// because a ::ffff:0:0/96 rule in the list would also catch every plain IPv4 address.
export function isPrivateAddress(address: string) {
  const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(address);
  if (mapped) {
    const [high, low] = [parseInt(mapped[2] ?? "0", 16), parseInt(mapped[3] ?? "0", 16)];
    return PRIVATE.check(mapped[1] ?? [high >> 8, high & 255, low >> 8, low & 255].join("."), "ipv4");
  }
  const family = isIP(address);
  if (family === 4) return PRIVATE.check(address, "ipv4");
  if (family === 6) return PRIVATE.check(address, "ipv6");
  return true;
}

export function webhookUrlProblem(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Enter a full https URL.";
  }
  if (url.protocol !== "https:") return "Webhooks go to https URLs only.";
  if (url.username || url.password) return "Leave credentials out of the URL. Check the signature header instead.";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || /\.(localhost|local|internal)$/.test(host)) return "That host isn't reachable from the internet.";
  if (isIP(host) && isPrivateAddress(host)) return "That address isn't reachable from the internet.";
  return null;
}

export const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    const list = (addresses ?? []) as LookupAddress[];
    if (!error && (!list.length || list.some((item) => isPrivateAddress(item.address)))) {
      error = Object.assign(new Error(`${hostname} resolves to an address inside a private network.`), { code: "EPRIVATE" });
    }
    if (error) return callback(error, "", 4);
    if (options.all) return (callback as (error: null, addresses: LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

// Redirects are not followed, so a public host can't bounce the request somewhere private.
function post(url: string, headers: Record<string, string>, body: string) {
  return new Promise<{ status: number; detail: string }>((resolve, reject) => {
    const outgoing = request(
      url,
      { method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) }, lookup: publicLookup, signal: AbortSignal.timeout(5000) },
      (response) => {
        let detail = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (detail.length < 300) detail += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, detail: detail.slice(0, 300) }));
        response.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

// The sender is a parameter so tests can answer for the receiving server. Everything else uses post.
export type WebhookSender = typeof post;

// The events emitWebhook sends, for each endpoint's picker. A new emitWebhook event belongs here too.
export const WEBHOOK_EVENTS = [
  { event: "offer.created", label: "A bid arrives" },
  { event: "offer.countered", label: "The desk counters a bid" },
  { event: "offer.accepted", label: "A bid is awarded" },
  { event: "offer.declined", label: "A bid is declined, withdrawn or loses" },
] as const;

// A Pro buyer's events, for the Buyer API page. Each body carries ids and public fields only: never a street, a
// borrower, a data-room file or anyone else's bid.
export const BUYER_WEBHOOK_EVENTS = [
  { event: "listing.matched", label: "A new listing fits a buy box" },
  { event: "listing.repriced", label: "A saved listing has a new price" },
  { event: "listing.deadline", label: "Bids on a saved listing close within a day" },
  { event: "offer.status", label: "One of your bids or requests changes status" },
] as const;

export type BuyerEvent = (typeof BUYER_WEBHOOK_EVENTS)[number]["event"];

export function endpointEvents(events: string) {
  return events.split(",").map((item) => item.trim()).filter(Boolean);
}

export function wantsEvent(endpoint: { events: string }, event: string) {
  return endpointEvents(endpoint.events).includes(event);
}

// Only events the desk sends, in a fixed order, so a forged form can't store anything else.
export function cleanEvents(picked: unknown[], events: readonly { event: string }[] = WEBHOOK_EVENTS) {
  const chosen = new Set(picked.map(String));
  return events.map((item) => item.event).filter((event) => chosen.has(event)).join(",");
}

const MINUTE = 60 * 1000;

// The wait after each failed try. Five retries follow the first try, then the delivery stops until the owner sends
// it again.
export const RETRY_DELAYS_MS = [MINUTE, 10 * MINUTE, 60 * MINUTE, 6 * 60 * MINUTE, 24 * 60 * MINUTE] as const;

// When the next try is due once `attempts` tries have failed, or null when the retries are spent.
export function nextRetryAt(attempts: number, from: Date) {
  const wait = RETRY_DELAYS_MS[attempts - 1];
  return wait == null ? null : new Date(from.getTime() + wait);
}

const delivered = (status: number) => status >= 200 && status < 300;

type Endpoint = { url: string; secret: string };
type Stored = { id: string; event: string; payload: string };

// One try. Each is signed again with the endpoint's secret over the stored body, and says which try it is, so a
// receiver can drop a repeat by the delivery id.
async function attempt(endpoint: Endpoint, delivery: Stored, tries: number, send: WebhookSender) {
  const problem = webhookUrlProblem(endpoint.url);
  // An address that breaks the rules won't heal by waiting, so it isn't retried.
  if (problem) return { status: 0, detail: problem, retry: false };
  try {
    const result = await send(
      endpoint.url,
      {
        "content-type": "application/json",
        "x-upb-event": delivery.event,
        "x-upb-delivery": delivery.id,
        "x-upb-attempt": String(tries),
        "x-upb-signature": signWebhook(endpoint.secret, delivery.payload),
      },
      delivery.payload,
    );
    return { ...result, retry: true };
  } catch (error) {
    return { status: 0, detail: error instanceof Error ? error.message : "Delivery failed.", retry: true };
  }
}

// Sends try number `tries` and records it: delivered, booked for the next retry, or stopped. The write is keyed on
// the try, so a later try that overtook this one keeps its own result.
async function settle(endpoint: Endpoint, delivery: Stored, tries: number, send: WebhookSender) {
  const result = await attempt(endpoint, delivery, tries, send);
  const now = new Date();
  const ok = delivered(result.status);
  const next = ok || !result.retry ? null : nextRetryAt(tries, now);
  await prisma.webhookDelivery.updateMany({
    where: { id: delivery.id, attempts: tries },
    data: { status: result.status, detail: result.detail.slice(0, 300), nextAttemptAt: next, ...(ok ? { deliveredAt: now } : {}) },
  });
  if (next && send === post) retrySoon(delivery.id, tries, next);
  return ok;
}

// The job is the retry that survives a restart, but the cron may run only daily, which would turn a one-minute wait
// into a day. A long-running server also makes the short waits itself; the claim on the try count stops a double
// send when the job gets there first. Tests pass their own sender and get no timers.
function retrySoon(id: string, attempts: number, at: Date) {
  const wait = at.getTime() - Date.now();
  if (wait > 10 * MINUTE) return;
  const timer = setTimeout(() => {
    retryDelivery({ id, attempts }).catch((error) => console.error("[upb-webhooks] retry failed:", error instanceof Error ? error.message : error));
  }, Math.max(0, wait) + 1000);
  timer.unref?.();
}

export async function emitWebhook(userId: string, event: string, payload: Record<string, unknown>, send: WebhookSender = post) {
  const endpoints = await prisma.webhookEndpoint.findMany({ where: { userId } });
  const body = JSON.stringify({ event, sentAt: new Date().toISOString(), ...payload });
  for (const endpoint of endpoints) {
    if (!wantsEvent(endpoint, event)) continue;
    // Stored before the first try with a retry already booked, so a server that stops mid-send still retries it.
    const delivery = await prisma.webhookDelivery.create({
      data: { endpointId: endpoint.id, event, payload: body, attempts: 1, nextAttemptAt: nextRetryAt(1, new Date()) },
    });
    await settle(endpoint, delivery, 1, send);
  }
  // The bidder hears the same change as offer.status, on their own endpoints.
  if (SELLER_OFFER_EVENTS.has(event) && typeof payload.inquiryId === "string") await emitOfferStatus(payload.inquiryId, event.slice("offer.".length), payload, send);
}

const SELLER_OFFER_EVENTS = new Set<string>(WEBHOOK_EVENTS.map((item) => item.event));

// Sends a buyer event to each of these buyers who has an endpoint for it and is on Pro now, a trial included. It never
// throws: a buyer's webhook doesn't hold up the alert, award or job it rides on. Returns how many buyers it went to.
export async function emitBuyerWebhook(userIds: string | string[], event: BuyerEvent, payload: Record<string, unknown>, send: WebhookSender = post) {
  try {
    const ids = [...new Set(typeof userIds === "string" ? [userIds] : userIds)];
    if (!ids.length) return 0;
    const endpoints = await prisma.webhookEndpoint.findMany({ where: { userId: { in: ids } }, select: { userId: true, events: true } });
    const wanting = [...new Set(endpoints.filter((endpoint) => wantsEvent(endpoint, event)).map((endpoint) => endpoint.userId))];
    if (!wanting.length) return 0;
    const users = await prisma.user.findMany({ where: { id: { in: wanting }, ...unset("deletedAt") } });
    let sent = 0;
    for (const user of users) {
      if (buyerApiProblem(user)) continue;
      await emitWebhook(user.id, event, payload, send);
      sent += 1;
    }
    return sent;
  } catch (error) {
    console.error("[upb-webhooks] buyer event failed:", error instanceof Error ? error.message : error);
    return 0;
  }
}

// The buyer's side of an offer event: the inquiry, its listing, its status now, and what changed. No amount: the buyer
// reads their own figures from GET /api/v1/offers.
export async function emitOfferStatus(inquiryId: string, change: string, extra: { reason?: unknown; closingId?: unknown } = {}, send: WebhookSender = post) {
  const inquiry = await prisma.inquiry.findUnique({ where: { id: inquiryId }, select: { id: true, buyerId: true, listingId: true, type: true, status: true } }).catch(() => null);
  if (!inquiry) return 0;
  return emitBuyerWebhook(inquiry.buyerId, "offer.status", {
    inquiryId: inquiry.id,
    listingId: inquiry.listingId,
    type: inquiry.type,
    status: inquiry.status,
    change,
    ...(typeof extra.reason === "string" ? { reason: extra.reason } : {}),
    ...(typeof extra.closingId === "string" ? { closingId: extra.closingId } : {}),
  }, send);
}

// Prisma on MongoDB compares a stored null as earlier than any date, so a plain lte would also match every delivery
// that was delivered or stopped. The lower bound keeps those out.
const dueBy = (now: Date) => ({ gt: new Date(0), lte: now });

export async function dueDeliveries(now = new Date(), options: { endpointIds?: string[] } = {}) {
  return prisma.webhookDelivery.findMany({
    where: { nextAttemptAt: dueBy(now), ...(options.endpointIds ? { endpointId: { in: options.endpointIds } } : {}) },
    select: { id: true, attempts: true },
    orderBy: { nextAttemptAt: "asc" },
    // Each try can wait five seconds, so one run takes a bounded batch and the next run takes the rest.
    take: 50,
  });
}

// Retries one due delivery. The claim moves the try count on with a conditional write, so two overlapping runs
// send it once. The claim books the following retry too, in case this try never reports back.
export async function retryDelivery(delivery: { id: string; attempts: number }, now = new Date(), send: WebhookSender = post) {
  const tries = delivery.attempts + 1;
  const claim = await prisma.webhookDelivery.updateMany({
    where: { id: delivery.id, attempts: delivery.attempts, nextAttemptAt: dueBy(now) },
    data: { attempts: tries, nextAttemptAt: nextRetryAt(tries, now) },
  });
  if (claim.count !== 1) return false;
  const row = await prisma.webhookDelivery.findUnique({ where: { id: delivery.id }, include: { endpoint: true } });
  if (!row) return false;
  await settle(row.endpoint, row, tries, send);
  return true;
}

// The owner sends one delivery again now, whatever its state. It counts as another try, and if it fails the
// schedule goes on from there.
export async function redeliver(deliveryId: string, ownerId: string, send: WebhookSender = post) {
  const delivery = await prisma.webhookDelivery.findFirst({ where: { id: deliveryId, endpoint: { userId: ownerId } }, include: { endpoint: true } });
  if (!delivery) return { error: "That delivery isn't on this account." } as const;
  if (!delivery.payload) return { error: "That delivery was sent before bodies were kept, so it can't be sent again." } as const;
  const tries = delivery.attempts + 1;
  const claim = await prisma.webhookDelivery.updateMany({ where: { id: delivery.id, attempts: delivery.attempts }, data: { attempts: tries } });
  if (claim.count !== 1) return { error: "That delivery is being sent right now. Look again in a minute." } as const;
  return { delivered: await settle(delivery.endpoint, delivery, tries, send) } as const;
}

// How one delivery reads in the log. Rows from before retries have no deliveredAt, so a 2xx status counts.
export function deliveryState(delivery: { status: number; attempts: number; nextAttemptAt: Date | null; deliveredAt: Date | null }) {
  const tries = `${delivery.attempts} ${delivery.attempts === 1 ? "try" : "tries"}`;
  const answer = delivery.status ? `answered ${delivery.status}` : "no answer";
  if (delivery.deliveredAt || delivered(delivery.status)) return { tone: "good" as const, label: `Delivered, ${answer} · ${tries}` };
  if (delivery.nextAttemptAt) return { tone: "waiting" as const, label: `Failed, ${answer} · ${tries} · retrying` };
  return { tone: "bad" as const, label: `Stopped, ${answer} · ${tries}` };
}
