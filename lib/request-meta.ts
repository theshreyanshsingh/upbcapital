import { headers } from "next/headers";

// X-Forwarded-For is a list each proxy appends to, so its left end is whatever the caller wrote. The trusted
// entry is the one the nearest proxy added: count TRUSTED_PROXY_HOPS back from the right. One hop fits both a
// single reverse proxy and Next serving directly, which fills the header itself when the caller sends none.
export function clientAddress(forwardedFor: string | null, realIp: string | null, hops = Number(process.env.TRUSTED_PROXY_HOPS ?? 1)) {
  const chain = (forwardedFor || "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (chain.length && Number.isFinite(hops) && hops > 0) return chain[Math.max(0, chain.length - Math.floor(hops))];
  return realIp?.trim() || chain[chain.length - 1] || "unknown";
}

export async function requestMeta() {
  const incoming = await headers();
  return {
    ipAddress: clientAddress(incoming.get("x-forwarded-for"), incoming.get("x-real-ip")),
    userAgent: (incoming.get("user-agent") || "").slice(0, 300),
  };
}
