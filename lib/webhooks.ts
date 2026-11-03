import { createHmac } from "node:crypto";
import { lookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
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

export async function emitWebhook(userId: string, event: string, payload: Record<string, unknown>) {
  const endpoints = await prisma.webhookEndpoint.findMany({ where: { userId } });
  const body = JSON.stringify({ event, sentAt: new Date().toISOString(), ...payload });
  for (const endpoint of endpoints) {
    const allowed = endpoint.events.split(",").map((item) => item.trim());
    if (!allowed.includes(event)) continue;
    let status = 0;
    let detail = webhookUrlProblem(endpoint.url) ?? "";
    if (!detail) {
      try {
        ({ status, detail } = await post(
          endpoint.url,
          {
            "content-type": "application/json",
            "x-upb-event": event,
            "x-upb-signature": signWebhook(endpoint.secret, body),
          },
          body,
        ));
      } catch (error) {
        detail = error instanceof Error ? error.message : "Delivery failed.";
      }
    }
    await prisma.webhookDelivery.create({
      data: { endpointId: endpoint.id, event, status, detail },
    });
  }
}
