import { appOrigin } from "@/lib/billing";
import { unset } from "@/lib/db-filters";
import { notify } from "@/lib/email";
import { money } from "@/lib/format";
import { LIEN_POSITIONS, PAYMENT_STATUSES, US_STATES } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { publicListing } from "@/lib/private-listings";
import { indicativeQuote, type IndicativeQuote } from "@/lib/quote";
import { consumeRateLimit } from "@/lib/rate-limit";

// The intake form a broker embeds on their own site: the seller quote form, tagged with the broker. It lives at
// /embed/intake/[code], where code is the broker's referral code, and only that route may be framed, only by the
// origins the broker listed. Everywhere else keeps frame-ancestors 'none' (next.config.ts).

export const WIDGET_PATH = "/embed/intake";
export const WIDGET_SOURCE = "WIDGET";
export const MAX_WIDGET_ORIGINS = 10;

const HOUR = 60 * 60 * 1000;
const CODE = /^[A-Za-z0-9]{4,32}$/;
// A bare https origin: a host of letters, digits, dots and dashes with a dot in it, and an optional port. Nothing a
// header could read as a second source or a new directive.
const ORIGIN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/;

// The broker's list, one per line or comma. Each must be an https origin with no path; a trailing slash is dropped.
export function readWidgetOrigins(raw: string): { origins: string[]; error: string | null } {
  const entries = raw.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
  const origins: string[] = [];
  // The messages never repeat the address, since the notice line shows no web addresses.
  for (const [index, entry] of entries.entries()) {
    const line = `Site ${index + 1}`;
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      return { origins: [], error: `${line} isn't a web address. Start each one with https and the site name.` };
    }
    if (url.protocol !== "https:") return { origins: [], error: `${line} must start with https.` };
    if (url.username || url.password || (url.pathname && url.pathname !== "/") || url.search || url.hash) {
      return { origins: [], error: `${line} has more than the site name. Leave off any page, query or anchor.` };
    }
    const origin = url.origin.toLowerCase();
    if (!ORIGIN.test(origin)) return { origins: [], error: `${line} isn't a site name the form can allow.` };
    if (!origins.includes(origin)) origins.push(origin);
  }
  if (origins.length > MAX_WIDGET_ORIGINS) return { origins: [], error: `List up to ${MAX_WIDGET_ORIGINS} sites.` };
  return { origins, error: null };
}

// The policy for the widget's own responses: nothing loads but its inline style, it posts only to itself, and only
// the listed sites may frame it. With no site listed, or the form off, no one may.
export function widgetCsp(origins: string[]) {
  const allowed = origins.filter((origin) => ORIGIN.test(origin));
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    `frame-ancestors ${allowed.length ? allowed.join(" ") : "'none'"}`,
  ].join("; ");
}

export function widgetUrl(code: string, origin = appOrigin()) {
  return `${origin.replace(/\/+$/, "")}${WIDGET_PATH}/${encodeURIComponent(code)}`;
}

export function widgetSnippet(code: string, origin = appOrigin()) {
  return `<iframe src="${widgetUrl(code, origin)}" title="Sell your mortgage note" width="100%" height="760" style="border:0;max-width:640px;" loading="lazy"></iframe>`;
}

export type WidgetBroker = { id: string; name: string; email: string; code: string; company: string; origins: string[] };

// An approved broker whose form is on. Anyone else's code shows nothing and can't be framed.
export async function widgetBroker(code: string | null | undefined): Promise<WidgetBroker | null> {
  const text = (code ?? "").trim().toUpperCase();
  if (!CODE.test(text)) return null;
  const user = await prisma.user.findFirst({
    where: { role: "BROKER", accountStatus: "APPROVED", referralCode: text, ...unset("deletedAt") },
    include: { brokerProfile: true },
  });
  const profile = user?.brokerProfile;
  if (!user || !profile?.widgetEnabled) return null;
  return { id: user.id, name: user.name, email: user.email, code: text, company: profile.company || user.name, origins: profile.widgetOrigins ?? [] };
}

export type WidgetFields = Record<string, string>;

function amount(raw: string | undefined) {
  const value = Number(String(raw || "").replace(/[$,\s]/g, ""));
  return Number.isFinite(value) ? value : NaN;
}

// The same checks as the seller quote form on /sell.
export function readWidgetLead(fields: WidgetFields) {
  const name = (fields.name ?? "").trim().slice(0, 120);
  const email = (fields.email ?? "").trim().toLowerCase().slice(0, 254);
  const state = (fields.state ?? "").trim().toUpperCase();
  const lien = fields.lienPosition ?? "";
  const status = fields.paymentStatus ?? "";
  const upb = amount(fields.upb);
  const estimatedValue = amount(fields.estimatedValue);
  const interestRate = amount(fields.interestRate);
  const monthlyPi = amount(fields.monthlyPi);
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !(US_STATES as readonly string[]).includes(state)) {
    return { error: "Name, email, and a US state are required." } as const;
  }
  if (!LIEN_POSITIONS.some((item) => item.value === lien) || !PAYMENT_STATUSES.some((item) => item.value === status)) {
    return { error: "Choose a lien and a payment status." } as const;
  }
  if (!(upb > 0) || !(estimatedValue > 0) || !(interestRate >= 0) || interestRate > 40 || !(monthlyPi >= 0)) {
    return { error: "UPB and value need to be greater than zero. Keep the rate under 40%." } as const;
  }
  return {
    error: null,
    lead: {
      name,
      email,
      phone: (fields.phone ?? "").trim().slice(0, 40),
      city: (fields.city ?? "").trim().slice(0, 80),
      state,
      lienPosition: lien as "FIRST",
      paymentStatus: status as "PERFORMING",
      upb,
      estimatedValue,
      interestRate,
      monthlyPi,
      note: (fields.note ?? "").trim().slice(0, 1000),
    },
  } as const;
}

export type WidgetResult = { error: string; status: number } | { error: null; leadId: string; quote: IndicativeQuote };

// One submission from a broker's site: limited per network and per broker, priced with the quote bands and comps,
// and filed as the broker's lead. The broker hears at once.
export async function fileWidgetLead(broker: WidgetBroker, fields: WidgetFields, ip: string): Promise<WidgetResult> {
  // A field people never see. A bot that fills it is turned away.
  if ((fields.website ?? "").trim()) return { error: "That didn't go through.", status: 400 };
  if (!(await consumeRateLimit(`widget:${ip}`, 8, HOUR))) return { error: "Too many quotes from this network. Wait and try again.", status: 429 };
  if (!(await consumeRateLimit(`widget-broker:${broker.id}`, 100, 24 * HOUR))) return { error: "This form is busy. Try again tomorrow.", status: 429 };
  const read = readWidgetLead(fields);
  if (read.error !== null) return { error: read.error, status: 400 };
  const { lead } = read;
  const comps = await prisma.note.findMany({
    where: { listing: { status: { in: ["APPROVED", "SOLD", "PENDING"] }, AND: [publicListing()] }, state: lead.state, paymentStatus: lead.paymentStatus },
    select: { state: true, paymentStatus: true, upb: true, askingPrice: true },
    take: 40,
  });
  const quote = indicativeQuote(
    { state: lead.state, paymentStatus: lead.paymentStatus, upb: lead.upb, estimatedValue: lead.estimatedValue, interestRate: lead.interestRate, monthlyPi: lead.monthlyPi },
    comps.map((row) => ({ state: row.state, paymentStatus: row.paymentStatus, upb: Number(row.upb), askingPrice: Number(row.askingPrice) })),
  );
  const row = await prisma.sellerLead.create({
    data: { ...lead, indicativeLow: quote.low, indicativeHigh: quote.high, basis: quote.basis, brokerId: broker.id, source: WIDGET_SOURCE },
  });
  await notify(
    broker.email,
    "A new lead from your intake form",
    `${lead.name} asked for a range on a ${lead.state} note with ${money(lead.upb)} unpaid principal. The form showed ${money(quote.low)} to ${money(quote.high)}. The lead is on your intake form page, and the desk has it too.`,
  ).catch(() => null);
  return { error: null, leadId: row.id, quote };
}
