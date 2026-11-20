import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import { after } from "next/server";
import { audit } from "@/lib/audit";
import { toCsv } from "@/lib/csv";
import { unset } from "@/lib/db-filters";
import { DESK_DENIED, deskCan, type Staff } from "@/lib/desk-roles";
import { prisma } from "@/lib/prisma";
import { clientAddress } from "@/lib/request-meta";

// The API call log: one row for each call a key makes on /api/v1, kept for API_LOG_DAYS. It holds the method, the path
// with the query's values left out, the status it was answered with (the route's own, or the key check's refusal) and
// a keyed hash of the caller's address, never the address itself. The key's owner reads it on their API page and the
// desk on /admin/api. lib/api-limit.ts records.

export const API_LOG_DAYS = 90;
// What an API page shows for each key, and the most one CSV holds.
export const RECENT_CALLS = 50;
export const CSV_CALL_LIMIT = 50_000;

const DAY = 24 * 60 * 60 * 1000;
const PATH_MAX = 300;

export type LoggedCall = { keyId: string; userId: string; method: string; path: string; status: number; ipHash: string; createdAt: Date };

// A one-way code for the caller's address, keyed by the auth secret as the announcement codes are: the same address
// always gets the same code, so a new source stands out, and nobody without the secret can turn it back into an
// address. Without a secret nothing is stored, since a plain hash of an IPv4 address is easy to reverse.
export function addressHash(address: string, secret = process.env.AUTH_SECRET || "") {
  const ip = address.trim();
  if (!secret || !ip || ip === "unknown") return "";
  return createHmac("sha256", secret).update(`upb-api-address:${ip}`).digest("base64url").slice(0, 22);
}

// The path and the names of the query's parameters, without their values: /api/v1/listings?state&limit.
export function loggedPath(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url, "http://localhost");
  } catch {
    return "";
  }
  const names = [...new Set(parsed.searchParams.keys())]
    .map((name) => name.replace(/[^\w.\-[\]]/g, "").slice(0, 40))
    .filter(Boolean);
  return `${parsed.pathname}${names.length ? `?${names.join("&")}` : ""}`.slice(0, PATH_MAX);
}

// The call as it will be stored, read from the request. The address is hashed here, so it never leaves this function.
export function callFromRequest(request: Request, key: { id: string; userId: string }, status: number, at: Date): LoggedCall {
  const address = clientAddress(request.headers.get("x-forwarded-for"), request.headers.get("x-real-ip"));
  return { keyId: key.id, userId: key.userId, method: request.method.toUpperCase().slice(0, 10), path: loggedPath(request.url), status, ipHash: addressHash(address), createdAt: at };
}

// Writes that ran outside a request, as in a test or a script, where after() isn't available. apiLogSettled waits on
// them.
const pending = new Set<Promise<unknown>>();

// The write waits until the answer has gone out (after() from next/server, as lib/screening.ts does), so the log never
// slows or breaks a call. A failed write is logged on the server and the call is unaffected.
export function logInBackground(work: () => Promise<unknown>) {
  const run = () => work().catch((error) => console.error("[upb-api-log] the call was not logged:", error instanceof Error ? error.message : error));
  try {
    after(run);
  } catch {
    const promise = run().finally(() => pending.delete(promise));
    pending.add(promise);
  }
}

export async function apiLogSettled() {
  while (pending.size) await Promise.all([...pending]);
}

export async function recordApiCall(call: LoggedCall) {
  await prisma.apiCall.create({ data: call });
}

// A call the key check lets through is logged with the status the route itself answers. Each /api/v1 handler is
// wrapped in withCallLog; apiCaller hands the passed call to the wrapper, which logs it once the route has answered,
// as 500 if the route threw. A handler that isn't wrapped logs the key check's 200, as before.
const passedCall = new AsyncLocalStorage<{ call: LoggedCall | null }>();

export function deferPassedCall(call: LoggedCall) {
  const store = passedCall.getStore();
  if (!store) return false;
  store.call = call;
  return true;
}

export function withCallLog<A extends unknown[]>(handler: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    const store: { call: LoggedCall | null } = { call: null };
    const finish = (status: number) => {
      if (!store.call) return;
      const call = { ...store.call, status };
      logInBackground(() => recordApiCall(call));
    };
    try {
      const response = await passedCall.run(store, () => handler(...args));
      finish(response.status);
      return response;
    } catch (error) {
      finish(500);
      throw error;
    }
  };
}

// A key past its allowance, or one that was revoked or whose account is closed, logs its first refusal of each kind in
// each minute. Calls inside the allowance are each logged; a flood past it shouldn't become a flood of writes.
const REFUSAL_WINDOW_MS = 60 * 1000;
const refusals = new Map<string, number>();

export function firstRefusal(ref: string, status: number, now: number) {
  const window = Math.floor(now / REFUSAL_WINDOW_MS);
  const id = `${ref}:${status}`;
  if (refusals.get(id) === window) return false;
  if (refusals.size > 10_000) refusals.clear();
  refusals.set(id, window);
  return true;
}

// A key the check turned away (revoked, or its account suspended or closed) is found again by its hash once the answer
// has gone. An unknown key has no owner, so nothing is logged for it.
export function logRefusedKey(request: Request, keyHash: string, status: number, at: Date) {
  if (!firstRefusal(keyHash.slice(0, 32), status, at.getTime())) return;
  logInBackground(async () => {
    const key = await prisma.apiKey.findUnique({ where: { hash: keyHash }, select: { id: true, userId: true } });
    if (key) await recordApiCall(callFromRequest(request, key, status, at));
  });
}

// The daily job: calls older than API_LOG_DAYS go. Running it twice removes nothing more.
export async function purgeApiCalls(now = new Date()) {
  const { count } = await prisma.apiCall.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - API_LOG_DAYS * DAY) } } });
  return `API call log removed ${count} ${count === 1 ? "call" : "calls"} older than ${API_LOG_DAYS} days`;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading it. An account reads only its own keys' calls: both the key and the account on the row must be its own.

export type KeyCalls = {
  key: { id: string; name: string; prefix: string; revokedAt: Date | null };
  calls: { id: string; method: string; path: string; status: number; createdAt: Date }[];
};

export async function recentCalls(userId: string, now = new Date(), take = RECENT_CALLS): Promise<KeyCalls[]> {
  const since = new Date(now.getTime() - API_LOG_DAYS * DAY);
  const keys = await prisma.apiKey.findMany({ where: { userId }, select: { id: true, name: true, prefix: true, revokedAt: true }, orderBy: { createdAt: "desc" } });
  return Promise.all(
    keys.map(async (key) => ({
      key,
      calls: await prisma.apiCall.findMany({
        where: { keyId: key.id, userId, createdAt: { gte: since } },
        select: { id: true, method: true, path: true, status: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take,
      }),
    })),
  );
}

export const API_CALL_COLUMNS = ["time_utc", "key_name", "key_prefix", "method", "path", "status", "address_code"] as const;

// The account's calls over the last API_LOG_DAYS, newest first, as a spreadsheet. The address code is the keyed hash,
// so the owner can tell sources apart without the addresses.
export async function callsCsv(userId: string, now = new Date()) {
  const since = new Date(now.getTime() - API_LOG_DAYS * DAY);
  const keys = await prisma.apiKey.findMany({ where: { userId }, select: { id: true, name: true, prefix: true } });
  const byId = new Map(keys.map((key) => [key.id, key]));
  const calls = keys.length
    ? await prisma.apiCall.findMany({
        where: { userId, keyId: { in: keys.map((key) => key.id) }, createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: CSV_CALL_LIMIT,
      })
    : [];
  const rows = calls.map((call) => ({
    time_utc: call.createdAt.toISOString(),
    key_name: byId.get(call.keyId)?.name ?? "",
    key_prefix: byId.get(call.keyId)?.prefix ?? "",
    method: call.method,
    path: call.path,
    status: call.status,
    address_code: call.ipHash,
  }));
  return { rows: rows.length, csv: rows.length ? toCsv(rows) : API_CALL_COLUMNS.join(",") };
}

// The CSV route's answer: the signed-in account's own calls, or, for the desk's compliance role, any account's. Each
// download is audited.
export async function callsDownload(user: (Staff & { id: string }) | null, account: string | null, now = new Date()) {
  const headers = { "Cache-Control": "private, no-store" };
  if (!user) return new Response("Sign in required.", { status: 401, headers });
  let accountId = user.id;
  if (account && account !== user.id) {
    if (user.role !== "ADMIN") return new Response("You can download only your own keys' calls.", { status: 403, headers });
    if (!deskCan(user, "compliance")) return new Response(DESK_DENIED, { status: 403, headers });
    const found = await prisma.user.findUnique({ where: { id: account }, select: { id: true } }).catch(() => null);
    if (!found) return new Response("Not found.", { status: 404, headers });
    accountId = found.id;
  }
  const { rows, csv } = await callsCsv(accountId, now);
  await audit(user.id, "API_LOG_EXPORT", "user", accountId, `${rows} API ${rows === 1 ? "call" : "calls"} from the last ${API_LOG_DAYS} days`);
  return new Response(csv, {
    headers: {
      ...headers,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="api-calls-${now.toISOString().slice(0, 10)}.csv"`,
    },
  });
}

// For the desk's API page: each account with a key or a call in the window, its calls, refusals and last call.
export async function apiAccounts(now = new Date()) {
  const since = new Date(now.getTime() - API_LOG_DAYS * DAY);
  const [keys, calls, refused] = await Promise.all([
    prisma.apiKey.findMany({ where: unset("revokedAt"), select: { userId: true } }),
    prisma.apiCall.groupBy({ by: ["userId"], where: { createdAt: { gte: since } }, _count: { _all: true }, _max: { createdAt: true } }),
    prisma.apiCall.groupBy({ by: ["userId"], where: { createdAt: { gte: since }, status: { gte: 400 } }, _count: { _all: true } }),
  ]);
  const liveKeys = new Map<string, number>();
  for (const key of keys) liveKeys.set(key.userId, (liveKeys.get(key.userId) ?? 0) + 1);
  const ids = [...new Set([...liveKeys.keys(), ...calls.map((row) => row.userId)])];
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, companyName: true, email: true, role: true } });
  const counted = new Map(calls.map((row) => [row.userId, row]));
  const refusedBy = new Map(refused.map((row) => [row.userId, row._count._all]));
  return users
    .map((user) => ({
      user,
      liveKeys: liveKeys.get(user.id) ?? 0,
      calls: counted.get(user.id)?._count._all ?? 0,
      refused: refusedBy.get(user.id) ?? 0,
      lastCallAt: counted.get(user.id)?._max.createdAt ?? null,
    }))
    .sort((a, b) => (b.lastCallAt?.getTime() ?? 0) - (a.lastCallAt?.getTime() ?? 0) || b.liveKeys - a.liveKeys);
}
