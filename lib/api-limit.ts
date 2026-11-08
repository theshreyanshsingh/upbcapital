import type { User } from "@prisma/client";
import { NextResponse } from "next/server";
import { checkApiKey, hashKey, keyRefusal, tokenOf, type ApiScope } from "@/lib/api-keys";
import { consumeRateLimit } from "@/lib/rate-limit";

// Each key's allowance on /api/v1. The developers page and the Seller API page quote these figures.
export const API_LIMIT = { requests: 120, windowMs: 60 * 1000 };

// Seconds until the window this request fell in closes. The database and Redis stores count in fixed windows.
export function retryAfterSeconds(now: number, windowMs = API_LIMIT.windowMs) {
  return Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000));
}

type Caller = { user: User; scopes: ApiScope[]; response: null } | { user: null; response: NextResponse };

// Every /api/v1 route starts here: the key's account, or the response to send instead. The count is per key and
// starts once the key checks out, so nobody can spend a real key's allowance with made-up ones. A route that names a
// scope turns away a key without it, and a buyer's key is turned away, saying why, once the account's Pro lapses.
export async function apiCaller(request: Request, scope?: ApiScope, now = Date.now()): Promise<Caller> {
  const header = request.headers.get("authorization");
  const check = await checkApiKey(header);
  if (!check.ok) return { user: null, response: NextResponse.json({ error: check.error }, { status: check.status }) };
  const token = tokenOf(header);
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
  const refused = keyRefusal(check, scope, new Date(now));
  if (refused) return { user: null, response: NextResponse.json(refused, { status: 403 }) };
  return { user: check.user, scopes: check.scopes, response: null };
}
