import type { User } from "@prisma/client";
import { NextResponse } from "next/server";
import { hashKey, userForApiKey } from "@/lib/api-keys";
import { consumeRateLimit } from "@/lib/rate-limit";

// Each key's allowance on /api/v1. The developers page and the Seller API page quote these figures.
export const API_LIMIT = { requests: 120, windowMs: 60 * 1000 };

// Seconds until the window this request fell in closes. The database and Redis stores count in fixed windows.
export function retryAfterSeconds(now: number, windowMs = API_LIMIT.windowMs) {
  return Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000));
}

type Caller = { user: User; response: null } | { user: null; response: NextResponse };

// Every /api/v1 route starts here: the key's account, or the response to send instead. The count is per key and
// starts once the key checks out, so nobody can spend a real key's allowance with made-up ones.
export async function apiCaller(request: Request, now = Date.now()): Promise<Caller> {
  const header = request.headers.get("authorization");
  const user = await userForApiKey(header);
  if (!user) return { user: null, response: NextResponse.json({ error: "Unknown API key." }, { status: 401 }) };
  const token = header?.replace(/^Bearer\s+/i, "").trim() ?? "";
  if (!(await consumeRateLimit(`api:${hashKey(token).slice(0, 32)}`, API_LIMIT.requests, API_LIMIT.windowMs, now))) {
    const wait = retryAfterSeconds(now);
    return {
      user: null,
      response: NextResponse.json(
        { error: `Too many requests. Each key may make ${API_LIMIT.requests} a minute. Try again in ${wait} seconds.`, retryAfter: wait },
        { status: 429, headers: { "Retry-After": String(wait) } },
      ),
    };
  }
  return { user, response: null };
}
