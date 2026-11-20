import type { User } from "@prisma/client";
import { NextResponse } from "next/server";
import { checkApiKey, hashKey, keyRefusal, tokenOf, type ApiScope } from "@/lib/api-keys";
import { callFromRequest, deferPassedCall, firstRefusal, logInBackground, logRefusedKey, recordApiCall } from "@/lib/api-log";
import { consumeRateLimit } from "@/lib/rate-limit";

// Each key's allowance on /api/v1. The developers page and the Seller API page quote these figures.
export const API_LIMIT = { requests: 120, windowMs: 60 * 1000 };

// Seconds until the window this request fell in closes. The database and Redis stores count in fixed windows.
export function retryAfterSeconds(now: number, windowMs = API_LIMIT.windowMs) {
  return Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000));
}

type Caller = { user: User; scopes: ApiScope[]; response: null } | { user: null; response: NextResponse };

// checkApiKey's answer for a key that isn't on file (lib/api-keys.ts). It has no owner, so it isn't logged.
const UNKNOWN_KEY = "Unknown API key.";

// Every /api/v1 route starts here: the key's account, or the response to send instead. The count is per key and
// starts once the key checks out, so nobody can spend a real key's allowance with made-up ones. A route that names a
// scope turns away a key without it, and a buyer's key is turned away, saying why, once the account's Pro lapses.
// Each call with a key on file goes in the API call log once the answer is sent, refusals included (lib/api-log.ts).
// A call the key check lets through is logged with the route's own answer when the route is wrapped in withCallLog,
// as every /api/v1 route is; otherwise as the key check's 200.
export async function apiCaller(request: Request, scope?: ApiScope, now = Date.now()): Promise<Caller> {
  const header = request.headers.get("authorization");
  const check = await checkApiKey(header);
  const token = tokenOf(header);
  const at = new Date(now);
  if (!check.ok) {
    if (token.startsWith("upb_") && check.error !== UNKNOWN_KEY) logRefusedKey(request, hashKey(token), check.status, at);
    return { user: null, response: NextResponse.json({ error: check.error }, { status: check.status }) };
  }
  const log = (status: number) => {
    const call = callFromRequest(request, check.key, status, at);
    logInBackground(() => recordApiCall(call));
  };
  if (!(await consumeRateLimit(`api:${hashKey(token).slice(0, 32)}`, API_LIMIT.requests, API_LIMIT.windowMs, now))) {
    const wait = retryAfterSeconds(now);
    if (firstRefusal(check.key.id, 429, now)) log(429);
    return {
      user: null,
      response: NextResponse.json(
        { error: `Too many requests. Each key may make ${API_LIMIT.requests} a minute. Try again in ${wait} seconds.`, retryAfter: wait },
        { status: 429, headers: { "Retry-After": String(wait) } },
      ),
    };
  }
  const refused = keyRefusal(check, scope, new Date(now));
  if (refused) {
    log(403);
    return { user: null, response: NextResponse.json(refused, { status: 403 }) };
  }
  const passed = callFromRequest(request, check.key, 200, at);
  if (!deferPassedCall(passed)) logInBackground(() => recordApiCall(passed));
  return { user: check.user, scopes: check.scopes, response: null };
}
