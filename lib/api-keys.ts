import { createHash, randomBytes } from "node:crypto";
import type { ApiKey, User } from "@prisma/client";
import { accountLocked } from "@/lib/access";
import { unset } from "@/lib/db-filters";
import { prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { isPro } from "@/lib/settings";

export function hashKey(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function mintKey() {
  const token = `upb_${randomBytes(24).toString("hex")}`;
  return { token, prefix: token.slice(0, 12), hash: hashKey(token) };
}

// What a key may do. A seller's key pushes tapes and reads the bids on its listings. A buyer's key reads the book,
// its buy-box matches, its own inquiries and its holdings. A key minted before scopes existed has the seller pair.
export const SELLER_SCOPES = ["tapes:write", "offers:read"] as const;
export const BUYER_SCOPES = ["listings:read", "matches:read", "offers:read", "holdings:read"] as const;
export type ApiScope = (typeof SELLER_SCOPES)[number] | (typeof BUYER_SCOPES)[number];

export const SCOPE_LABELS: Record<ApiScope, string> = {
  "tapes:write": "Push tapes",
  "listings:read": "Read live listings",
  "matches:read": "Read buy-box matches",
  "offers:read": "Read offers",
  "holdings:read": "Read holdings",
};

const KNOWN = new Set<string>([...SELLER_SCOPES, ...BUYER_SCOPES]);

export function scopesOf(key: { scopes?: string | null }): ApiScope[] {
  if (key.scopes == null) return [...SELLER_SCOPES];
  return key.scopes.split(",").map((scope) => scope.trim()).filter((scope): scope is ApiScope => KNOWN.has(scope));
}

// Buyer scopes only, in a fixed order, so a forged form can't grant a seller's.
export function cleanBuyerScopes(picked: unknown[]) {
  const chosen = new Set(picked.map(String));
  return BUYER_SCOPES.filter((scope) => chosen.has(scope)).join(",");
}

// The key list shows when each key was last used. To the minute is plenty, so a busy key writes once a minute.
const USE_PRECISION_MS = 60 * 1000;

export async function markKeyUsed(keyId: string, now = new Date()) {
  await prisma.apiKey.updateMany({
    where: { id: keyId, OR: [...unset("lastUsedAt").OR, { lastUsedAt: { lt: new Date(now.getTime() - USE_PRECISION_MS) } }] },
    data: { lastUsedAt: now },
  });
}

export function tokenOf(header: string | null) {
  return header?.replace(/^Bearer\s+/i, "").trim() ?? "";
}

export type KeyCheck =
  | { ok: true; key: ApiKey; user: User; scopes: ApiScope[] }
  | { ok: false; status: 401; error: string };

const UNKNOWN = { ok: false, status: 401, error: "Unknown API key." } as const;

// The key behind an Authorization header and its account. A revoked key, or one whose account is suspended,
// declined or deleted, answers nothing and records nothing.
export async function checkApiKey(header: string | null, now = new Date()): Promise<KeyCheck> {
  const token = tokenOf(header);
  if (!token.startsWith("upb_")) return UNKNOWN;
  const key = await prisma.apiKey.findUnique({ where: { hash: hashKey(token) }, include: { user: true } });
  if (!key) return UNKNOWN;
  if (key.revokedAt) return { ok: false, status: 401, error: "This API key was revoked. Mint a new one." };
  if (key.user.deletedAt || accountLocked(key.user.accountStatus)) return { ok: false, status: 401, error: "This key's account is suspended or closed." };
  await markKeyUsed(key.id, now);
  const { user, ...row } = key;
  return { ok: true, key: row, user, scopes: scopesOf(key) };
}

export async function userForApiKey(header: string | null, now = new Date()) {
  const check = await checkApiKey(header, now);
  return check.ok ? check.user : null;
}

type ProUser = Pick<User, "role" | "accountStatus" | "subscriptionTier" | "subscriptionStatus" | "subscriptionCurrentPeriodEnd" | "trialEndsAt">;

// Why the account isn't on Pro now, in one sentence, or null while it is: paid, a desk comp or a live trial.
export function proLapse(user: ProUser, now = new Date()) {
  if (isPro(user, now)) return null;
  if (user.subscriptionTier === "PRO" && user.subscriptionStatus === "PAST_DUE") return "This account's Pro payment is past due.";
  if (user.subscriptionTier === "PRO" && user.subscriptionStatus === "ACTIVE" && user.subscriptionCurrentPeriodEnd) {
    return `This account's Pro ended on ${prettyDate(user.subscriptionCurrentPeriodEnd)}.`;
  }
  if (user.subscriptionStatus === "CANCELED") return "This account's Pro was canceled.";
  if (user.trialEndsAt) return `This account's Pro trial ended on ${prettyDate(user.trialEndsAt)}.`;
  return "This account is on the free desk.";
}

// Why a buyer's key is paused, or null while the account has Pro.
export function buyerApiProblem(user: ProUser, now = new Date()) {
  if (user.role !== "BUYER" || user.accountStatus !== "APPROVED") return "Buyer API keys are for approved buyer accounts.";
  const lapse = proLapse(user, now);
  if (!lapse) return null;
  const fix = user.subscriptionStatus === "PAST_DUE" ? "Update the card" : "Subscribe";
  return `${lapse} Buyer API keys need Pro. ${fix} at /buyer/subscription and the key works again.`;
}

export type KeyRefusal = { code: "pro_required" | "scope_missing"; error: string };

// Why this key may not make a call that needs `scope`, or null. A buyer's key works only while its account has Pro.
export function keyRefusal(check: { user: ProUser; scopes: ApiScope[] }, scope: ApiScope | undefined, now = new Date()): KeyRefusal | null {
  if (check.user.role === "BUYER") {
    const problem = buyerApiProblem(check.user, now);
    if (problem) return { code: "pro_required", error: problem };
  }
  if (scope && !check.scopes.includes(scope)) return { code: "scope_missing", error: `This key doesn't have the ${scope} scope. Mint a key that has it.` };
  return null;
}

// Why this account can't mint a buyer key, or null: Pro, and a buyer file the desk approved.
export function buyerKeyProblem(user: ProUser, file: { status: string } | null | undefined, now = new Date()) {
  const problem = buyerApiProblem(user, now);
  if (problem) return problem;
  if (file?.status !== "APPROVED") return "Buyer API keys need a buyer file the desk approved. Finish it at /buyer/verification.";
  return null;
}
