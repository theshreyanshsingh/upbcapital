import { createHmac, timingSafeEqual } from "node:crypto";
import { audit } from "@/lib/audit";
import { appOrigin } from "@/lib/billing";
import { prisma } from "@/lib/prisma";

// One-click unsubscribe. A link names one user and one kind of mail, signed with the auth secret, so it works without
// signing in and can't be edited to turn off someone else's mail. It never expires, since a link in an old email has
// to keep working. Transactional mail (closings, awards, security, codes) never carries one.

export const UNSUBSCRIBE_CATEGORIES = ["watch", "search", "deals", "dispatch", "report", "digest"] as const;
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
