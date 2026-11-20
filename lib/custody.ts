import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { audit } from "@/lib/audit";
import { calendarDay } from "@/lib/borrower-notices";
import { closingLoans } from "@/lib/closing";
import { buyerSideEmails } from "@/lib/closing-service";
import { unset } from "@/lib/db-filters";
import { DESK_DENIED, deskCan, type Staff } from "@/lib/desk-roles";
import { notify, notifyDesk } from "@/lib/email";
import { isENote } from "@/lib/enotes";
import { money, prettyDate } from "@/lib/format";
import { pdfSafe, wrap } from "@/lib/memo-pdf";
import { prisma } from "@/lib/prisma";
import { sellerOnTitle } from "@/lib/seller-identity";
import { moneyGate } from "@/lib/settlement";
import { extensionOf, mimeFor, putBytes, safeBasename } from "@/lib/storage";
import { completeIfDone, custodyExceptionOpen, viewerSide, type Side } from "@/lib/trailing-docs";
import { uploadProblem } from "@/lib/uploads";
import { namesOnTitle } from "@/lib/vesting";

// The collateral file's custody. Institutional buyers keep the original notes, allonges and assignments at a
// document custodian. The buyer side names it on the closing (the desk does on its own purchases), or says it holds
// the file itself, and the seller ships the file there. Collateral that ships before the purchase price is on record
// goes under a bailee letter: the custodian holds it in trust for the seller until the seller is paid, and sends it
// back if the sale doesn't close. Once the file arrives the buyer side records the custodian's receipt, and any
// exceptions the custodian finds on review, missing or defective documents, until they clear. An open exception keeps
// the post-closing file open (completeIfDone in lib/trailing-docs.ts). UPB holds neither the file nor the money; this
// is the record of who does.

export { custodyExceptionOpen };

// Stored as the custodian's name when the buyer keeps the collateral file itself. No custodian goes by it, and every
// reader goes through custodianLabel.
export const SELF_HELD = "BUYER_HOLDS_FILE";

// The business days the letter gives the custodian to send the file back if the sale doesn't close. Counsel confirms.
export const BAILEE_RETURN_DAYS = 5;

const NAME_MAX = 120;
const CONTACT_MAX = 300;
const EXCEPTIONS_MAX = 2000;

export type CustodyFields = {
  custodianName?: string | null;
  custodianContact?: string | null;
  baileeLetterAt?: Date | null;
  custodianReceiptAt?: Date | null;
  custodianExceptions?: string | null;
  exceptionsClearedAt?: Date | null;
};

const squeeze = (value: unknown, max: number) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// Text kept line by line, such as an address or a list of exceptions.
function readLines(value: unknown, max: number) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, max);
}

const oneLine = (text: string) => text.trim().replace(/\s*\n\s*/g, "; ");

export function selfHeld(closing: CustodyFields) {
  return closing.custodianName === SELF_HELD;
}

// Who holds the file, in words. Null when no one is named yet. `buyer` names the buyer side: the buyer, or UPB
// Capital on a desk purchase.
export function custodianLabel(closing: CustodyFields, buyer = "The buyer") {
  const name = closing.custodianName?.trim();
  if (!name) return null;
  return name === SELF_HELD ? `${buyer}, holding the file itself` : name;
}

export function buyerWord(closing: { deskBidId?: string | null }) {
  return closing.deskBidId ? "UPB Capital" : "The buyer";
}

// The open exceptions in one line, for a list. Null when none are open.
export function exceptionsLine(closing: CustodyFields, max = 160) {
  if (!custodyExceptionOpen(closing)) return null;
  const text = oneLine(closing.custodianExceptions ?? "");
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// Every closing with custodian exceptions still open, dated by the latest time they were recorded, for the desk's
// risk queue (lib/risk-queue.ts).
export async function openCustodyExceptions() {
  const rows = await prisma.closing.findMany({
    where: { custodianExceptions: { not: null }, AND: [unset("exceptionsClearedAt")] },
    select: { id: true, deskBidId: true, deskOwnerId: true, custodianName: true, custodianExceptions: true, exceptionsClearedAt: true, custodianReceiptAt: true, listing: { select: { title: true } } },
  });
  const open = rows.filter(custodyExceptionOpen);
  const events = open.length
    ? await prisma.auditEvent.findMany({ where: { entityType: "closing", entityId: { in: open.map((row) => row.id) }, action: "CUSTODY_EXCEPTIONS" }, select: { entityId: true, createdAt: true }, orderBy: { createdAt: "desc" } })
    : [];
  const recorded = new Map<string, Date>();
  for (const event of events) if (!recorded.has(event.entityId)) recorded.set(event.entityId, event.createdAt);
  return open.map((row) => ({ ...row, recordedAt: recorded.get(row.id) ?? row.custodianReceiptAt ?? null, line: exceptionsLine(row) ?? "" }));
}

// The collateral has left the seller once the desk marks the file transfer step done, an original note, allonge or
// eNote transfer on the trailing list is recorded as sent or received, or the custodian's receipt is on file.
const MOVED = new Set(["ORIGINAL_NOTE", "ALLONGE", "ENOTE_CONTROL", "ENOTE_LOCATION"]);

export function collateralShipped(input: { custodianReceiptAt?: Date | null; steps: { key: string; status: string }[]; trailingDocs: { kind: string; status: string }[] }) {
  return (
    Boolean(input.custodianReceiptAt) ||
    input.steps.some((step) => step.key === "COLLATERAL_TRANSFER" && step.status === "COMPLETE") ||
    input.trailingDocs.some((doc) => MOVED.has(doc.kind) && (doc.status === "SENT" || doc.status === "RECEIVED"))
  );
}

// Whether the purchase price is on record, so the collateral can ship outright: the buyer's balance wire recorded in
// full, counting the deposit, with every group share funded, the same test the payment step uses. A desk purchase
// has no buyer wire; there the desk's own payment to the seller is the price received.
type FundsClosing = Parameters<typeof moneyGate>[1] & { proceedsSentAt?: Date | null };

export function purchaseFunded(closing: FundsClosing, funders: { status: string }[]) {
  if (closing.deskBidId) return closing.proceedsSentAt != null;
  return moneyGate("PAYMENT_RECEIVED", closing, funders) === null;
}

export function baileeNotNeeded(closing: { deskBidId?: string | null }) {
  return closing.deskBidId
    ? "A bailee letter isn't needed: the desk's payment to the seller is recorded, so the collateral can ship outright."
    : "A bailee letter isn't needed: the buyer's funds are recorded, so the collateral can ship outright.";
}

export function baileeExplainer(closing: { deskBidId?: string | null }) {
  const before = closing.deskBidId ? "before the desk's payment to the seller is recorded" : "before the buyer's funds are recorded";
  return `Collateral that ships ${before} goes under a bailee letter: the custodian holds the file in trust for the seller until the purchase price is received, and sends it back within ${BAILEE_RETURN_DAYS} business days if the sale doesn't close. The letter is a desk draft in UPB's reading; counsel confirms the wording.`;
}

// The trailing list's original-note items and the custodian's receipt are one delivery seen from two records. The
// item says the note reached the buyer side, as the buyer confirmed when the courier delivered it. The receipt is
// the custodian's own statement that it holds the file for the buyer, usually a trust receipt issued after its
// intake review. So the receipt falls on the day the note arrived or later, and never before the note was sent.
// Once every original note on the list is received, the latest of those days is the date the receipt form suggests,
// and a receipt dated before the first note went out is refused as a conflict between the two records.
export function noteReceipt(docs: { kind: string; status: string; sentAt: Date | null; receivedAt: Date | null }[]) {
  const notes = docs.filter((doc) => doc.kind === "ORIGINAL_NOTE" && doc.status !== "WAIVED");
  const received = notes.filter((doc) => doc.status === "RECEIVED" && doc.receivedAt);
  const sent = notes.map((doc) => doc.sentAt).filter((at): at is Date => Boolean(at));
  const latest = received.reduce<Date | null>((at, doc) => (!at || doc.receivedAt! > at ? doc.receivedAt! : at), null);
  return {
    notes: notes.length,
    received: received.length,
    suggested: notes.length > 0 && received.length === notes.length ? latest : null,
    firstSentAt: sent.reduce<Date | null>((at, day) => (!at || day < at ? day : at), null),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Loading and who may act

type Actor = Staff & { id: string };
type Outcome<T = null> = { ok: true; value: T } | { ok: false; error: string };
export type CustodyUpload = { name: string; type: string; bytes: Buffer };

const fail = (error: string) => ({ ok: false as const, error });

async function loadCustody(closingId: string) {
  const closing = closingId
    ? await prisma.closing.findUnique({
        where: { id: closingId },
        include: {
          listing: {
            select: {
              id: true,
              title: true,
              sellerId: true,
              seller: { select: { id: true, name: true, companyName: true, email: true } },
              notes: { select: { id: true, city: true, state: true, loanNumber: true, eNote: true }, orderBy: { createdAt: "asc" } },
            },
          },
          funders: { select: { userId: true, status: true, entityName: true, user: { select: { name: true } } } },
          steps: { select: { id: true, key: true, status: true } },
          trailingDocs: { select: { kind: true, status: true, sentAt: true, receivedAt: true } },
        },
      })
    : null;
  if (!closing) return null;
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, select: { buyerId: true } }) : null;
  const buyerIds = [inquiry?.buyerId, ...closing.funders.map((funder) => funder.userId)].filter((id): id is string => Boolean(id));
  return { closing, buyerId: inquiry?.buyerId ?? null, buyerIds };
}

type Loaded = NonNullable<Awaited<ReturnType<typeof loadCustody>>>;

async function custodyFor(actor: Actor, closingId: string): Promise<{ error: string } | (Loaded & { error: null; side: Side })> {
  const found = await loadCustody(closingId);
  if (!found) return { error: "That closing isn't here." };
  const side = viewerSide(actor, { sellerId: found.closing.listing.sellerId, buyerIds: found.buyerIds });
  if (!side) return { error: "Only the parties and the desk keep the custody record." };
  if (side === "desk" && !deskCan(actor, "closings")) return { error: DESK_DENIED };
  if (found.closing.status === "CANCELED") return { error: "This closing was canceled." };
  return { ...found, error: null, side };
}

// The buyer side keeps the custodian, its receipt and its exceptions: the buyer or a seat of its group, or the desk,
// which is the buyer side on its own purchase.
function keeps(closing: { deskBidId: string | null }, side: Side) {
  return side === "desk" || (side === "buyer" && !closing.deskBidId);
}

const keeperOnly = (closing: { deskBidId: string | null }, what: string) => (closing.deskBidId ? `The desk ${what} on its own purchase.` : `The buyer ${what}, or the desk.`);

const actorWord = (side: Side) => (side === "desk" ? "The desk" : side === "seller" ? "The seller" : "The buyer");

const link = (closingId: string) => `${process.env.NEXT_PUBLIC_APP_URL || ""}/closings/${closingId}#custody`;

// The buyer side hears: its buyers, or the closings desk on its own purchase.
async function tellBuyerSide(closing: { id: string; deskBidId: string | null }, subject: string, body: string) {
  if (closing.deskBidId) return notifyDesk(subject, body, { capability: "closings" });
  for (const email of await buyerSideEmails(closing.id)) await notify(email, subject, body);
}

export const SHIPPED_CHANGE = "The collateral has shipped, so only the desk can change the custodian. Write the desk on the closing thread.";

// ---------------------------------------------------------------------------------------------------------------
// Naming the custodian

export async function nameCustodian(actor: Actor, input: { closingId: string; name?: unknown; contact?: unknown; selfHeld?: boolean }): Promise<Outcome<{ changed: boolean }>> {
  const found = await custodyFor(actor, input.closingId);
  if (found.error !== null) return fail(found.error);
  const { closing, side } = found;
  if (!keeps(closing, side)) return fail(keeperOnly(closing, "names the custodian"));
  const own = input.selfHeld === true;
  const name = own ? SELF_HELD : squeeze(input.name, NAME_MAX);
  const contact = readLines(input.contact, CONTACT_MAX);
  if (!own && name.length < 2) return fail("Enter the custodian's name.");
  if (!own && contact.length < 5) return fail("Add how to reach the custodian: the address the file ships to, and an email or phone.");
  const was = closing.custodianName?.trim() || null;
  if (was === name && (closing.custodianContact ?? "") === contact) return { ok: true, value: { changed: false } };
  const renamed = Boolean(was) && was !== name;
  // Once the collateral has left the seller, a new custodian means the file may not be where the record says, so only
  // the desk makes that change, having checked where the file went. A corrected address or phone isn't a new one.
  if (renamed && side !== "desk" && collateralShipped(closing)) return fail(SHIPPED_CHANGE);
  await prisma.closing.update({ where: { id: closing.id }, data: { custodianName: name, custodianContact: contact || null } });

  const buyer = buyerWord(closing);
  const label = custodianLabel({ custodianName: name }, buyer)!;
  const before = was ? custodianLabel({ custodianName: was }, buyer) : null;
  const reach = contact ? ` · ${oneLine(contact)}` : "";
  await audit(actor.id, was ? "CUSTODIAN_CHANGED" : "CUSTODIAN_NAMED", "closing", closing.id, renamed ? `${before} to ${label}${reach}` : `${label}${reach}`);

  const title = closing.listing.title;
  const who = actorWord(side);
  const holder = own ? `${buyer === "The buyer" ? "the buyer" : buyer}, which holds the file itself` : label;
  const shipTo = contact ? ` Ship it to: ${oneLine(contact)}.` : "";
  const letter = renamed && closing.baileeLetterAt ? ` The bailee letter of ${prettyDate(closing.baileeLetterAt)} names the old custodian, so issue a new one if the file still ships under one.` : "";
  const body = renamed
    ? `${who} changed the custodian for the collateral file on ${title} from ${before} to ${holder}.${shipTo}${letter} ${link(closing.id)}`
    : was
      ? `${who} updated how to reach ${holder}, the custodian for the collateral file on ${title}.${shipTo} ${link(closing.id)}`
      : `${who} named ${holder} as the custodian for the collateral file on ${title}: the original notes, allonges and assignments go there.${shipTo} ${link(closing.id)}`;
  const subject = `Custodian · ${title}`;
  await notify(closing.listing.seller.email, subject, body);
  if (side === "desk" && !closing.deskBidId) await tellBuyerSide(closing, subject, body);
  return { ok: true, value: { changed: true } };
}

// ---------------------------------------------------------------------------------------------------------------
// The bailee letter

export type BaileeLoan = { label: string; loanNumber: string | null };

export type BaileeLetterInput = {
  date: Date;
  custodian: string;
  contact: string;
  selfHeld: boolean;
  seller: string;
  buyer: string;
  title: string;
  closingRef: string;
  price: string;
  returnDays: number;
  loans: BaileeLoan[];
};

// Paper loans only: an eNote moves by eRegistry transfer, so it has no file to ship under a letter. Each loan reads
// as the seller's sale file names it, by its place on the listing, its city and state, and its loan number.
function letterLoans(closing: Loaded["closing"]): BaileeLoan[] {
  const notes = closing.listing.notes;
  const position = new Map(notes.map((note, index) => [note.id, index + 1]));
  return closingLoans(closing, notes)
    .filter((note) => !isENote(note))
    .map((note) => ({ label: `${notes.length > 1 ? `Loan ${position.get(note.id)} in ` : ""}${note.city}, ${note.state}`, loanNumber: note.loanNumber?.trim() || null }));
}

async function letterInput({ closing, buyerId }: Loaded, date: Date): Promise<BaileeLetterInput> {
  const [seller, names] = await Promise.all([sellerOnTitle(closing.listing.seller), namesOnTitle(closing, buyerId, closing.funders)]);
  const buyer = closing.deskBidId
    ? "UPB Capital"
    : closing.funders.length > 1
      ? `${closing.funders.map((funder) => names.funder(funder) || funder.user.name).join(" and ")}, jointly`
      : names.buyer || "the buyer";
  const own = selfHeld(closing);
  return {
    date,
    custodian: own ? buyer : closing.custodianName?.trim() ?? "",
    contact: closing.custodianContact ?? "",
    selfHeld: own,
    seller,
    buyer,
    title: closing.listing.title,
    closingRef: closing.id,
    price: money(Number(closing.salePrice), 2),
    returnDays: BAILEE_RETURN_DAYS,
    loans: letterLoans(closing),
  };
}

// The desk or the seller issues it when the collateral ships before the price is on record. Issuing again dates a
// new letter, for a changed custodian; each is audited.
export async function issueBaileeLetter(actor: Actor, input: { closingId: string }, now = new Date()): Promise<Outcome<{ at: Date }>> {
  const found = await custodyFor(actor, input.closingId);
  if (found.error !== null) return fail(found.error);
  const { closing, side } = found;
  if (side === "buyer") return fail("The seller or the desk issues the bailee letter.");
  if (!closing.custodianName?.trim()) {
    return fail(closing.deskBidId ? "Name the custodian first, so the letter is addressed to it." : "The buyer hasn't named its custodian yet, so there is no one to address the letter to.");
  }
  if (purchaseFunded(closing, closing.funders)) return fail(baileeNotNeeded(closing));
  const loans = letterLoans(closing);
  if (!loans.length) return fail("Every loan here is an eNote, which moves by eRegistry transfer rather than by courier, so there is no paper file to ship under a bailee letter.");
  await prisma.closing.update({ where: { id: closing.id }, data: { baileeLetterAt: now } });
  const label = custodianLabel(closing, buyerWord(closing))!;
  await audit(
    actor.id,
    "BAILEE_LETTER",
    "closing",
    closing.id,
    `Addressed to ${label}, ${loans.length} loan${loans.length === 1 ? "" : "s"}${closing.baileeLetterAt ? `, replacing the letter of ${prettyDate(closing.baileeLetterAt)}` : ""}`,
  );
  const subject = `Bailee letter · ${closing.listing.title}`;
  const body = `${actorWord(side)} issued a bailee letter dated ${prettyDate(now)} for the collateral file on ${closing.listing.title}, addressed to ${label}. The file ships under it: the custodian holds it in trust for the seller until the purchase price is received, and sends it back within ${BAILEE_RETURN_DAYS} business days if the sale doesn't close. Download it in the closing room: ${link(closing.id)}`;
  await tellBuyerSide(closing, subject, body);
  if (side === "desk") await notify(closing.listing.seller.email, subject, body);
  return { ok: true, value: { at: now } };
}

// The letter as issued, for the parties and the desk. The route draws it; issuing is the form above.
export async function baileeLetter(closingId: string, viewer: { id: string; role: string }): Promise<{ status: 200; pdf: Uint8Array } | { status: 403 | 404 | 409; error: string }> {
  const found = await loadCustody(closingId);
  if (!found) return { status: 404, error: "Not found." };
  if (!viewerSide(viewer, { sellerId: found.closing.listing.sellerId, buyerIds: found.buyerIds })) return { status: 403, error: "The bailee letter is for the parties and the desk." };
  const { closing } = found;
  if (!closing.baileeLetterAt) {
    return { status: 409, error: purchaseFunded(closing, closing.funders) ? baileeNotNeeded(closing) : "No bailee letter has been issued on this closing. The seller or the desk issues it from the closing page." };
  }
  return { status: 200, pdf: await buildBaileeLetterPdf(await letterInput(found, closing.baileeLetterAt)) };
}

// A short letter on one page, more for a long pool. The wording is a desk draft of a customary bailee letter, and
// the PDF says so at the top and the foot.
export async function buildBaileeLetterPdf(input: BaileeLetterInput) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const quiet = rgb(0.42, 0.42, 0.46);
  let page = pdf.addPage([612, 792]);
  let y = 744;
  const write = (text: string, options: { size?: number; face?: PDFFont; color?: typeof ink; gap?: number } = {}) => {
    const size = options.size ?? 10.5;
    const face = options.face ?? font;
    for (const paragraph of text.split("\n")) {
      for (const line of wrap(pdfSafe(paragraph, face), face, size, 516)) {
        if (y < 64) {
          page = pdf.addPage([612, 792]);
          y = 744;
        }
        page.drawText(line, { x: 48, y, size, font: face, color: options.color ?? ink });
        y -= size + 4;
      }
    }
    y -= options.gap ?? 8;
  };
  const to = input.selfHeld ? `${input.custodian}, which holds the collateral file itself` : input.custodian;
  write("DESK DRAFT. COUNSEL TO CONFIRM THE WORDING BEFORE ANYONE RELIES ON IT.", { size: 8.5, face: bold, color: quiet, gap: 14 });
  write("Bailee letter", { size: 17, face: bold, gap: 12 });
  write(`Date: ${input.date.toISOString().slice(0, 10)}`, { gap: 2 });
  write(`To: ${to}`, { gap: 2 });
  if (input.contact) write(input.contact, { gap: 2 });
  write(`From: ${input.seller}, the seller`, { gap: 2 });
  write(`Re: The collateral file for ${input.title}, sold to ${input.buyer}. UPB Capital closing ${input.closingRef}.`, { gap: 14 });
  write(`${input.seller} delivers to you the collateral file for each loan listed below: the original note with its allonge, and the assignment of the mortgage. The purchase price has not yet been received.`, { gap: 10 });
  write("1. You hold the file for the seller", { face: bold, gap: 2 });
  write(
    `You hold the collateral file as bailee, in trust for ${input.seller}, until ${input.seller} receives the purchase price of ${input.price} under its purchase and sale agreement with ${input.buyer}, as adjusted at settlement. Until then, keep it apart from other files, and don't release, pledge or deliver any part of it to anyone but the seller.`,
    { gap: 10 },
  );
  write("2. When the price is received", { face: bold, gap: 2 });
  write(`Once the seller confirms in writing that it has received the purchase price, this bailment ends and ${input.selfHeld ? "the file is the buyer's." : `you hold the file for ${input.buyer}.`}`, { gap: 10 });
  write("3. If the sale doesn't close", { face: bold, gap: 2 });
  write(`If the seller tells you in writing that the sale won't close, return the complete collateral file to the seller, at the address it gives, within ${input.returnDays} business days of its request.`, { gap: 10 });
  write("4. Your acknowledgement", { face: bold, gap: 2 });
  write("Sign below and send a copy to the seller with your receipt for the file, listing any missing or defective document you find on review.", { gap: 14 });
  write(`Loans (${input.loans.length})`, { face: bold, gap: 2 });
  input.loans.forEach((loan, index) => write(`${index + 1}. ${loan.label} · loan number ${loan.loanNumber ?? "not on the tape"}`, { gap: 0 }));
  y -= 18;
  write("Acknowledged and agreed, as bailee for the seller", { face: bold, gap: 10 });
  write("Signature: ______________________________    Name and title: ______________________________", { gap: 8 });
  write("Date: ____________________", { gap: 20 });
  write(
    "Prepared by UPB Capital from the closing record as a desk draft of a customary bailee letter, in UPB's reading. UPB Capital isn't a party to the bailment and never holds the collateral or the money. Counsel confirms the wording, and the law that governs it, before it is relied on.",
    { size: 7.5, color: quiet, gap: 0 },
  );
  return pdf.save();
}

// ---------------------------------------------------------------------------------------------------------------
// The custodian's receipt and its exceptions

// A receipt or trust receipt is filed under the collateral transfer step, so the closing-files route serves it to the
// same people as the closing's own files. Its key marks it as the custodian's, which is how the panel finds it.
export function custodyPrefix(closingId: string) {
  return `closings/${closingId}/custody/`;
}

export async function custodyFiles(closingId: string) {
  return prisma.closingFile.findMany({
    where: { storageKey: { startsWith: custodyPrefix(closingId) }, step: { is: { closingId } } },
    select: { id: true, originalName: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
}

async function storeReceipt(closing: Loaded["closing"], actorId: string, file: CustodyUpload): Promise<Outcome<string>> {
  const problem = uploadProblem(file.name, file.bytes.length, file.bytes);
  if (problem) return fail(problem);
  const ext = extensionOf(file.name);
  if (!ext) return fail("That file type is not accepted.");
  const step = closing.steps.find((row) => row.key === "COLLATERAL_TRANSFER") ?? closing.steps[0];
  if (!step) return fail("This closing has no checklist to file it under.");
  const storageKey = `${custodyPrefix(closing.id)}${crypto.randomUUID()}-${safeBasename(file.name)}`;
  const mime = mimeFor(ext, file.type || "application/octet-stream");
  await putBytes(storageKey, file.bytes, mime);
  const row = await prisma.closingFile.create({ data: { stepId: step.id, originalName: file.name.slice(0, 180), storageKey, mime, size: file.bytes.length, uploadedById: actorId } });
  return { ok: true, value: row.id };
}

// A date from the form: null when blank, undefined when it isn't a date.
function readDay(at: Date | null | undefined, blank: string): { error: string } | { error: null; day: Date } {
  if (at === undefined || (at && Number.isNaN(at.getTime()))) return { error: "Enter the date as year, month and day." };
  if (!at) return { error: blank };
  return { error: null, day: calendarDay(at) };
}

// The buyer side records when the custodian received the file, with its receipt if there is one. Recording it again
// corrects the date.
export async function recordCustodianReceipt(actor: Actor, input: { closingId: string; receivedAt: Date | null | undefined; file?: CustodyUpload | null }, now = new Date()): Promise<Outcome<{ at: Date }>> {
  const found = await custodyFor(actor, input.closingId);
  if (found.error !== null) return fail(found.error);
  const { closing, side } = found;
  if (!keeps(closing, side)) return fail(keeperOnly(closing, "records the custodian's receipt"));
  if (!closing.custodianName?.trim()) return fail("Name the custodian first.");
  const read = readDay(input.receivedAt, "Enter the date the custodian received the file.");
  if (read.error !== null) return fail(read.error);
  const day = read.day;
  if (day.getTime() > calendarDay(now).getTime()) return fail("The receipt date can't be in the future.");
  const notes = noteReceipt(closing.trailingDocs);
  if (notes.firstSentAt && day.getTime() < calendarDay(notes.firstSentAt).getTime()) {
    return fail(`The trailing list shows the original note sent ${prettyDate(notes.firstSentAt)}, so the custodian can't have received the file before then. Check the date against the list.`);
  }
  const filed = input.file && input.file.bytes.length ? await storeReceipt(closing, actor.id, input.file) : null;
  if (filed && !filed.ok) return fail(filed.error);
  await prisma.closing.update({ where: { id: closing.id }, data: { custodianReceiptAt: day } });
  const label = custodianLabel(closing, buyerWord(closing))!;
  await audit(actor.id, "CUSTODIAN_RECEIPT", "closing", closing.id, `${label} received the file ${prettyDate(day)}${closing.custodianReceiptAt ? `, was ${prettyDate(closing.custodianReceiptAt)}` : ""}${filed ? " · receipt filed" : ""}`);
  const held = closing.baileeLetterAt && !purchaseFunded(closing, closing.funders) ? ` It holds the file under the bailee letter of ${prettyDate(closing.baileeLetterAt)} until the purchase price is received.` : "";
  await notify(
    closing.listing.seller.email,
    `Collateral received · ${closing.listing.title}`,
    `${label} received the collateral file on ${closing.listing.title} on ${prettyDate(day)}, as ${actorWord(side).toLowerCase()} recorded.${held} ${link(closing.id)}`,
  );
  return { ok: true, value: { at: day } };
}

// The exceptions the custodian found on review, as the custodian's list: each missing or defective document. They
// open a notice to the seller and the desk, and keep the post-closing file open until they clear. Recording them
// again replaces the list and reopens it.
export async function recordExceptions(actor: Actor, input: { closingId: string; text: unknown }): Promise<Outcome> {
  const found = await custodyFor(actor, input.closingId);
  if (found.error !== null) return fail(found.error);
  const { closing, side } = found;
  if (!keeps(closing, side)) return fail(keeperOnly(closing, "records the custodian's exceptions"));
  if (!closing.custodianReceiptAt) return fail("Record the custodian's receipt first. Exceptions come from its review of the file.");
  const text = readLines(input.text, EXCEPTIONS_MAX);
  if (text.length < 5) return fail("List each missing or defective document, one to a line, so the seller knows what to cure.");
  const reopened = Boolean(closing.postCloseCompleteAt);
  await prisma.closing.update({ where: { id: closing.id }, data: { custodianExceptions: text, exceptionsClearedAt: null, ...(reopened ? { postCloseCompleteAt: null } : {}) } });
  await audit(actor.id, "CUSTODY_EXCEPTIONS", "closing", closing.id, oneLine(text));
  if (reopened) await audit(null, "TRAILING_REOPENED", "closing", closing.id, "Custodian exceptions: the post-closing file is open until they clear");
  const label = custodianLabel(closing, buyerWord(closing))!;
  const subject = `Custodian exceptions · ${closing.listing.title}`;
  const body = `${label} found exceptions in the collateral file on ${closing.listing.title}, as ${actorWord(side).toLowerCase()} recorded:\n${text}\n\nCure them with the custodian, then the buyer side records them cleared. Until then the post-closing file stays open: ${link(closing.id)}`;
  await notify(closing.listing.seller.email, subject, body);
  await notifyDesk(subject, body, { capability: "closings" });
  return { ok: true, value: null };
}

// When the exceptions cleared, as the custodian reported. A closed file then counts as complete if every trailing
// item is in too.
export async function clearExceptions(actor: Actor, input: { closingId: string; clearedAt: Date | null | undefined }, now = new Date()): Promise<Outcome<{ complete: boolean }>> {
  const found = await custodyFor(actor, input.closingId);
  if (found.error !== null) return fail(found.error);
  const { closing, side } = found;
  if (!keeps(closing, side)) return fail(keeperOnly(closing, "records the exceptions cleared"));
  if (!custodyExceptionOpen(closing)) return fail("No custodian exceptions are open.");
  const read = readDay(input.clearedAt, "Enter the date the exceptions cleared.");
  if (read.error !== null) return fail(read.error);
  const day = read.day;
  if (day.getTime() > calendarDay(now).getTime()) return fail("The cleared date can't be in the future.");
  if (closing.custodianReceiptAt && day.getTime() < calendarDay(closing.custodianReceiptAt).getTime()) return fail("The exceptions can't clear before the custodian received the file.");
  await prisma.closing.update({ where: { id: closing.id }, data: { exceptionsClearedAt: day } });
  await audit(actor.id, "CUSTODY_CLEARED", "closing", closing.id, `Cleared ${prettyDate(day)}: ${oneLine(closing.custodianExceptions ?? "")}`);
  const subject = `Custodian exceptions cleared · ${closing.listing.title}`;
  const body = `The custodian's exceptions on ${closing.listing.title} cleared on ${prettyDate(day)}, as ${actorWord(side).toLowerCase()} recorded. ${link(closing.id)}`;
  await notify(closing.listing.seller.email, subject, body);
  await notifyDesk(subject, body, { capability: "closings" });
  const complete = closing.status === "COMPLETE" ? await completeIfDone(closing.id, now) : false;
  return { ok: true, value: { complete } };
}

// ---------------------------------------------------------------------------------------------------------------
// The sale record

// The custody lines for a closing on the seller's and the desk's sale files: the custodian, the bailee letter's
// date, the receipt's date, and the exceptions with their clearance. None when nothing is recorded.
export function custodyRows(closing: CustodyFields, buyer: string): { at: Date | null; party: string; status: string; detail: string }[] {
  const who = custodianLabel(closing, buyer);
  const rows: { at: Date | null; party: string; status: string; detail: string }[] = [];
  if (who) rows.push({ at: null, party: who, status: "Custodian named", detail: selfHeld(closing) ? "" : oneLine(closing.custodianContact ?? "") });
  if (closing.baileeLetterAt) rows.push({ at: closing.baileeLetterAt, party: who ?? "", status: "Bailee letter issued", detail: "Held in trust for the seller until the purchase price is received" });
  if (closing.custodianReceiptAt) rows.push({ at: closing.custodianReceiptAt, party: who ?? "", status: "Custodian receipt", detail: "" });
  if (closing.custodianExceptions?.trim()) {
    const cleared = closing.exceptionsClearedAt;
    rows.push({ at: cleared ?? null, party: who ?? "", status: cleared ? "Exceptions cleared" : "Exceptions open", detail: `${oneLine(closing.custodianExceptions)}${cleared ? ` · cleared ${cleared.toISOString().slice(0, 10)}` : ""}` });
  }
  return rows;
}
