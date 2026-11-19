import { prisma } from "@/lib/prisma";

// Banks and credit unions as buyers. A buyer file or buying entity can be a BANK or a CREDIT_UNION, and gives its
// charter number and regulator when it goes to the desk. It counts as a regulated institution once the desk has
// checked that charter against the regulator's public record and approved the file. A listing can be open to
// regulated institutions only (Listing.buyerLimit), for a credit union selling to credit unions or a bank selling
// to banks. Bids, group seats, matches and alerts hold to it.

export const INSTITUTION_TYPES = ["BANK", "CREDIT_UNION"] as const;

export function isInstitution(entityType: string | null | undefined) {
  return entityType === "BANK" || entityType === "CREDIT_UNION";
}

// Who charters and supervises the institution. A bank's primary regulator is the OCC for a national bank, the FDIC
// or the Federal Reserve for a state bank, or the state alone; a credit union's is the NCUA or the state.
export const REGULATORS = [
  { value: "OCC", label: "OCC", kinds: ["BANK"] },
  { value: "FDIC", label: "FDIC", kinds: ["BANK"] },
  { value: "FRB", label: "Federal Reserve", kinds: ["BANK"] },
  { value: "NCUA", label: "NCUA", kinds: ["CREDIT_UNION"] },
  { value: "STATE", label: "State regulator", kinds: ["BANK", "CREDIT_UNION"] },
] as const;

export function regulatorLabel(value: string | null | undefined) {
  return REGULATORS.find((regulator) => regulator.value === value)?.label ?? (value || "");
}

// What the charter number is, by kind. Every insured bank has an FDIC certificate whoever supervises it, and every
// federally insured credit union has an NCUA charter number, state-chartered ones included.
export function charterLabel(entityType: string | null | undefined) {
  return entityType === "CREDIT_UNION" ? "NCUA charter number" : "FDIC certificate number";
}

export const CHARTER_NOTE = "The desk checks it against the regulator's public record before this counts as a bank or credit union for sales open to them only.";

export type Charter = { charterNumber: string; regulator: string };

// The number and regulator as the form sent them, checked. Both numbers are digits; a few leading zeros or spaces
// are dropped so the lookup link reads the number the regulator uses. Any other kind of entity keeps neither.
export function readCharter(entityType: string, input: { charterNumber?: unknown; regulator?: unknown }) {
  if (!isInstitution(entityType)) return { error: null, data: { charterNumber: null, regulator: null } } as const;
  const raw = String(input.charterNumber ?? "").replace(/[\s#-]/g, "");
  if (!/^\d{1,6}$/.test(raw) || Number(raw) === 0) {
    return { error: entityType === "BANK" ? "Enter the bank's FDIC certificate number, in digits." : "Enter the credit union's NCUA charter number, in digits." } as const;
  }
  const regulator = String(input.regulator ?? "").trim().toUpperCase();
  const known = REGULATORS.find((option) => option.value === regulator);
  if (!known || !(known.kinds as readonly string[]).includes(entityType)) {
    return { error: entityType === "BANK" ? "Choose the bank's regulator: the OCC, the FDIC, the Federal Reserve or a state regulator." : "Choose the credit union's regulator: the NCUA or a state regulator." } as const;
  }
  return { error: null, data: { charterNumber: String(Number(raw)), regulator } } as const;
}

type CharterFile = { entityType: string; charterNumber?: string | null; regulator?: string | null };

// The file's charter, when it has one in the right shape. Null for any other entity, or a number the form never
// checked.
export function charterOf(file: CharterFile | null | undefined): Charter | null {
  if (!file || !isInstitution(file.entityType)) return null;
  const read = readCharter(file.entityType, file);
  return read.error === null && read.data.charterNumber && read.data.regulator ? { charterNumber: read.data.charterNumber, regulator: read.data.regulator } : null;
}

// The regulator's own public page for this number, for the desk to open in its browser. Built from the number
// alone; UPB never fetches it.
export function charterLookup(file: CharterFile | null | undefined) {
  const charter = charterOf(file);
  if (!charter) return null;
  const number = encodeURIComponent(charter.charterNumber);
  return file!.entityType === "CREDIT_UNION"
    ? { label: "NCUA credit union locator", href: `https://mapping.ncua.gov/SingleResult.aspx?ID=${number}` }
    : { label: "FDIC BankFind", href: `https://banks.data.fdic.gov/bankfind-suite/bankfind/details/${number}` };
}

// The charter as one line for the desk.
export function charterLine(file: CharterFile | null | undefined) {
  const charter = charterOf(file);
  if (!file || !isInstitution(file.entityType)) return "";
  if (!charter) return "no charter number on file";
  return `${charterLabel(file.entityType)} ${charter.charterNumber} · ${regulatorLabel(charter.regulator)}`;
}

// Why the desk can't approve a bank or credit union yet, or null. The charter must be on file and the reviewer must
// say they checked it against the regulator's record.
export function charterApprovalBlock(file: CharterFile, checked: boolean) {
  if (!isInstitution(file.entityType)) return null;
  if (!charterOf(file)) return "This file has no charter number and regulator in the right shape. Ask the buyer for them before approving.";
  if (!checked) return "Check the charter number on the regulator's public record, tick that you did, then approve.";
  return null;
}

type ReviewedFile = CharterFile & { status: string };

// A bank or credit union the desk approved, with its charter checked. Approval of either kind waits on that check
// (charterApprovalBlock), so an approved one with its charter on file was checked.
export function regulatedFile(file: ReviewedFile | null | undefined) {
  return Boolean(file && file.status === "APPROVED" && charterOf(file));
}

const FILE_FIELDS = { entityType: true, status: true, charterNumber: true, regulator: true } as const;

// Whether this buyer bids as a regulated institution: through the buying entity named, or the main file when none is.
// An entity that isn't the buyer's own never counts.
export async function isRegulatedBuyer(user: { id: string }, buyerEntityId?: string | null) {
  if (buyerEntityId) {
    const entity = await prisma.buyerEntity.findUnique({ where: { id: buyerEntityId }, select: { userId: true, ...FILE_FIELDS } });
    return Boolean(entity && entity.userId === user.id && regulatedFile(entity));
  }
  return regulatedFile(await prisma.buyerProfile.findUnique({ where: { userId: user.id }, select: FILE_FIELDS }));
}

// The buyers among these with a regulated institution anywhere on their file, main file or entity. Matches and alerts
// read it, since the buyer picks the entity only when they bid.
export async function regulatedUserIds(userIds: string[]) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Set<string>();
  const where = { userId: { in: ids }, entityType: { in: [...INSTITUTION_TYPES] }, status: "APPROVED" as const };
  const [profiles, entities] = await Promise.all([
    prisma.buyerProfile.findMany({ where, select: { userId: true, ...FILE_FIELDS } }),
    prisma.buyerEntity.findMany({ where, select: { userId: true, ...FILE_FIELDS } }),
  ]);
  return new Set([...profiles, ...entities].filter(regulatedFile).map((file) => file.userId));
}

// ---------------------------------------------------------------------------------------------------------------
// The listing's limit.

export const REGULATED = "REGULATED";
export const REGULATED_ONLY_LINE = "This sale is open to banks and credit unions only.";
export const REGULATED_SWITCH = "Only banks and credit unions may bid";

type Limited = { buyerLimit?: string | null };

export function regulatedOnly(listing: Limited | null | undefined) {
  return listing?.buyerLimit === REGULATED;
}

// Why this bid can't go in on a listing open to banks and credit unions only, or null. Missing means any approved
// buyer, as every listing was before the limit existed.
export async function regulatedBlock(listing: Limited, user: { id: string }, buyerEntityId: string | null, options: { seat?: boolean } = {}) {
  if (!regulatedOnly(listing) || (await isRegulatedBuyer(user, buyerEntityId))) return null;
  if (options.seat) return `${REGULATED_ONLY_LINE} A group seat is for your main buyer file, which the desk hasn't approved as one.`;
  // A buyer with a bank or credit union on file only picked the wrong entity.
  if ((await regulatedUserIds([user.id])).has(user.id)) return `${REGULATED_ONLY_LINE} Choose your bank or credit union as the buying entity.`;
  return REGULATED_ONLY_LINE;
}

// The line a buyer reads in place of the bid form on a listing open to banks and credit unions only, when nothing on
// their file is one. Null when they can bid, and for anyone who isn't a buyer. The listing still shows on the book.
export async function regulatedLineFor(listing: Limited, viewer: { id: string; role: string }) {
  if (!regulatedOnly(listing) || viewer.role !== "BUYER") return null;
  return (await regulatedUserIds([viewer.id])).has(viewer.id) ? null : REGULATED_ONLY_LINE;
}

// The people a listing open to banks and credit unions only may reach with a match or an alert: those with one on
// file, and the desk. Everyone, for any other listing.
export async function keepRegulated<T extends { id: string; role?: string | null }>(listing: Limited, people: T[]): Promise<T[]> {
  if (!regulatedOnly(listing) || !people.length) return people;
  const regulated = await regulatedUserIds(people.map((person) => person.id));
  return people.filter((person) => person.role === "ADMIN" || regulated.has(person.id));
}

// The listings among these one buyer may be alerted to.
export async function listingsForBuyer<T extends Limited>(userId: string, listings: T[]): Promise<T[]> {
  if (!listings.some(regulatedOnly)) return listings;
  const regulated = (await regulatedUserIds([userId])).has(userId);
  return regulated ? listings : listings.filter((listing) => !regulatedOnly(listing));
}

// A bank or credit union the desk just approved matches the listings open to them only from now on, so its buy boxes
// are scored again, quietly. Imported late, since matching reaches the bid checks that read this file.
export async function rematchInstitution(userId: string, entityType: string) {
  if (!isInstitution(entityType)) return;
  const boxes = await prisma.buyBox.findMany({ where: { userId, active: true }, select: { id: true } });
  if (!boxes.length) return;
  const { rescoreBox } = await import("@/lib/matching");
  for (const box of boxes) await rescoreBox(box.id, { quiet: true });
}
