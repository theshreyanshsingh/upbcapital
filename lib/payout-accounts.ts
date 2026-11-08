import { audit } from "@/lib/audit";
import { unset } from "@/lib/db-filters";
import { DESK_DENIED, deskCan, type Staff } from "@/lib/desk-roles";
import { notifyDesk, sendAlert } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { keepsSellerFile } from "@/lib/seller-identity";

// A seller's account for proceeds, checked by call-back before any money goes to it. Changed payout details sent by
// email are the classic loss in note sales (FinCEN's business email compromise advisories), so:
// - UPB keeps the bank, the account name, the routing number and the last four digits, never the whole number;
// - a desk member who approves wires calls the seller on a number the desk found itself, never one from the request,
//   and logs the number, where it came from and what was said;
// - a different desk member who approves wires then marks the account verified, as with a wire change
//   (lib/wire-changes.ts). Anyone who approves wires can reject it;
// - a change retires the old account and starts over, and the seller is emailed on every change;
// - the seller's proceeds are recorded only against a verified account of the seller's (actions/closing.ts).

export const PAYOUT_STATUSES = ["PENDING", "VERIFIED", "REJECTED"] as const;

export const PAYOUT_NUMBER_NOTE =
  "UPB never stores your whole account number, only its last four digits. The desk confirms the full details with you by phone, on a number it finds itself, before any money goes out.";

export const PAYOUT_STATUS_LABELS: Record<string, string> = {
  PENDING: "Waiting for the desk's call-back",
  VERIFIED: "Verified by call-back",
  REJECTED: "Rejected",
};

// Where the number the desk dialled came from. Never the seller's request, or an email about it.
export const CALLBACK_SOURCES = [
  { value: "BANK_PUBLISHED", label: "The bank's own published number" },
  { value: "SELLER_FILE", label: "The seller file the desk verified" },
  { value: "EARLIER_DEAL", label: "A number used on an earlier closing" },
  { value: "OTHER", label: "Somewhere else, said in the note" },
] as const;

export function callbackSourceLabel(source: string | null | undefined) {
  return CALLBACK_SOURCES.find((item) => item.value === source)?.label ?? "Not logged";
}

// A seller keeps a few accounts at most. More reads as someone trying addresses.
export const MAX_ACTIVE_ACCOUNTS = 3;

// An ABA routing number: nine digits whose weighted sum (3, 7, 1 repeating) is a multiple of ten.
export function abaValid(routing: string) {
  if (!/^\d{9}$/.test(routing) || /^0{9}$/.test(routing)) return false;
  const digits = [...routing].map(Number);
  const sum = digits.reduce((total, digit, index) => total + digit * [3, 7, 1][index % 3], 0);
  return sum % 10 === 0;
}

export type PayoutEntry = { bankName: string; accountName: string; routingNumber: string; accountLast4: string };

const clean = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

// The entry as stored, or why it can't be. A whole account number typed into the last-four box is refused, not cut.
export function readPayoutEntry(input: PayoutEntry) {
  const bankName = clean(input.bankName, 120);
  const accountName = clean(input.accountName, 160);
  const routingNumber = input.routingNumber.replace(/[\s-]/g, "");
  const last4 = input.accountLast4.replace(/[\s-]/g, "");
  if (bankName.length < 2) return { error: "Enter the bank's name." } as const;
  if (accountName.length < 2) return { error: "Enter the name on the account." } as const;
  if (!/^\d{9}$/.test(routingNumber)) return { error: "Enter the bank's nine-digit routing number." } as const;
  if (!abaValid(routingNumber)) return { error: "That routing number doesn't check out. Copy it again from a cheque or the bank's site." } as const;
  if (/^\d{5,}$/.test(last4)) return { error: "Enter only the last four digits of the account number. UPB never stores the whole number." } as const;
  if (!/^\d{4}$/.test(last4)) return { error: "Enter the last four digits of the account number." } as const;
  return { error: null, entry: { bankName, accountName, routingNumber, accountLast4: last4 } } as const;
}

export function payoutLabel(account: { bankName: string; accountLast4: string }) {
  return `${account.bankName}, account ending ${account.accountLast4}`;
}

type Account = { id: string; userId: string; status: string; retiredAt: Date | null; bankName: string; accountLast4: string };

// Why proceeds can't go to this account, or null. No override: a payout account is checked or it isn't.
export function payoutGate(account: Account | null | undefined, sellerId: string) {
  if (!account) return "Choose the seller's payout account. Proceeds go only to an account the desk verified by call-back.";
  if (account.userId !== sellerId) return "That payout account isn't the seller's.";
  if (account.retiredAt) return "The seller changed that payout account, so the new one needs its own call-back.";
  if (account.status === "REJECTED") return "That payout account was rejected.";
  if (account.status !== "VERIFIED") return "That payout account isn't verified yet. One desk member logs the call-back and another verifies it.";
  return null;
}

// The account recording proceeds names, checked against the closing's seller.
export async function proceedsAccount(sellerId: string, accountId: string) {
  const account = accountId ? await prisma.payoutAccount.findUnique({ where: { id: accountId } }) : null;
  const problem = payoutGate(account, sellerId);
  return problem || !account ? ({ error: problem ?? "Choose the seller's payout account." } as const) : ({ error: null, account } as const);
}

// A seller's accounts that are still in use, newest first. Retired ones stay on record for the audit.
export async function activePayoutAccounts(userId: string) {
  return prisma.payoutAccount.findMany({ where: { userId, ...unset("retiredAt") }, orderBy: { createdAt: "desc" } });
}

const ALERT_TAIL =
  "If you didn't make this change, call the desk now on a number you already trust, not one in an email. The desk never changes where your proceeds go on an email's word.";

async function tellSeller(userId: string, subject: string, body: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  // A security alert, so it reaches the inbox whatever the seller's notice settings say.
  if (user) await sendAlert(user.email, subject, body);
}

type Seller = { id: string; role: string };

// The seller adds an account, or replaces one with `replaces`. A replaced account is retired at once, so proceeds
// can't go to it while the new one waits for its call-back.
export async function addPayoutAccount(seller: Seller, input: PayoutEntry & { replaces?: string | null }, now = new Date()) {
  if (!keepsSellerFile(seller.role)) return { error: "Only a seller adds a payout account." } as const;
  const read = readPayoutEntry(input);
  if (read.error !== null) return { error: read.error } as const;
  const replaced = input.replaces ? await prisma.payoutAccount.findUnique({ where: { id: input.replaces } }) : null;
  if (input.replaces && (!replaced || replaced.userId !== seller.id || replaced.retiredAt)) return { error: "That account is already changed. Reload the page." } as const;
  const active = await prisma.payoutAccount.count({ where: { userId: seller.id, ...unset("retiredAt") } });
  if (active - (replaced ? 1 : 0) >= MAX_ACTIVE_ACCOUNTS) return { error: `You can keep ${MAX_ACTIVE_ACCOUNTS} payout accounts. Remove one first.` } as const;
  if (replaced) {
    const retired = await prisma.payoutAccount.updateMany({ where: { id: replaced.id, ...unset("retiredAt") }, data: { retiredAt: now } });
    if (retired.count !== 1) return { error: "That account is already changed. Reload the page." } as const;
    await audit(seller.id, "PAYOUT_RETIRED", "payoutAccount", replaced.id, `${payoutLabel(replaced)}, replaced`);
  }
  const account = await prisma.payoutAccount.create({ data: { userId: seller.id, ...read.entry } });
  await audit(seller.id, "PAYOUT_ADDED", "payoutAccount", account.id, `${payoutLabel(account)} · routing ${account.routingNumber}${replaced ? ` · replaces ${replaced.id}` : ""}`);
  await tellSeller(
    seller.id,
    replaced ? "Your payout account changed" : "A payout account was added",
    `${replaced ? `Your payout account changed from ${payoutLabel(replaced)} to ${payoutLabel(account)}.` : `${payoutLabel(account)} was added as a payout account.`} The desk will call you on a number it finds itself before it can be used. ${ALERT_TAIL}`,
  );
  await notifyDesk(
    "Payout account to call back",
    `A seller ${replaced ? "changed" : "added"} a payout account: ${payoutLabel(account)}. Call them on a number you find yourself, not one from the request, and log it on the closing page.`,
    { capability: "approveWires" },
  );
  return { error: null, account } as const;
}

// The seller stops using an account. It stays on record, retired.
export async function retirePayoutAccount(seller: Seller, accountId: string, now = new Date()) {
  const account = await prisma.payoutAccount.findUnique({ where: { id: accountId } });
  if (!account || account.userId !== seller.id) return { error: "That account isn't yours." } as const;
  const retired = await prisma.payoutAccount.updateMany({ where: { id: account.id, ...unset("retiredAt") }, data: { retiredAt: now } });
  if (retired.count !== 1) return { error: "That account is already removed." } as const;
  await audit(seller.id, "PAYOUT_RETIRED", "payoutAccount", account.id, `${payoutLabel(account)}, removed`);
  await tellSeller(seller.id, "A payout account was removed", `${payoutLabel(account)} was removed from your payout accounts. Proceeds can't go to it now. ${ALERT_TAIL}`);
  return { error: null } as const;
}

type Actor = Staff & { id: string; name?: string };

const digits = (text: string) => text.replace(/\D/g, "");

// A desk member who approves wires logs the call-back: the number dialled, where the desk found it, and what was said.
// The number must not come from the request, so a number written into the request's own fields is refused.
export async function logCallback(actor: Actor, input: { accountId: string; phone: string; source: string; note: string; independent: boolean }, now = new Date()) {
  if (!deskCan(actor, "approveWires")) return { error: DESK_DENIED } as const;
  const account = await prisma.payoutAccount.findUnique({ where: { id: input.accountId } });
  if (!account || account.retiredAt) return { error: "That payout account was changed or removed." } as const;
  if (account.status !== "PENDING") return { error: "That payout account is already decided." } as const;
  const phone = digits(input.phone);
  if (phone.length < 10 || phone.length > 15) return { error: "Enter the number you dialled, with its area code." } as const;
  if (!CALLBACK_SOURCES.some((item) => item.value === input.source)) return { error: "Say where the desk found the number." } as const;
  const note = clean(input.note, 500);
  if (input.source === "OTHER" && note.length < 10) return { error: "Say where the number came from in the note." } as const;
  if (note.length < 10) return { error: "Say who answered and what they confirmed, in a sentence." } as const;
  if (!input.independent) return { error: "Confirm the number didn't come from the seller's request or an email about it." } as const;
  if (digits(`${account.bankName} ${account.accountName}`).includes(phone.slice(-7))) {
    return { error: "That number is written in the request itself. Find the number yourself and call that." } as const;
  }
  const logged = await prisma.payoutAccount.updateMany({
    where: { id: account.id, status: "PENDING", ...unset("retiredAt") },
    data: { callbackAt: now, callbackById: actor.id, callbackPhone: phone, callbackSource: input.source, callbackNote: note },
  });
  if (logged.count !== 1) return { error: "That payout account changed a moment ago. Reload the page." } as const;
  await audit(actor.id, "PAYOUT_CALLBACK", "payoutAccount", account.id, `Called ${phone} · ${callbackSourceLabel(input.source)} · ${note}`);
  await notifyDesk(
    "Payout account to verify",
    `${actor.name ?? "A desk member"} logged the call-back on ${payoutLabel(account)}. Another desk member who approves wires verifies it on the closing page.`,
    { capability: "approveWires" },
  );
  return { error: null } as const;
}

// A different desk member who approves wires verifies the account after the call-back. Anyone who approves wires
// rejects it, before or after it was verified.
export async function decidePayoutAccount(actor: Actor, input: { accountId: string; decision: string; note?: string }, now = new Date()) {
  if (!deskCan(actor, "approveWires")) return { error: DESK_DENIED } as const;
  if (input.decision !== "VERIFIED" && input.decision !== "REJECTED") return { error: "Choose verify or reject." } as const;
  const account = await prisma.payoutAccount.findUnique({ where: { id: input.accountId } });
  if (!account || account.retiredAt) return { error: "That payout account was changed or removed." } as const;
  const note = clean(input.note ?? "", 300);
  if (input.decision === "VERIFIED") {
    if (account.status !== "PENDING") return { error: "That payout account is already decided." } as const;
    if (!account.callbackAt || !account.callbackById) return { error: "Log the call-back first. Another desk member then verifies it." } as const;
    if (account.callbackById === actor.id) return { error: "You logged the call-back, so another desk member verifies it." } as const;
    const verified = await prisma.payoutAccount.updateMany({
      where: { id: account.id, status: "PENDING", callbackAt: account.callbackAt, callbackById: account.callbackById, ...unset("retiredAt") },
      data: { status: "VERIFIED", verifiedById: actor.id, verifiedAt: now },
    });
    if (verified.count !== 1) return { error: "That payout account changed a moment ago. Reload the page." } as const;
    await audit(actor.id, "PAYOUT_VERIFIED", "payoutAccount", account.id, `${payoutLabel(account)}, call-back by ${account.callbackById}${note ? ` · ${note}` : ""}`);
    await tellSeller(account.userId, "Your payout account is verified", `${payoutLabel(account)} is verified, so the desk can send your proceeds to it. ${ALERT_TAIL}`);
    return { error: null, status: "VERIFIED" } as const;
  }
  if (account.status === "REJECTED") return { error: "That payout account is already rejected." } as const;
  if (note.length < 3) return { error: "Say why it is rejected. The seller doesn't see the note." } as const;
  const rejected = await prisma.payoutAccount.updateMany({ where: { id: account.id, status: account.status, ...unset("retiredAt") }, data: { status: "REJECTED" } });
  if (rejected.count !== 1) return { error: "That payout account changed a moment ago. Reload the page." } as const;
  await audit(actor.id, "PAYOUT_REJECTED", "payoutAccount", account.id, `${payoutLabel(account)} · ${note}`);
  await tellSeller(account.userId, "Your payout account wasn't verified", `The desk couldn't verify ${payoutLabel(account)}, so proceeds won't go to it. Write the desk on your closing thread, or add the account again. ${ALERT_TAIL}`);
  return { error: null, status: "REJECTED" } as const;
}

// The seller's accounts on a closing page, with who called and who verified, for the desk.
export async function payoutAccountsFor(userId: string) {
  const accounts = await activePayoutAccounts(userId);
  const ids = [...new Set(accounts.flatMap((account) => [account.callbackById, account.verifiedById]).filter((id): id is string => Boolean(id)))];
  const people = ids.length ? new Map((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((person) => [person.id, person.name])) : new Map<string, string>();
  return accounts.map((account) => ({
    ...account,
    callbackBy: account.callbackById ? people.get(account.callbackById) ?? "A desk member" : null,
    verifiedBy: account.verifiedById ? people.get(account.verifiedById) ?? "A desk member" : null,
  }));
}
