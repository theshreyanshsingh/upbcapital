import { audit } from "@/lib/audit";
import { unset } from "@/lib/db-filters";
import { DESK_DENIED, deskCan, type Staff } from "@/lib/desk-roles";
import { notify, notifyDesk, sendAlert } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { OFAC_DOWN_MESSAGE, freshScreenBlock, nameHold, ofacHold, screenAndRecord, screenInBackground } from "@/lib/screening";
import { normalizeName } from "@/lib/sdn";
import { keepsSellerFile } from "@/lib/seller-identity";

// A seller's account for proceeds, or a broker's for fees, checked by call-back before any money goes to it. Changed
// payout details sent by email are the classic loss in note sales (FinCEN's business email compromise advisories), so:
// - UPB keeps the bank, the account name, the routing number and the last four digits, never the whole number;
// - a desk member who approves wires calls the seller on a number the desk found itself, never one from the request,
//   and logs the number, where it came from and what was said;
// - a different desk member who approves wires then marks the account verified, as with a wire change
//   (lib/wire-changes.ts). Anyone who approves wires can reject it;
// - the name on the account is screened against the sanctions list when it is added, and again when the desk
//   verifies it, waiting for the answer. An open or confirmed match holds the account until compliance clears it;
// - a name that isn't the vetted seller's needs a reason from the desk member who verifies it, and that is audited;
// - a change retires the old account and starts over, and the seller is emailed on every change;
// - the seller's proceeds are recorded only against a verified account of the seller's (actions/closing.ts), and a
//   broker's fee is paid only to a verified account of the broker's, in two steps by two desk members (below).

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

type Account = { id: string; userId: string; status: string; retiredAt: Date | null; bankName: string; accountLast4: string; screenResult?: string | null };

export const PAYOUT_HOLD_MESSAGE = "An OFAC match on the name on this payout account is open or confirmed. Check it under Compliance first.";

// Why proceeds or a fee can't go to this account, or null. No override: a payout account is checked or it isn't.
// screenResult is REVIEW while a match on the name on the account holds it.
export function payoutGate(account: Account | null | undefined, ownerId: string, party: "seller" | "broker" = "seller") {
  if (!account) {
    return party === "broker"
      ? "Choose the broker's payout account. Broker fees go only to an account the desk verified by call-back."
      : "Choose the seller's payout account. Proceeds go only to an account the desk verified by call-back.";
  }
  if (account.userId !== ownerId) return `That payout account isn't the ${party}'s.`;
  if (account.retiredAt) return `The ${party} changed that payout account, so the new one needs its own call-back.`;
  if (account.screenResult === "REVIEW") return PAYOUT_HOLD_MESSAGE;
  if (account.status === "REJECTED") return "That payout account was rejected.";
  if (account.status !== "VERIFIED") return "That payout account isn't verified yet. One desk member logs the call-back and another verifies it.";
  return null;
}

// The gate, with the compliance log read as it stands now: a match reopened or confirmed after the account was
// verified holds it too.
async function accountProblem(account: (Account & { accountName: string }) | null, ownerId: string, party: "seller" | "broker") {
  const problem = payoutGate(account, ownerId, party);
  if (problem || !account) return problem;
  return (await nameHold(account.userId, [account.accountName])) ? PAYOUT_HOLD_MESSAGE : null;
}

// The account recording proceeds names, checked against the closing's seller.
export async function proceedsAccount(sellerId: string, accountId: string) {
  const account = accountId ? await prisma.payoutAccount.findUnique({ where: { id: accountId } }) : null;
  const problem = await accountProblem(account, sellerId, "seller");
  return problem || !account ? ({ error: problem ?? "Choose the seller's payout account." } as const) : ({ error: null, account } as const);
}

// The names an account may be in without a reason: the entity the desk approved on the seller file (a broker keeps
// one too), or with no approved file, the account's company or name.
export async function vettedPayeeNames(userId: string) {
  const [user, file] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { name: true, companyName: true } }),
    prisma.sellerProfile.findUnique({ where: { userId }, select: { status: true, entityName: true } }),
  ]);
  if (file?.status === "APPROVED" && file.entityName.trim()) return [file.entityName.trim()];
  return [...new Set([user?.companyName ?? "", user?.name ?? ""].map((name) => name.trim()).filter(Boolean))];
}

// The same party, like sameParty in lib/broker-fees.ts, but blind to punctuation and accents too, so "Harbor
// Notes, LLC" is "Harbor Notes LLC". A different legal form is a different party.
export function sameHolder(accountName: string, names: string[]) {
  const holder = normalizeName(accountName);
  return holder.length > 0 && names.some((name) => normalizeName(name) === holder);
}

// The sanctions screen on the name on the account, stored on it. REVIEW while a match holds it: an open or
// confirmed one. A match the desk already cleared for this party and list entry carries forward (lib/screening.ts).
// A list that can't be read stores nothing, and verifying screens again.
export async function screenPayoutAccount(account: { id: string; userId: string; accountName: string; bankName: string; accountLast4: string }, now = new Date()) {
  const result = await screenAndRecord(account.accountName, { context: `Payout account holder · ${payoutLabel(account)}`, userId: account.userId });
  if (result.unavailable) return { unavailable: true, held: false } as const;
  await prisma.payoutAccount.updateMany({ where: { id: account.id }, data: { screenResult: result.blocked ? "REVIEW" : "CLEAR", screenedAt: now } });
  return { unavailable: false, held: result.blocked } as const;
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

// The seller or broker adds an account, or replaces one with `replaces`. A replaced account is retired at once, so
// money can't go to it while the new one waits for its call-back. The name on it is screened in the background, since
// the person is waiting and verifying screens again and waits for the answer.
export async function addPayoutAccount(seller: Seller, input: PayoutEntry & { replaces?: string | null }, now = new Date()) {
  if (!keepsSellerFile(seller.role)) return { error: "Only a seller or a broker adds a payout account." } as const;
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
  screenInBackground(() => screenPayoutAccount(account));
  await tellSeller(
    seller.id,
    replaced ? "Your payout account changed" : "A payout account was added",
    `${replaced ? `Your payout account changed from ${payoutLabel(replaced)} to ${payoutLabel(account)}.` : `${payoutLabel(account)} was added as a payout account.`} The desk will call you on a number it finds itself before it can be used. ${ALERT_TAIL}`,
  );
  const broker = seller.role === "BROKER";
  await notifyDesk(
    "Payout account to call back",
    `A ${broker ? "broker" : "seller"} ${replaced ? "changed" : "added"} a payout account: ${payoutLabel(account)}. Call them on a number you find yourself, not one from the request, and log it on the ${broker ? "payouts page (/admin/payouts)" : "closing page"}.`,
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
    `${actor.name ?? "A desk member"} logged the call-back on ${payoutLabel(account)}. Another desk member who approves wires verifies it on the closing page, or for a broker's account at /admin/payouts.`,
    { capability: "approveWires" },
  );
  return { error: null } as const;
}

// A different desk member who approves wires verifies the account after the call-back. Verifying screens the name on
// the account again and waits, and a name that isn't the vetted seller's needs that member's reason, at least a
// sentence, kept in the audit log. Anyone who approves wires rejects it, before or after it was verified.
export async function decidePayoutAccount(actor: Actor, input: { accountId: string; decision: string; note?: string; reason?: string }, now = new Date()) {
  if (!deskCan(actor, "approveWires")) return { error: DESK_DENIED } as const;
  if (input.decision !== "VERIFIED" && input.decision !== "REJECTED") return { error: "Choose verify or reject." } as const;
  const account = await prisma.payoutAccount.findUnique({ where: { id: input.accountId } });
  if (!account || account.retiredAt) return { error: "That payout account was changed or removed." } as const;
  const note = clean(input.note ?? "", 300);
  if (input.decision === "VERIFIED") {
    if (account.status !== "PENDING") return { error: "That payout account is already decided." } as const;
    if (!account.callbackAt || !account.callbackById) return { error: "Log the call-back first. Another desk member then verifies it." } as const;
    if (account.callbackById === actor.id) return { error: "You logged the call-back, so another desk member verifies it." } as const;
    const vetted = await vettedPayeeNames(account.userId);
    const mismatch = !sameHolder(account.accountName, vetted);
    const reason = clean(input.reason ?? "", 300);
    if (mismatch && reason.length < 10) {
      return { error: `The name on the account, ${account.accountName}, isn't ${vetted[0] ?? "the vetted name"}, the name the desk vetted. Say why the desk accepts it, in a sentence.` } as const;
    }
    const screen = await screenPayoutAccount(account, now);
    if (screen.unavailable) return { error: OFAC_DOWN_MESSAGE } as const;
    if (screen.held || (await nameHold(account.userId, [account.accountName]))) return { error: PAYOUT_HOLD_MESSAGE } as const;
    const verified = await prisma.payoutAccount.updateMany({
      where: { id: account.id, status: "PENDING", callbackAt: account.callbackAt, callbackById: account.callbackById, ...unset("retiredAt") },
      data: { status: "VERIFIED", verifiedById: actor.id, verifiedAt: now },
    });
    if (verified.count !== 1) return { error: "That payout account changed a moment ago. Reload the page." } as const;
    if (mismatch) await audit(actor.id, "PAYOUT_NAME_MISMATCH", "payoutAccount", account.id, `${account.accountName} against ${vetted.join(" or ") || "no vetted name"} · ${reason}`);
    await audit(actor.id, "PAYOUT_VERIFIED", "payoutAccount", account.id, `${payoutLabel(account)}, call-back by ${account.callbackById}${note ? ` · ${note}` : ""}`);
    await tellSeller(account.userId, "Your payout account is verified", `${payoutLabel(account)} is verified, so the desk can send your proceeds or fees to it. ${ALERT_TAIL}`);
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

// The seller's accounts on a closing page, with who called and who verified, for the desk. Each says whether a
// sanctions match holds it now, and whether its name is the vetted one (vetted lists the names that would pass).
export async function payoutAccountsFor(userId: string) {
  const accounts = await activePayoutAccounts(userId);
  const ids = [...new Set(accounts.flatMap((account) => [account.callbackById, account.verifiedById]).filter((id): id is string => Boolean(id)))];
  const [people, vetted, holds] = await Promise.all([
    ids.length ? prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }).then((rows) => new Map(rows.map((person) => [person.id, person.name]))) : new Map<string, string>(),
    vettedPayeeNames(userId),
    Promise.all(accounts.map((account) => nameHold(userId, [account.accountName]))),
  ]);
  return accounts.map((account, index) => ({
    ...account,
    callbackBy: account.callbackById ? people.get(account.callbackById) ?? "A desk member" : null,
    verifiedBy: account.verifiedById ? people.get(account.verifiedById) ?? "A desk member" : null,
    held: account.screenResult === "REVIEW" || Boolean(holds[index]),
    vetted,
    nameMatches: sameHolder(account.accountName, vetted),
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Broker fees. A fee leaves only to a verified payout account of the broker's, in two steps by two desk members:
// - one who approves wires approves the fee to that account. That screens the broker and the name on the account
//   against today's list and waits; a match or a list that can't be read stops it;
// - a different desk member who runs closings records it paid once the money has gone.
// The broker's payout note says how they like to be paid. It is never where the money goes.

const feeDollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const BROKER_HOLD_MESSAGE = "An OFAC match on this broker or the name on their payout account is open or confirmed. Check it under Compliance before paying.";

function loadFee(feeId: string) {
  return prisma.brokerFee.findUnique({ where: { id: feeId }, include: { broker: true, closing: { include: { listing: { select: { title: true } } } } } });
}

export async function approveBrokerFee(actor: Actor, input: { feeId: string; accountId: string }, now = new Date()) {
  if (!deskCan(actor, "approveWires")) return { error: DESK_DENIED } as const;
  const fee = input.feeId ? await loadFee(input.feeId) : null;
  if (!fee || fee.status !== "OWED") return { error: "That fee is not waiting." } as const;
  // An approval stands while its account does. One that has since been changed, rejected or held is approved again.
  if (fee.approvedAt && fee.payoutAccountId) {
    const approvedTo = await prisma.payoutAccount.findUnique({ where: { id: fee.payoutAccountId } });
    if (!(await accountProblem(approvedTo, fee.brokerId, "broker"))) return { error: "That fee is already approved. Another desk member records it paid." } as const;
  }
  const account = input.accountId ? await prisma.payoutAccount.findUnique({ where: { id: input.accountId } }) : null;
  const problem = await accountProblem(account, fee.brokerId, "broker");
  if (problem || !account) return { error: problem ?? "Choose the broker's payout account." } as const;
  const block = await freshScreenBlock(fee.brokerId, [fee.broker.name, fee.broker.companyName, account.accountName], `Broker fee on ${fee.closing.listing.title}`, BROKER_HOLD_MESSAGE);
  if (block) return { error: block } as const;
  const approved = await prisma.brokerFee.updateMany({
    where: { id: fee.id, status: "OWED", ...(fee.approvedAt ? { approvedAt: fee.approvedAt } : unset("approvedAt")) },
    data: { payoutAccountId: account.id, approvedById: actor.id, approvedAt: now },
  });
  if (approved.count !== 1) return { error: "That fee changed a moment ago. Reload the page." } as const;
  await audit(actor.id, "BROKER_FEE_APPROVED", "brokerFee", fee.id, `${feeDollars(fee.amountCents)} to ${payoutLabel(account)} (${account.id}) · ${fee.broker.email}`);
  await notifyDesk(
    `Broker fee to record paid · ${fee.broker.name}`,
    `${actor.name ?? "A desk member"} approved ${feeDollars(fee.amountCents)} on ${fee.closing.listing.title} to ${payoutLabel(account)}. Once the money has gone, another desk member records it paid at /admin/payouts.`,
    { capability: "closings" },
  );
  return { error: null } as const;
}

export async function recordBrokerFeePaid(actor: Actor, input: { feeId: string }, now = new Date()) {
  if (!deskCan(actor, "closings")) return { error: DESK_DENIED } as const;
  const fee = input.feeId ? await loadFee(input.feeId) : null;
  if (!fee || fee.status !== "OWED") return { error: "That fee is not waiting." } as const;
  if (!fee.approvedAt || !fee.approvedById || !fee.payoutAccountId) {
    return { error: "Approve the fee to a verified payout account of the broker's first. Another desk member then records it paid." } as const;
  }
  if (fee.approvedById === actor.id) return { error: "You approved this fee, so another desk member records it paid." } as const;
  const account = await prisma.payoutAccount.findUnique({ where: { id: fee.payoutAccountId } });
  const problem = await accountProblem(account, fee.brokerId, "broker");
  if (problem === PAYOUT_HOLD_MESSAGE) return { error: problem } as const;
  if (problem || !account) return { error: `${problem ?? "The approved account is gone."} Approve the fee again to a verified account.` } as const;
  if (await ofacHold({ userIds: [fee.brokerId] })) return { error: BROKER_HOLD_MESSAGE } as const;
  const paid = await prisma.brokerFee.updateMany({
    where: { id: fee.id, status: "OWED", approvedById: fee.approvedById, payoutAccountId: fee.payoutAccountId },
    data: { status: "PAID", paidAt: now, paidById: actor.id },
  });
  if (paid.count !== 1) return { error: "That fee changed a moment ago. Reload the page." } as const;
  await audit(actor.id, "broker.paid", "BrokerFee", fee.id, `${feeDollars(fee.amountCents)} to ${payoutLabel(account)} (${account.id}) · approved by ${fee.approvedById} · ${fee.broker.email}`);
  await notify(fee.broker.email, "Broker fee marked paid", `The desk marked ${feeDollars(fee.amountCents)} paid on ${fee.closing.listing.title}, to ${payoutLabel(account)}.`);
  return { error: null } as const;
}
