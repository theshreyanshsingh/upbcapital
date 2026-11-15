import { createHmac, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { audit } from "@/lib/audit";
import { appOrigin } from "@/lib/billing";
import { unset } from "@/lib/db-filters";
import { prisma } from "@/lib/prisma";

// One-click unsubscribe. A link names one user and one kind of mail, signed with the auth secret, so it works without
// signing in and can't be edited to turn off someone else's mail. It never expires, since a link in an old email has
// to keep working. Transactional mail (closings, awards, security, codes) never carries one.

// "announcements" is a member's place on the deal-announcement list. Someone on the list without an account leaves
// with their own subscriber link instead (lib/announcements.ts).
export const UNSUBSCRIBE_CATEGORIES = ["watch", "search", "deals", "dispatch", "report", "digest", "announcements"] as const;
export type UnsubscribeCategory = (typeof UNSUBSCRIBE_CATEGORIES)[number];

// What a sender passes to notify: whose mail this is and which kind. A search alert can name its one saved search.
export type MailCategory = { category: UnsubscribeCategory; userId: string; searchId?: string };

export type Unsubscribe = { userId: string; category: UnsubscribeCategory; searchId: string | null };

const ALL = "all";
const ID = /^[\w-]{1,64}$/;

function key() {
  return process.env.AUTH_SECRET || "";
}

// The purpose prefix keeps this signature from ever matching one made for anything else with the same secret.
function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(`upb-unsubscribe:${payload}`).digest("base64url");
}

// Null without a secret, so mail still goes out on a desk that hasn't set one, just without the link.
export function unsubscribeToken(input: MailCategory) {
  const secret = key();
  if (!secret || !ID.test(input.userId)) return null;
  const scope = input.category === "search" && input.searchId && ID.test(input.searchId) ? input.searchId : ALL;
  const payload = `${input.userId}.${input.category}.${scope}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function readUnsubscribeToken(token: string | null | undefined): Unsubscribe | null {
  const secret = key();
  const parts = (token ?? "").trim().split(".");
  if (!secret || parts.length !== 4) return null;
  const [userId, category, scope, given] = parts;
  if (!ID.test(userId) || !ID.test(scope) || !UNSUBSCRIBE_CATEGORIES.includes(category as UnsubscribeCategory)) return null;
  const expected = Buffer.from(sign(`${userId}.${category}.${scope}`, secret));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return { userId, category: category as UnsubscribeCategory, searchId: category === "search" && scope !== ALL ? scope : null };
}

// The page link opens a confirmation, so a mail scanner that follows links turns nothing off. The one-click link
// takes the RFC 8058 POST a mail client sends from its own unsubscribe button.
export function unsubscribeLinks(input: MailCategory, origin = appOrigin()) {
  const token = unsubscribeToken(input);
  if (!token) return null;
  const query = `token=${encodeURIComponent(token)}`;
  return { page: `${origin}/unsubscribe?${query}`, oneClick: `${origin}/unsubscribe/one-click?${query}` };
}

// What the page and the email footer call each kind of mail.
export function categoryText(found: Pick<Unsubscribe, "category" | "searchId">) {
  if (found.category === "search") return found.searchId ? "alerts for this saved search" : "alerts for your saved searches";
  const text: Record<Exclude<UnsubscribeCategory, "search">, string> = {
    watch: "notices about listings you saved",
    deals: "desk picks",
    dispatch: "the monthly market dispatch",
    report: "the weekly report on your listings",
    digest: "the buy box digest",
    announcements: "deal announcements",
  };
  return text[found.category];
}

// Turns off the one setting the token names. A user or search that is gone counts as done, and says nothing about
// whether it existed.
export async function applyUnsubscribe(found: Unsubscribe) {
  const user = { id: found.userId };
  if (found.category === "search") {
    await prisma.savedSearch.updateMany({ where: { userId: found.userId, ...(found.searchId ? { id: found.searchId } : {}) }, data: { alertEnabled: false } });
  } else if (found.category === "watch") {
    await prisma.user.updateMany({ where: user, data: { watchAlerts: false } });
  } else if (found.category === "deals") {
    await prisma.user.updateMany({ where: user, data: { dealAlerts: false } });
  } else if (found.category === "dispatch") {
    await prisma.user.updateMany({ where: user, data: { marketDispatch: false } });
  } else if (found.category === "report") {
    await prisma.user.updateMany({ where: user, data: { sellerReport: false } });
  } else if (found.category === "announcements") {
    await prisma.user.updateMany({ where: user, data: { announcements: false } });
  } else {
    await prisma.user.updateMany({ where: user, data: { digest: "OFF" } });
  }
  const exists = await prisma.user.count({ where: user });
  if (exists) await audit(found.userId, "UNSUBSCRIBE", "user", found.userId, `${found.category}${found.searchId ? ` · ${found.searchId}` : ""}`);
}

// The footer and headers notify adds to categorized mail. Null when there is no secret to sign with.
export function unsubscribeParts(input: MailCategory, origin = appOrigin()) {
  const links = unsubscribeLinks(input, origin);
  if (!links) return null;
  const footer = `To stop ${categoryText({ category: input.category, searchId: input.searchId ?? null })}, open ${links.page}`;
  // A mail client only offers its own button for an absolute https link, or http on a local desk.
  const headers: Record<string, string> = /^https?:\/\//.test(links.oneClick)
    ? { "List-Unsubscribe": `<${links.oneClick}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
    : {};
  return { footer, headers };
}

// ---------------------------------------------------------------------------------------------------------------
// The preference page: every mailing one address can receive, on one page, without signing in. Its link names the
// row that holds the address (an account, or a deal-list subscriber without one) and a keyed tag of the address,
// signed as the links above are. It opens that one address's settings, stops working if the account's address
// changes, and never carries the address itself. Like an unsubscribe link, it never expires.

const PREFS = "prefs";
const SOURCES = { account: "u", list: "s" } as const;
export type PreferenceSource = keyof typeof SOURCES;
type PreferenceRef = { source: PreferenceSource; id: string; tag: string };

export function normalEmail(email: string) {
  return email.replace(/\s+/g, "").toLowerCase();
}

function addressTag(email: string, secret: string) {
  return createHmac("sha256", secret).update(`upb-preferences-address:${normalEmail(email)}`).digest("base64url").slice(0, 22);
}

// The "prefs:" prefix keeps this signature apart from every unsubscribe signature: those payloads start with an id,
// which never holds a colon.
export function preferenceToken(input: { source: PreferenceSource; id: string; email: string }) {
  const secret = key();
  if (!secret || !ID.test(input.id) || !input.email.includes("@")) return null;
  const payload = `${SOURCES[input.source]}.${input.id}.${addressTag(input.email, secret)}`;
  return `${PREFS}.${payload}.${sign(`${PREFS}:${payload}`, secret)}`;
}

export function readPreferenceToken(token: string | null | undefined): PreferenceRef | null {
  const secret = key();
  const parts = (token ?? "").trim().split(".");
  if (!secret || parts.length !== 5 || parts[0] !== PREFS) return null;
  const [, code, id, tag, given] = parts;
  const source = (Object.keys(SOURCES) as PreferenceSource[]).find((name) => SOURCES[name] === code);
  if (!source || !ID.test(id) || !ID.test(tag)) return null;
  const expected = Buffer.from(sign(`${PREFS}:${code}.${id}.${tag}`, secret));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return { source, id, tag };
}

// The address a link opens, or null when the link is bad, the row is gone, or the account's address has changed.
export async function preferenceAddress(token: string | null | undefined) {
  const ref = readPreferenceToken(token);
  if (!ref) return null;
  const row =
    ref.source === "account"
      ? await prisma.user.findUnique({ where: { id: ref.id }, select: { email: true, deletedAt: true } })
      : await prisma.subscriber.findUnique({ where: { id: ref.id }, select: { email: true } });
  if (!row || ("deletedAt" in row && row.deletedAt)) return null;
  const expected = Buffer.from(addressTag(row.email, key()));
  const actual = Buffer.from(ref.tag);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? row.email.trim() : null;
}

export function preferenceLink(input: { source: PreferenceSource; id: string; email: string }, origin = appOrigin()) {
  const token = preferenceToken(input);
  return token ? `${origin}/unsubscribe/preferences?token=${encodeURIComponent(token)}` : null;
}

// For an unsubscribe link's account. Null when the account is gone or there is no secret.
export async function preferenceLinkForUser(userId: string, origin = "") {
  const user = ID.test(userId) ? await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, deletedAt: true } }) : null;
  return user && !user.deletedAt ? preferenceLink({ source: "account", id: user.id, email: user.email }, origin) : null;
}

export const MAILING_KEYS = ["announcements", "dispatch", "deals", "watch", "search", "digest", "report"] as const;
export type MailingKey = (typeof MAILING_KEYS)[number];
export type Mailing = { key: MailingKey; label: string; on: boolean };

// The list names the page shows. Nothing else about the account is on it.
export const MAILING_LABELS: Record<MailingKey, string> = {
  announcements: "Deal announcements",
  dispatch: "The monthly market dispatch",
  deals: "Desk picks",
  watch: "Notices about listings you saved",
  search: "Saved-search alerts and roundups",
  digest: "The buy box digest",
  report: "The weekly report on your listings",
};

// The account is found by its address as stored; the list stores addresses in lower case (lib/announcements.ts).
async function addressRows(email: string) {
  const address = normalEmail(email);
  const [account, subscriber, { REPORT_ROLES }] = await Promise.all([
    prisma.user.findUnique({
      where: { email: email.trim() },
      select: { id: true, role: true, deletedAt: true, principalId: true, announcements: true, marketDispatch: true, dealAlerts: true, watchAlerts: true, sellerReport: true, digest: true },
    }),
    prisma.subscriber.findUnique({ where: { email: address }, select: { id: true, confirmedAt: true, unsubscribedAt: true } }),
    // Loaded late: lib/seller-report.ts sends through lib/email.ts, which imports this file.
    import("@/lib/seller-report"),
  ]);
  // A firm's seat reads the firm's mail and gets none of these lists itself (lib/seats.ts).
  const live = account && !account.deletedAt && !account.principalId ? account : null;
  const searches = live ? await prisma.savedSearch.findMany({ where: { userId: live.id }, select: { alertEnabled: true } }) : [];
  return { account: live, subscriber, searches, reports: (REPORT_ROLES as readonly string[]).includes(live?.role ?? "") };
}

// Each mailing the address can receive, account-based and list-based, as the senders decide who gets them: a
// buyer's lists for buyers, the weekly report for sellers and brokers, the deal list for anyone. When an address is
// both a member and a subscriber, the account's own setting decides, as lib/announcements.ts sends.
function mailingsOf({ account, subscriber, searches, reports }: Awaited<ReturnType<typeof addressRows>>): Mailing[] {
  const listed = Boolean(subscriber?.confirmedAt && !subscriber.unsubscribedAt);
  const keys: [MailingKey, boolean][] = [];
  if (account || subscriber) keys.push(["announcements", account?.announcements === true || (listed && account?.announcements == null)]);
  if (account) {
    keys.push(["dispatch", account.marketDispatch === true]);
    if (account.role === "BUYER") {
      keys.push(["deals", account.dealAlerts !== false], ["watch", account.watchAlerts !== false]);
      if (searches.length) keys.push(["search", searches.some((search) => search.alertEnabled)]);
      keys.push(["digest", account.digest !== "OFF"]);
    }
    if (reports) keys.push(["report", account.sellerReport !== false]);
  }
  return keys.map(([key, on]) => ({ key, label: MAILING_LABELS[key], on }));
}

export async function mailingsFor(email: string): Promise<Mailing[]> {
  return mailingsOf(await addressRows(email));
}

// Sets each mailing the address can receive to on or off, and nothing else: no other address, and no mail about
// bids, closings or the account. A key the address can't receive is ignored. Turning saved-search alerts on again
// wakes every search only when none was on, so one the holder turned off alone stays off. Returns what changed.
export async function applyMailings(email: string, wanted: Partial<Record<MailingKey, boolean>>, now = new Date()) {
  const rows = await addressRows(email);
  const { account, subscriber } = rows;
  const changed = mailingsOf(rows).filter((mailing) => typeof wanted[mailing.key] === "boolean" && wanted[mailing.key] !== mailing.on);
  if (!changed.length) return [];
  const user: Prisma.UserUpdateInput = {};
  for (const mailing of changed) {
    const on = wanted[mailing.key] === true;
    if (mailing.key === "announcements" && account) user.announcements = on;
    if (mailing.key === "dispatch") user.marketDispatch = on;
    if (mailing.key === "deals") user.dealAlerts = on;
    if (mailing.key === "watch") user.watchAlerts = on;
    if (mailing.key === "report") user.sellerReport = on;
    if (mailing.key === "digest") user.digest = on ? "WEEKLY" : "OFF";
  }
  if (account && Object.keys(user).length) await prisma.user.update({ where: { id: account.id }, data: user });
  if (account && changed.some((mailing) => mailing.key === "search")) {
    await prisma.savedSearch.updateMany({ where: { userId: account.id }, data: { alertEnabled: wanted.search === true } });
  }
  if (subscriber && changed.some((mailing) => mailing.key === "announcements")) {
    // Leaving takes the subscriber off too. Coming back without an account rejoins the list: the link reached this
    // inbox, which is the proof a confirmation asks for. With an account, the account's setting above decides.
    if (wanted.announcements !== true) await prisma.subscriber.updateMany({ where: { id: subscriber.id, ...unset("unsubscribedAt") }, data: { unsubscribedAt: now } });
    else if (!account) await prisma.subscriber.update({ where: { id: subscriber.id }, data: { confirmedAt: subscriber.confirmedAt ?? now, unsubscribedAt: null } });
  }
  const detail = `Preference page: ${changed.map((mailing) => `${mailing.key} ${wanted[mailing.key] ? "on" : "off"}`).join(", ")}`;
  if (account) await audit(account.id, "NOTICE_PREFS", "user", account.id, detail);
  else if (subscriber) await audit(null, "NOTICE_PREFS", "subscriber", subscriber.id, detail);
  return changed.map((mailing) => mailing.key);
}

// "Stop everything": every mailing on the page off at once.
export async function stopAllMailings(email: string, now = new Date()) {
  return applyMailings(email, Object.fromEntries(MAILING_KEYS.map((name) => [name, false])), now);
}
