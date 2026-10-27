import { headers } from "next/headers";

export async function requestMeta() {
  const incoming = await headers();
  const forwarded = incoming.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    ipAddress: forwarded || incoming.get("x-real-ip") || "unknown",
    userAgent: (incoming.get("user-agent") || "").slice(0, 300),
  };
}
