import { prisma } from "@/lib/prisma";
import { unset } from "@/lib/db-filters";

type Env = Record<string, string | undefined>;

export type VapidConfig = { publicKey: string; privateKey: string; subject: string };

// What the service worker shows. It is read on a lock screen, so it carries no borrower, street, amount or code:
// a generic title, one generic line, and the in-app path to open.
export type PushPayload = { title: string; body: string; url: string; badge?: number };

export type PushTarget = { endpoint: string; keys: { p256dh: string; auth: string } };

export type PushSender = (target: PushTarget, payload: string, options: { vapid: VapidConfig; ttl: number }) => Promise<unknown>;

export const PUSH_BODY = "Open UPB Capital to see it.";
export const PUSH_FALLBACK_TITLE = "New notice";
export const PUSH_HOME = "/notifications";

// A notice waits a day on the push service for a phone that is off, then it is dropped. The in-app copy stays.
const TTL_SECONDS = 24 * 60 * 60;
const MAX_DEVICES = 10;

// Push is off until all three keys are set. The subject is a mailto: or https: contact the push services can reach.
export function vapidConfig(env: Env = process.env): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = env.VAPID_SUBJECT?.trim() ?? "";
  if (!publicKey || !privateKey || !subject) return null;
  if (!/^(mailto:|https:\/\/)/i.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

export function pushReady(env: Env = process.env) {
  return vapidConfig(env) !== null;
}

export function pushPublicKey(env: Env = process.env) {
  return vapidConfig(env)?.publicKey ?? null;
}

// The browsers' own push services. The server posts to whatever endpoint a browser hands it, so anything else is
// refused: a made-up endpoint would turn every notice into a request to an address someone chose.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

export function pushEndpointAllowed(endpoint: string) {
  if (typeof endpoint !== "string" || endpoint.length > 1024) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port !== "" && url.port !== "443")) return false;
  return PUSH_HOSTS.some((host) => host.test(url.hostname));
}

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

// p256dh is a 65-byte P-256 point and auth a 16-byte secret, both base64url.
export function readPushSubscription(input: unknown): PushTarget | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof raw.endpoint === "string" ? raw.endpoint.trim() : "";
  const p256dh = typeof raw.keys?.p256dh === "string" ? raw.keys.p256dh.trim() : "";
  const auth = typeof raw.keys?.auth === "string" ? raw.keys.auth.trim() : "";
  if (!pushEndpointAllowed(endpoint)) return null;
  if (!BASE64URL.test(p256dh) || p256dh.length < 80 || p256dh.length > 100) return null;
  if (!BASE64URL.test(auth) || auth.length < 16 || auth.length > 32) return null;
  return { endpoint, keys: { p256dh, auth } };
}

// The subject's event name only. "Offer accepted · First-lien performing · Austin" becomes "Offer accepted": a
// listing title can be free text, so it never reaches a lock screen. Anything with a digit, a currency sign, an
// address or quoted text falls back to a plain title.
export function pushTitle(subject: string) {
  let lead = String(subject ?? "").split(" · ")[0] ?? "";
  lead = lead.replace(/\s+on\s+.*$/i, "");
  lead = lead.replace(/[“"‘][^”"’]*[”"’]/g, "");
  lead = lead.replace(/\s+/g, " ").trim().replace(/[\s:;,.-]+$/, "");
  if (!lead || lead.length < 2 || lead.length > 60) return PUSH_FALLBACK_TITLE;
  if (/[\d$€£¥@#%&/\\<>“”"‘]/.test(lead)) return PUSH_FALLBACK_TITLE;
  return lead;
}

const SECTIONS = new Set([
  "account", "admin", "broker", "buyer", "closings", "events", "fees", "groups", "inbox", "market", "marketplace", "notifications", "seller",
]);

function originOf(appUrl: string) {
  try {
    return appUrl ? new URL(appUrl).origin : null;
  } catch {
    return null;
  }
}

// The first link in the notice that points inside the app, as a path. Links elsewhere, and query strings, are
// dropped, so a token in a URL never rides along. A notice with no link opens the notices list.
export function pushLink(body: string, appUrl = process.env.NEXT_PUBLIC_APP_URL || "") {
  const origin = originOf(appUrl);
  const pattern = /(?:^|[\s(<:])((?:https?:\/\/[^\s/<>"')]+)?\/[A-Za-z][^\s<>"')]*)/g;
  for (const match of String(body ?? "").matchAll(pattern)) {
    const raw = (match[1] ?? "").replace(/[.,;:!?]+$/, "");
    const absolute = /^https?:\/\//i.test(raw);
    if (absolute && !origin) continue;
    let url: URL;
    try {
      url = new URL(raw, origin ?? "http://upb.invalid");
    } catch {
      continue;
    }
    if (absolute && url.origin !== origin) continue;
    const section = url.pathname.split("/")[1] ?? "";
    if (!SECTIONS.has(section)) continue;
    return `${url.pathname}${url.hash}`;
  }
  return PUSH_HOME;
}

export function noticePush(subject: string, body: string, unread?: number, appUrl?: string): PushPayload {
  return {
    title: pushTitle(subject),
    body: PUSH_BODY,
    url: pushLink(body, appUrl),
    ...(typeof unread === "number" && unread >= 0 ? { badge: unread } : {}),
  };
}

// Tests swap the network out. Nothing else should.
let transport: PushSender | null = null;
export function setPushTransport(sender: PushSender | null) {
  transport = sender;
}

const webPushSender: PushSender = async (target, payload, { vapid, ttl }) => {
  const loaded = await import("web-push");
  const webpush = (loaded as unknown as { default?: typeof loaded }).default ?? loaded;
  return webpush.sendNotification(target, payload, {
    vapidDetails: vapid,
    TTL: ttl,
    urgency: "normal",
    timeout: 5000,
  });
};

function statusOf(error: unknown) {
  const code = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === "number" ? code : null;
}

export type PushResult = { sent: number; pruned: number; failed: number; skipped: boolean };

// Sends one payload to every device the user turned push on for. A device the push service says is gone (404 or
// 410) is deleted. Without the VAPID keys this does nothing, not even a read.
export async function sendPush(userId: string, payload: PushPayload, env: Env = process.env): Promise<PushResult> {
  const vapid = vapidConfig(env);
  if (!vapid) return { sent: 0, pruned: 0, failed: 0, skipped: true };
  const devices = await prisma.pushSubscription.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: MAX_DEVICES,
  });
  if (!devices.length) return { sent: 0, pruned: 0, failed: 0, skipped: false };
  const body = JSON.stringify(payload);
  const send = transport ?? webPushSender;
  const gone: string[] = [];
  const used: string[] = [];
  let failed = 0;
  await Promise.all(
    devices.map(async (device) => {
      if (!pushEndpointAllowed(device.endpoint)) {
        gone.push(device.id);
        return;
      }
      try {
        await send({ endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } }, body, { vapid, ttl: TTL_SECONDS });
        used.push(device.id);
      } catch (error) {
        const status = statusOf(error);
        if (status === 404 || status === 410) {
          gone.push(device.id);
          return;
        }
        failed += 1;
        // The endpoint is a capability and the payload is the user's, so neither is logged.
        console.error(`[upb-push] send failed (${status ?? "network"})`);
      }
    }),
  );
  if (gone.length) await prisma.pushSubscription.deleteMany({ where: { id: { in: gone } } });
  if (used.length) await prisma.pushSubscription.updateMany({ where: { id: { in: used } }, data: { lastUsedAt: new Date() } });
  if (gone.length && !used.length && !failed) {
    const left = await prisma.pushSubscription.count({ where: { userId } });
    if (!left) await prisma.user.update({ where: { id: userId }, data: { pushEnabled: false } }).catch(() => null);
  }
  return { sent: used.length, pruned: gone.length, failed, skipped: false };
}

// The fan-out from a notice. It never throws, so a push failure can't stop the email or the in-app copy.
export async function pushNotice(userId: string, subject: string, body: string) {
  if (!pushReady()) return;
  try {
    const unread = await prisma.notification.count({ where: { userId, ...unset("readAt") } });
    await sendPush(userId, noticePush(subject, body, unread));
  } catch (error) {
    console.error("[upb-push] fan-out failed:", error instanceof Error ? error.message : "unknown error");
  }
}

export const PUSH_DEVICE_LIMIT = MAX_DEVICES;
