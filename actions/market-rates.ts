"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireRole, requireUser } from "@/lib/auth";
import { compsFor, loadClosedTrades } from "@/lib/comps";
import { prettyDate } from "@/lib/format";
import { compSubjectOf, indicativeTarget, modelBand, priceLadder, type IndicativeNote, type PriceLadder } from "@/lib/indicative";
import { LIEN_POSITIONS, PAYMENT_STATUSES, US_STATES } from "@/lib/labels";
import { rescoreSpreadBoxes, standingDemand, type DraftLoan } from "@/lib/matching";
import { typedNumber } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit } from "@/lib/rate-limit";
import { clearSettingsCache, getSettings } from "@/lib/settings";
import type { TapeFieldKey } from "@/lib/tape-fields";

const DAY_MS = 24 * 60 * 60 * 1000;

function back(message: string, kind: "notice" | "error"): never {
  redirect(`/admin/settings?${kind}=${encodeURIComponent(message)}#market-rates`);
}

// The desk enters the 10-year Treasury rate and the day it was read, and the yield the book's indicative price
// solves for. A new rate reprices every spread rule's open matches at once.
export async function saveMarketRates(formData: FormData) {
  const actor = await requireRole(["ADMIN"]);
  const rateText = String(formData.get("tenYearRate") || "").trim();
  const dateText = String(formData.get("tenYearAsOf") || "").trim();
  const targetText = String(formData.get("indicativeTargetYield") || "").trim();
  const rate = typedNumber(rateText);
  if (!Number.isFinite(rate) || !(rate > 0 && rate <= 20)) back("Enter the 10-year rate as a percent, above 0 and up to 20.", "error");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) back("Enter the date the rate was read.", "error");
  const asOf = new Date(`${dateText}T00:00:00.000Z`);
  // A day of slack for a date picked ahead of the server's timezone.
  if (Number.isNaN(asOf.getTime()) || asOf.getTime() > Date.now() + DAY_MS) back("The rate's date can't be in the future.", "error");
  // Blank keeps the default target, so clearing the box never prices the book at 0%.
  const target = targetText ? typedNumber(targetText) : null;
  if (target != null && (!Number.isFinite(target) || !(target >= 1 && target <= 50))) back("Enter the indicative yield as a percent from 1 to 50, or leave it blank for the default.", "error");
  const data = { tenYearRate: rate, tenYearAsOf: asOf, indicativeTargetYield: target };
  await prisma.platformSettings.upsert({ where: { id: "default" }, update: data, create: { id: "default", ...data } });
  clearSettingsCache();
  await audit(actor.id, "MARKET_RATES", "settings", "default", `10-year ${rate}% as of ${dateText}; indicative ${indicativeTarget(target).label}`);
  const boxes = await rescoreSpreadBoxes();
  revalidatePath("/admin/settings");
  revalidatePath("/marketplace");
  revalidatePath("/buyer/buy-box");
  back(`The 10-year rate is ${rate}% as of ${prettyDate(asOf)}.${boxes ? ` ${boxes} spread rule${boxes === 1 ? " was" : "s were"} repriced.` : ""}`, "notice");
}

// ---------------------------------------------------------------------------------------------------------------
// Price against time to sell, for a seller at upload. Each call scores every live buy box, so it is rate limited,
// and it returns counts and whole-percent rungs only: never a buyer, a box or an exact standing figure.

type Checked = { error: string } | { error: null; ladder: PriceLadder };

const CHECK_LIMIT = 30;
const CHECK_WINDOW_MS = 10 * 60 * 1000;
// Pricing every loan against every box is quadratic; past this the desk prices the tape after it is submitted.
const MAX_LOANS = 400;

async function ladderFor(kind: string, loans: (DraftLoan & IndicativeNote)[], now: Date): Promise<PriceLadder> {
  const [settings, demand, trades] = await Promise.all([getSettings(), standingDemand(kind, loans, now), loadClosedTrades(now).catch(() => [])]);
  const goal = indicativeTarget(settings.indicativeTargetYield);
  const model = modelBand(loans, goal.target, settings.buyerPremiumBps, now);
  return priceLadder({
    upb: loans.reduce((sum, loan) => sum + loan.upb, 0),
    ask: loans.reduce((sum, loan) => sum + loan.askingPrice, 0),
    standing: demand.standing,
    fits: demand.fits,
    comps: compsFor(compSubjectOf(loans), trades),
    model: model ? { low: model.low, mid: model.mid, high: model.high } : null,
    targetYield: settings.indicativeTargetYield,
    now,
  });
}

function figure(value: unknown) {
  const parsed = typedNumber(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function dateOf(value: unknown) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export type NoteDraft = {
  state: string;
  lienPosition: string;
  paymentStatus: string;
  occupancy?: string;
  upb: string;
  interestRate: string;
  monthlyPi: string;
  estimatedValue: string;
  askingPrice: string;
  maturityDate?: string;
  monthsDelinquent?: string;
  foreclosureFiledAt?: string;
  valueType?: string;
  valueAsOf?: string;
};

// The note wizard's confirm step: the seller's ask against standing demand and comps for the loan as entered.
export async function checkNoteMarket(draft: NoteDraft): Promise<Checked> {
  const user = await requireUser();
  if (user.role !== "INDIVIDUAL_SELLER" && user.role !== "INSTITUTIONAL_SELLER" && user.role !== "ADMIN") return { error: "The market check is for seller accounts." };
  if (!(await consumeRateLimit(`market-check:${user.id}`, CHECK_LIMIT, CHECK_WINDOW_MS))) return { error: "That is a lot of checks in a few minutes. Try again shortly." };
  const state = String(draft?.state ?? "").trim().toUpperCase();
  const lien = String(draft?.lienPosition ?? "");
  const status = String(draft?.paymentStatus ?? "");
  const upb = figure(draft?.upb);
  const ask = figure(draft?.askingPrice);
  const rate = figure(draft?.interestRate);
  const pi = figure(draft?.monthlyPi);
  const value = figure(draft?.estimatedValue);
  if (!(US_STATES as readonly string[]).includes(state) || !LIEN_POSITIONS.some((item) => item.value === lien) || !PAYMENT_STATUSES.some((item) => item.value === status)) {
    return { error: "Finish the property and loan steps first." };
  }
  if (!(upb > 0) || !(rate >= 0) || !(pi >= 0) || !(ask > 0)) return { error: "Enter the balance, rate, payment and ask first." };
  const behind = Math.max(0, Math.round(figure(draft?.monthsDelinquent ?? "0") || 0));
  const loan: DraftLoan & IndicativeNote = {
    id: "draft",
    upb,
    askingPrice: ask,
    interestRate: rate,
    monthlyPi: pi,
    paymentStatus: status,
    maturityDate: dateOf(draft?.maturityDate),
    tradeStatus: "AVAILABLE",
    state,
    lienPosition: lien,
    occupancy: String(draft?.occupancy ?? "UNKNOWN"),
    estimatedValue: value > 0 ? value : 0,
    monthsDelinquent: behind,
    foreclosureFiledAt: dateOf(draft?.foreclosureFiledAt),
    valueType: draft?.valueType ? String(draft.valueType) : null,
    valueAsOf: dateOf(draft?.valueAsOf),
  };
  return { error: null, ladder: await ladderFor("SINGLE", [loan], new Date()) };
}

export type TapeCheck = {
  token: string;
  mapping: Partial<Record<TapeFieldKey, string>>;
  priceMode: "COLUMN" | "PERCENT" | "POOL_TOTAL";
  pricePercent: string;
  poolTotal: string;
};

// The tape wizard's confirm step, on the uploaded tape as mapped and priced.
export async function checkTapeMarket(input: TapeCheck): Promise<Checked> {
  const user = await requireUser();
  if (user.role !== "INSTITUTIONAL_SELLER" && user.role !== "ADMIN") return { error: "Tape uploads are for institutional accounts." };
  if (user.role === "INSTITUTIONAL_SELLER" && user.accountStatus !== "APPROVED") return { error: "Your institutional account is still in review." };
  if (!(await consumeRateLimit(`market-check:${user.id}`, CHECK_LIMIT, CHECK_WINDOW_MS))) return { error: "That is a lot of checks in a few minutes. Try again shortly." };
  const token = String(input?.token ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(token)) return { error: "Upload the tape again." };
  const priceMode = input?.priceMode === "PERCENT" || input?.priceMode === "POOL_TOTAL" ? input.priceMode : "COLUMN";
  const mapping = Object.fromEntries(
    Object.entries(input?.mapping && typeof input.mapping === "object" ? input.mapping : {}).filter(([, header]) => typeof header === "string"),
  ) as Partial<Record<TapeFieldKey, string>>;
  const [{ readTapeDraft }, { normalizeTapeRows, parseTapeBuffer }] = await Promise.all([import("@/lib/tape-draft"), import("@/lib/tape")]);
  const draft = await readTapeDraft(user.id, token);
  if (!draft) return { error: "That tape expired. Upload it again." };
  const { loans, errors } = normalizeTapeRows({
    rows: parseTapeBuffer(draft.bytes, draft.filename).rows,
    mapping,
    priceMode,
    pricePercent: typedNumber(input?.pricePercent),
    poolTotal: typedNumber(input?.poolTotal),
  });
  if (errors.length) return { error: "Fix the tape's errors to see the market check." };
  if (!loans.length) return { error: "The tape has no loans to check." };
  if (loans.length > MAX_LOANS) return { error: `Tapes over ${MAX_LOANS} loans are priced by the desk after you submit.` };
  const rows = loans.map((loan, index): DraftLoan & IndicativeNote => ({
    id: `row-${index}`,
    upb: loan.upb,
    askingPrice: loan.askingPrice,
    interestRate: loan.interestRate,
    monthlyPi: loan.monthlyPi,
    paymentStatus: loan.paymentStatus,
    maturityDate: loan.maturityDate,
    tradeStatus: "AVAILABLE",
    state: loan.state,
    lienPosition: loan.lienPosition,
    occupancy: loan.occupancy,
    estimatedValue: loan.estimatedValue,
    monthsDelinquent: loan.monthsDelinquent,
    foreclosureFiledAt: loan.foreclosureFiledAt ?? null,
    valueType: loan.valueType ?? null,
    valueAsOf: loan.valueAsOf ?? null,
  }));
  return { error: null, ladder: await ladderFor("POOL", rows, new Date()) };
}
