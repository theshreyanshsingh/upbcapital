export function canSubmitOffer(input: { role: string; accountStatus: string; verificationStatus: string | null }) {
  if (input.role === "ADMIN") return { ok: true as const };
  if (input.role !== "BUYER" || input.accountStatus !== "APPROVED") {
    return { ok: false as const, reason: "account" as const };
  }
  if (input.verificationStatus !== "APPROVED") {
    return { ok: false as const, reason: "verification" as const };
  }
  return { ok: true as const };
}

// A vendor result is identity only. The desk's approval stays the gate for offers, and no vendor step reopens a file
// the desk has approved or declined.
export const VENDOR_LOCKED = ["APPROVED", "REJECTED"] as const;

export function vendorBlocked(status: string | null | undefined) {
  if (status === "APPROVED") return "The desk already approved this file.";
  if (status === "REJECTED") return "The desk declined this file. Write the desk to reopen it.";
  return null;
}

export const ACCREDITATION_TEXT =
  "I certify that I am an accredited investor, or that I am signing for an entity that is an accredited investor, as that term is used in Rule 501 of Regulation D. I understand this desk does not verify that certification with a third party in this version.";

// ---------------------------------------------------------------------------------------------------------------
// The tax ID's last four digits. The desk matches them against the closing papers and never holds the whole number.

export const TAX_ID_NOTE = "Only the last four digits. UPB never asks for the whole number and never stores it.";

export function readTaxIdLast4(raw: unknown, optional = false) {
  const value = String(raw ?? "").replace(/\s+/g, "");
  if (!value && optional) return { error: null, value: null } as const;
  if (!/^\d{4}$/.test(value)) return { error: "Enter only the last four digits of the tax ID." } as const;
  return { error: null, value } as const;
}

// ---------------------------------------------------------------------------------------------------------------
// Yearly re-certification. An approved file is current until its recertifyBy date. Past it the buyer confirms the
// file is unchanged, or updates it, and the desk approves it again before the buyer bids. A file approved before
// re-certification began has no date and stays current.

export const DEFAULT_RECERTIFY_MONTHS = 12;
export const RECERT_NOTICE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function recertifyMonthsOf(value: number | null | undefined) {
  return value != null && Number.isInteger(value) && value >= 1 && value <= 36 ? value : DEFAULT_RECERTIFY_MONTHS;
}

// The same day `months` later, or the month's last day when it is shorter.
export function recertifyByFrom(from: Date, months: number) {
  const date = new Date(from);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date;
}

type RecertFile = { status: string; recertifyBy?: Date | null };

export function recertLapsed(file: RecertFile | null | undefined, now = new Date()) {
  return file?.status === "APPROVED" && Boolean(file.recertifyBy) && file.recertifyBy!.getTime() < now.getTime();
}

// Open to re-certify: lapsed, or inside the notice window before the date.
export function recertOpen(file: RecertFile | null | undefined, now = new Date()) {
  return file?.status === "APPROVED" && Boolean(file.recertifyBy) && file.recertifyBy!.getTime() - now.getTime() <= RECERT_NOTICE_DAYS * DAY_MS;
}

// Why a new price is refused while the file is lapsed, or null.
export function recertBlock(file: RecertFile | null | undefined, now = new Date()) {
  if (!recertLapsed(file, now)) return null;
  return `Your buyer file was due for re-certification on ${credentialDate(file!.recertifyBy!, now)}. Confirm or update it at /buyer/verification before you bid again.`;
}

// ---------------------------------------------------------------------------------------------------------------
// The buyer's credential: the funds the desk verified and the day that proof runs out. Once a buyer has one, their
// open bids together may not run past it, as Ten-X and Auction.com cap a qualified bidder.

export type FundsProof = { proofAmount: number | null; proofExpiresAt: Date | null; proofVerifiedAt: Date | null };
export type FundsCredential = { amount: number; expiresAt: Date | null; verifiedAt: Date; expired: boolean };

// Only a figure the desk verified is a ceiling. A stated amount waiting on review limits nothing yet.
export function fundsCredential(profile: FundsProof | null | undefined, now = new Date()): FundsCredential | null {
  if (!profile?.proofVerifiedAt || profile.proofAmount == null || !(profile.proofAmount > 0)) return null;
  const expiresAt = profile.proofExpiresAt ?? null;
  return { amount: profile.proofAmount, expiresAt, verifiedAt: profile.proofVerifiedAt, expired: Boolean(expiresAt && expiresAt.getTime() < now.getTime()) };
}

// "Nov 30", with the year only when it isn't this year's.
export function credentialDate(date: Date, now = new Date()) {
  const sameYear = date.getUTCFullYear() === now.getUTCFullYear();
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" }).format(date);
}

function dollars(amount: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount);
}

export function credentialLine(credential: Pick<FundsCredential, "amount" | "expiresAt" | "expired">, now = new Date()) {
  if (!credential.expiresAt) return `Verified funds ${dollars(credential.amount)}`;
  return credential.expired
    ? `Verified funds ${dollars(credential.amount)} expired ${credentialDate(credential.expiresAt, now)}`
    : `Verified funds ${dollars(credential.amount)} to ${credentialDate(credential.expiresAt, now)}`;
}

export function allInOf(amount: number, premiumBps: number) {
  return amount + (amount * premiumBps) / 10000;
}

// What one open bid or open closing holds against the ceiling. Bids on the same loan share a key, since only one of
// them can win, so a buyer raising their own bid needs room for the raise and not for both.
export type Exposure = { key: string; allIn: number };

export function bidTarget(listingId: string, noteId: string | null | undefined) {
  return `${listingId}:${noteId || "whole"}`;
}

export function exposureByKey(exposures: Exposure[]) {
  const byKey: Record<string, number> = {};
  for (const item of exposures) byKey[item.key] = Math.max(byKey[item.key] ?? 0, item.allIn);
  return byKey;
}

// Room left for a bid on `key`: the ceiling less everything held on other loans.
export function headroomFor(ceiling: number, byKey: Record<string, number>, key?: string) {
  const held = Object.entries(byKey).reduce((sum, [other, allIn]) => (other === key ? sum : sum + allIn), 0);
  return ceiling - held;
}

export const RENEW_FUNDS = "Send the desk a fresh proof of funds to bid again.";

export type LimitCheck =
  | { ok: true; headroomAfter: number | null }
  | { ok: false; reason: "expired" | "over"; message: string; headroom: number };

export function bidLimit(input: { credential: FundsCredential | null; byKey: Record<string, number>; key: string; allIn: number; now?: Date }): LimitCheck {
  const { credential } = input;
  if (!credential) return { ok: true, headroomAfter: null };
  const room = headroomFor(credential.amount, input.byKey, input.key);
  if (credential.expired) {
    return { ok: false, reason: "expired", headroom: 0, message: `Your verified funds expired ${credentialDate(credential.expiresAt!, input.now)}. ${RENEW_FUNDS}` };
  }
  // A cent of slack for the premium's rounding.
  if (input.allIn > room + 0.005) {
    const left = Math.max(0, room);
    return {
      ok: false,
      reason: "over",
      headroom: left,
      message: `This bid's all-in of ${dollars(input.allIn)} is over your verified funds. You have ${dollars(left)} of headroom left of ${dollars(credential.amount)}. Bid less, withdraw another bid, or send the desk a larger proof of funds.`,
    };
  }
  return { ok: true, headroomAfter: room - Math.max(input.byKey[input.key] ?? 0, input.allIn) };
}

// The credential as the bid forms show it. Plain figures and strings, so it crosses to a client component.
export type BidCredentialView = {
  line: string;
  amount: number;
  expired: boolean;
  // The all-in each open bid or closing holds, by bidTarget, so a form can work out the headroom for its own loan.
  byKey: Record<string, number>;
  // Left across every open bid and closing.
  headroom: number;
};

export type BidStanding = {
  credential: BidCredentialView | null;
  // Set when the buyer's bidding is paused for strikes. The forms show it in place of the bid box.
  paused: string | null;
};

// Headroom left after a bid of this all-in on this loan, for the bid confirmation. Null when no ceiling applies.
export function headroomAfter(credential: BidCredentialView | null | undefined, key: string, allIn: number) {
  if (!credential || credential.expired) return null;
  return headroomFor(credential.amount, credential.byKey, key) - Math.max(credential.byKey[key] ?? 0, allIn);
}

// The credential and the headroom left, as rows for a bid confirmation. Nothing when no ceiling applies.
export function credentialRows(line: string | null, room: number | null): [string, string][] {
  if (!line || room == null) return [];
  return [
    ["Verified funds", line.replace(/^Verified funds /, "")],
    ["Headroom after this bid", dollars(room)],
  ];
}
