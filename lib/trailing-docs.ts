import { audit } from "@/lib/audit";
import { addDays, calendarDay, transferDate } from "@/lib/borrower-notices";
import { closingLoans } from "@/lib/closing";
import { buyerSideEmails } from "@/lib/closing-service";
import { unset } from "@/lib/db-filters";
import { DESK_DENIED, deskCan, type Staff } from "@/lib/desk-roles";
import { notify, notifyDesk } from "@/lib/email";
import { isENote, parseMersOrgId, parseTransferId, transfereeNote } from "@/lib/enotes";
import { prettyDate } from "@/lib/format";
import { eachItem, type Tally } from "@/lib/jobs";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { deskContact } from "@/lib/staff";
import { extensionOf, mimeFor, putBytes, safeBasename } from "@/lib/storage";
import { uploadProblem } from "@/lib/uploads";

// Trailing documents: what still arrives after a note sale closes. The recorded assignment comes back from the
// county, the original note and allonge go by courier, a title endorsement follows, the borrower gets the goodbye
// and hello letters, and the buyer's servicer boards the loan. An eNote moves instead by an eRegistry transfer of
// control and location. Each item has an owner and a due date; the owner records how it went, the other side
// confirms receipt, and the desk can waive one. The kinds and statuses are the schema's, and the sellers' track
// record reads them for days to collateral delivered, so they stay as they are.

export const TRAILING_KINDS = [
  "ORIGINAL_NOTE",
  "ALLONGE",
  "ENOTE_CONTROL",
  "ENOTE_LOCATION",
  "RECORDED_ASSIGNMENT",
  "TITLE_ENDORSEMENT",
  "GOODBYE_LETTER",
  "HELLO_LETTER",
  "SERVICER_BOARDED",
] as const;
export type TrailingKind = (typeof TRAILING_KINDS)[number];
export type TrailingOwner = "SELLER" | "BUYER" | "DESK" | "SERVICER";
export type TrailingStatus = "DUE" | "SENT" | "RECEIVED" | "WAIVED";

export const KIND_LABELS: Record<TrailingKind, string> = {
  ORIGINAL_NOTE: "Original note",
  ALLONGE: "Allonge",
  ENOTE_CONTROL: "eRegistry transfer of control",
  ENOTE_LOCATION: "eRegistry transfer of location",
  RECORDED_ASSIGNMENT: "Recorded assignment",
  TITLE_ENDORSEMENT: "Title endorsement",
  GOODBYE_LETTER: "Goodbye letter",
  HELLO_LETTER: "Hello letter",
  SERVICER_BOARDED: "Servicer boarding",
};

export const KIND_HINTS: Record<TrailingKind, string> = {
  ORIGINAL_NOTE: "The original note, by courier to the buyer or its custodian.",
  ALLONGE: "The allonge endorsing the note to the buyer. It travels fixed to the note.",
  ENOTE_CONTROL: "The eRegistry names the buyer, or its custodian, as the eNote's controller.",
  ENOTE_LOCATION: "The eRegistry names the eVault that holds the authoritative copy.",
  RECORDED_ASSIGNMENT: "The assignment of the mortgage, back from the county with its recording.",
  TITLE_ENDORSEMENT: "The title company's endorsement of the lender's policy to the buyer.",
  GOODBYE_LETTER: "The old servicer's notice to the borrower that servicing moves (12 CFR 1024.33).",
  HELLO_LETTER: "The new owner's notice of sale to the borrower (12 CFR 1026.39). Recording the sale notice receives it.",
  SERVICER_BOARDED: "The buyer's servicer has the loan on its system. A boarding date on file receives it.",
};

export function kindLabel(kind: string) {
  return (KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

export const STATUS_LABELS: Record<TrailingStatus, string> = { DUE: "Due", SENT: "Sent", RECEIVED: "Received", WAIVED: "Waived" };

export function trailingStatusLabel(status: string) {
  return (STATUS_LABELS as Record<string, string>)[status] ?? status;
}

// Days after closing each is due. The recorded assignment waits on the county, so the desk can set its own.
export const NOTE_DAYS = 10;
export const ENOTE_BUSINESS_DAYS = 2;
export const DEFAULT_ASSIGNMENT_DAYS = 90;
export const TITLE_DAYS = 30;
export const GOODBYE_DAYS = 15;
export const HELLO_DAYS = 30;
export const BOARDING_DAYS = 30;
export const REMIND_BEFORE_DAYS = 3;
export const ESCALATE_DAYS = 14;
// A closing from before this list existed gets one, from closings this recent, with a week before anything is due.
export const BACKFILL_DAYS = 365;
export const BACKFILL_GRACE_DAYS = 7;

const DAY = 24 * 60 * 60 * 1000;

export function assignmentDays(setting: number | null | undefined) {
  return setting != null && setting >= 10 && setting <= 365 ? Math.round(setting) : DEFAULT_ASSIGNMENT_DAYS;
}

// Weekdays after a date, in UTC like every date on the desk. Holidays aren't counted out.
export function addBusinessDays(date: Date, days: number) {
  let day = calendarDay(date);
  for (let left = days; left > 0; ) {
    day = new Date(day.getTime() + DAY);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) left -= 1;
  }
  return day;
}

// ---------------------------------------------------------------------------------------------------------------
// The schedule

export type PlannedDoc = { kind: TrailingKind; owner: TrailingOwner; noteId: string | null; dueAt: Date };

type PlanLoan = { id: string; eNote?: boolean | null; servicerName?: string | null };

// What a closing owes after it closes. Each paper loan: the note and allonge by courier, the recorded assignment,
// and a title endorsement when a title policy is in its collateral file. An eNote swaps the note and allonge for
// the two eRegistry transfers. The closing: the borrower's goodbye and hello letters and the servicer boarding.
export function planTrailingDocs(input: { closedAt: Date; transferAt?: Date | null; loans: PlanLoan[]; titlePolicies: Set<string>; assignmentDays: number }): PlannedDoc[] {
  const closed = calendarDay(input.closedAt);
  const docs: PlannedDoc[] = [];
  for (const loan of input.loans) {
    if (isENote(loan)) {
      const due = addBusinessDays(closed, ENOTE_BUSINESS_DAYS);
      docs.push({ kind: "ENOTE_CONTROL", owner: "SELLER", noteId: loan.id, dueAt: due }, { kind: "ENOTE_LOCATION", owner: "SELLER", noteId: loan.id, dueAt: due });
    } else {
      const due = addDays(closed, NOTE_DAYS);
      docs.push({ kind: "ORIGINAL_NOTE", owner: "SELLER", noteId: loan.id, dueAt: due }, { kind: "ALLONGE", owner: "SELLER", noteId: loan.id, dueAt: due });
    }
    docs.push({ kind: "RECORDED_ASSIGNMENT", owner: "SELLER", noteId: loan.id, dueAt: addDays(closed, input.assignmentDays) });
    if (input.titlePolicies.has(loan.id)) docs.push({ kind: "TITLE_ENDORSEMENT", owner: "SELLER", noteId: loan.id, dueAt: addDays(closed, TITLE_DAYS) });
  }
  // A loan the seller has a servicer for gets its goodbye letter from that servicer, on the seller's side.
  const serviced = input.loans.some((loan) => Boolean(loan.servicerName?.trim()));
  docs.push(
    { kind: "GOODBYE_LETTER", owner: serviced ? "SERVICER" : "SELLER", noteId: null, dueAt: addDays(closed, GOODBYE_DAYS) },
    { kind: "HELLO_LETTER", owner: "BUYER", noteId: null, dueAt: addDays(input.transferAt ? calendarDay(input.transferAt) : closed, HELLO_DAYS) },
    { kind: "SERVICER_BOARDED", owner: "SERVICER", noteId: null, dueAt: addDays(closed, BOARDING_DAYS) },
  );
  return docs;
}

const slot = (doc: { kind: string; noteId: string | null }) => `${doc.kind}:${doc.noteId ?? ""}`;

// Builds the list for a closed closing. A second call adds only what is missing, so the close, the backfill and a
// retry can all call it. `notBefore` holds every due date to that day or later.
export async function scheduleTrailingDocs(closingId: string, options: { notBefore?: Date; now?: Date } = {}) {
  const now = options.now ?? new Date();
  const closing = await prisma.closing.findUnique({
    where: { id: closingId },
    include: { listing: { include: { notes: true } }, trailingDocs: { select: { kind: true, noteId: true } } },
  });
  if (!closing || closing.status !== "COMPLETE") return { created: 0 };
  const loans = closingLoans(closing, closing.listing.notes);
  const [policies, settings] = await Promise.all([
    prisma.collateralItem.findMany({ where: { noteId: { in: loans.map((loan) => loan.id) }, kind: "TITLE_POLICY", status: "PRESENT" }, select: { noteId: true } }),
    getSettings(),
  ]);
  const planned = planTrailingDocs({
    closedAt: closing.closedAt ?? now,
    transferAt: transferDate(closing),
    loans,
    titlePolicies: new Set(policies.map((row) => row.noteId)),
    assignmentDays: assignmentDays(settings.trailingDocDays),
  });
  const have = new Set(closing.trailingDocs.map(slot));
  const floor = options.notBefore ? calendarDay(options.notBefore) : null;
  const fresh = planned.filter((doc) => !have.has(slot(doc))).map((doc) => ({ ...doc, closingId, dueAt: floor && doc.dueAt < floor ? floor : doc.dueAt }));
  if (fresh.length) await prisma.trailingDoc.createMany({ data: fresh });
  if (fresh.length) await dropDuplicates(closingId);
  await syncTrailingDocs(closingId, now);
  return { created: fresh.length };
}

// Two calls at once can both find an item missing. The first row of each kind and loan stands; a twin nobody has
// touched goes.
async function dropDuplicates(closingId: string) {
  const rows = await prisma.trailingDoc.findMany({ where: { closingId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, kind: true, noteId: true, status: true } });
  const seen = new Set<string>();
  const twins: string[] = [];
  for (const row of rows) {
    if (!seen.has(slot(row))) seen.add(slot(row));
    else if (row.status === "DUE") twins.push(row.id);
  }
  if (twins.length) await prisma.trailingDoc.deleteMany({ where: { id: { in: twins }, status: "DUE" } });
}

// The close calls this. A failure leaves the close standing; the job's backfill builds the list on its next run.
export async function scheduleTrailingDocsSafely(closingId: string) {
  try {
    await scheduleTrailingDocs(closingId);
  } catch (error) {
    console.error(`[upb-trailing] the list for closing ${closingId} wasn't built:`, error instanceof Error ? error.message : error);
  }
}

// Closings that closed before the list existed, newest first, a batch per run. `closingIds` narrows it for tests.
export async function backfillTrailingDocs(now = new Date(), options: { closingIds?: string[]; take?: number } = {}) {
  const closings = await prisma.closing.findMany({
    where: {
      status: "COMPLETE",
      closedAt: { gte: new Date(now.getTime() - BACKFILL_DAYS * DAY) },
      trailingDocs: { none: {} },
      AND: [unset("postCloseCompleteAt")],
      ...(options.closingIds ? { id: { in: options.closingIds } } : {}),
    },
    select: { id: true },
    orderBy: { closedAt: "desc" },
    take: options.take ?? 50,
  });
  let built = 0;
  for (const closing of closings) {
    const { created } = await scheduleTrailingDocs(closing.id, { now, notBefore: addDays(now, BACKFILL_GRACE_DAYS) });
    if (created) built += 1;
  }
  return built;
}

// ---------------------------------------------------------------------------------------------------------------
// Who does what

export type Side = "seller" | "buyer" | "desk";

// Who delivers it. A servicer isn't on the desk: the seller's old servicer writes the goodbye, and the buyer's new one
// boards the loan.
export function deliveringSide(doc: { kind: string; owner: string }): Side {
  if (doc.owner === "SELLER") return "seller";
  if (doc.owner === "BUYER") return "buyer";
  if (doc.owner === "DESK") return "desk";
  return doc.kind === "SERVICER_BOARDED" ? "buyer" : "seller";
}

// Who confirms it arrived. What the seller side sends, the buyer receives. What the buyer side does goes to the
// borrower or its own servicer, so the desk confirms it.
export function receivingSide(doc: { kind: string; owner: string }): Side {
  return deliveringSide(doc) === "seller" ? "buyer" : deliveringSide(doc) === "buyer" ? "desk" : "buyer";
}

export function sideWord(side: Side) {
  return side === "seller" ? "seller" : side === "buyer" ? "buyer" : "desk";
}

type Parties = { sellerId: string; buyerIds: string[] };

export function viewerSide(viewer: { id: string; role: string }, parties: Parties): Side | null {
  if (viewer.role === "ADMIN") return "desk";
  if (viewer.id === parties.sellerId) return "seller";
  if (parties.buyerIds.includes(viewer.id)) return "buyer";
  return null;
}

type DocState = { kind: string; owner: string; status: string };

// The actions this side may take on an item. `runs` is a desk member whose role covers closings; any other desk
// role reads the list.
export function trailingActions(doc: DocState, side: Side | null, runs: boolean) {
  const open = doc.status === "DUE" || doc.status === "SENT";
  const desk = side === "desk" && runs;
  return {
    send: open && (desk || side === deliveringSide(doc)),
    confirm: open && (desk || side === receivingSide(doc)),
    waive: desk && doc.status !== "WAIVED",
    // The buyer names the MERS Org ID an eNote moves to.
    transferee: doc.status === "DUE" && (doc.kind === "ENOTE_CONTROL" || doc.kind === "ENOTE_LOCATION") && (desk || side === "buyer"),
  };
}

// Overdue is read from the due date: an item still due once its day has passed.
export function daysLate(dueAt: Date, now = new Date()) {
  return Math.round((calendarDay(now).getTime() - calendarDay(dueAt).getTime()) / DAY);
}

export function isOverdue(doc: { status: string; dueAt: Date }, now = new Date()) {
  return doc.status === "DUE" && daysLate(doc.dueAt, now) > 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Carriers. A tracking link is built from the number; UPB calls no carrier.

export const CARRIERS = [
  { value: "FEDEX", label: "FedEx" },
  { value: "UPS", label: "UPS" },
  { value: "USPS", label: "USPS" },
  { value: "DHL", label: "DHL" },
  { value: "OTHER", label: "Other" },
] as const;

export function carrierLabel(carrier: string | null | undefined) {
  return CARRIERS.find((row) => row.value === carrier)?.label ?? carrier ?? "";
}

export function parseTracking(raw: string | null | undefined) {
  const text = String(raw ?? "").replace(/[\s-]/g, "").toUpperCase();
  return /^[A-Z0-9]{6,40}$/.test(text) ? text : null;
}

export function trackingUrl(carrier: string | null | undefined, number: string | null | undefined) {
  const tracking = parseTracking(number);
  if (!tracking) return null;
  const code = encodeURIComponent(tracking);
  if (carrier === "FEDEX") return `https://www.fedex.com/fedextrack/?trknbr=${code}`;
  if (carrier === "UPS") return `https://www.ups.com/track?tracknum=${code}`;
  if (carrier === "USPS") return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${code}`;
  if (carrier === "DHL") return `https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id=${code}`;
  return null;
}

const COURIER = new Set(["ORIGINAL_NOTE", "ALLONGE"]);
const ENOTE = new Set(["ENOTE_CONTROL", "ENOTE_LOCATION"]);

export type SentInput = {
  docId: string;
  carrier?: string;
  trackingNumber?: string;
  instrument?: string;
  book?: string;
  page?: string;
  transferId?: string;
  reference?: string;
  // An original note sent with its allonge records the allonge as sent with it.
  withAllonge?: boolean;
  file?: { name: string; type: string; bytes: Buffer } | null;
};

const squeeze = (value: unknown, max: number) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// What the owner records, by kind: a courier's tracking for paper, the recording for an assignment, the transfer
// ID for an eNote, and for the rest any of tracking, a reference or a file.
export function readProof(kind: string, input: Omit<SentInput, "docId">, hasFile = false): { error: string } | { error: null; carrier: string | null; trackingNumber: string | null; reference: string } {
  const carrier = squeeze(input.carrier, 10).toUpperCase();
  const rawTracking = squeeze(input.trackingNumber, 60);
  if (carrier && !CARRIERS.some((row) => row.value === carrier)) return { error: "Choose the carrier." };
  const tracking = rawTracking ? parseTracking(rawTracking) : null;
  if (rawTracking && !tracking) return { error: "Enter the tracking number as the carrier gives it, in letters and digits." };
  if (tracking && !carrier) return { error: "Choose the carrier for that tracking number." };
  const shipped = { carrier: tracking ? carrier : null, trackingNumber: tracking };
  if (COURIER.has(kind)) {
    if (!tracking) return { error: "Choose the carrier and enter the tracking number." };
    return { error: null, ...shipped, reference: squeeze(input.reference, 200) };
  }
  if (kind === "RECORDED_ASSIGNMENT") {
    const instrument = squeeze(input.instrument, 40);
    const book = squeeze(input.book, 20);
    const page = squeeze(input.page, 20);
    if (instrument) return { error: null, ...shipped, reference: `Instrument ${instrument}` };
    if (book && page) return { error: null, ...shipped, reference: `Book ${book}, page ${page}` };
    return { error: "Enter the recording's instrument number, or its book and page." };
  }
  if (ENOTE.has(kind)) {
    const id = parseTransferId(input.transferId);
    if (!id) return { error: "Enter the eRegistry transfer ID the eVault gave you." };
    return { error: null, ...shipped, reference: `eRegistry transfer ${id}` };
  }
  const reference = squeeze(input.reference, 200);
  if (!tracking && reference.length < 3 && !hasFile) return { error: "Add a tracking number, a reference or a file, so the other side can find it." };
  return { error: null, ...shipped, reference };
}

// One line on what went out, for the list and the notices.
export function proofLine(doc: { carrier: string | null; trackingNumber: string | null; reference: string }) {
  const parts = [doc.trackingNumber ? `${carrierLabel(doc.carrier)} tracking ${doc.trackingNumber}` : "", doc.reference].filter(Boolean);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------------------------------------------
// Moving an item

type Actor = Staff & { id: string };
type Outcome<T = null> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string) => ({ ok: false as const, error });

async function loadItem(docId: string) {
  const doc = docId
    ? await prisma.trailingDoc.findUnique({
        where: { id: docId },
        include: {
          closing: {
            include: {
              listing: { select: { id: true, title: true, sellerId: true, seller: { select: { email: true } }, notes: { select: { id: true, streetAddress: true, city: true, state: true } } } },
              funders: { select: { userId: true } },
              steps: { select: { id: true, key: true } },
            },
          },
        },
      })
    : null;
  if (!doc) return null;
  const inquiry = doc.closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: doc.closing.inquiryId }, select: { buyerId: true } }) : null;
  const buyerIds = [inquiry?.buyerId, ...doc.closing.funders.map((funder) => funder.userId)].filter((id): id is string => Boolean(id));
  return { doc, closing: doc.closing, buyerIds };
}

type Item = NonNullable<Awaited<ReturnType<typeof loadItem>>>;

// The item as the actor may touch it, or why not.
async function itemFor(actor: Actor, docId: string): Promise<{ error: string } | { error: null; item: Item; side: Side; runs: boolean }> {
  const item = await loadItem(docId);
  if (!item) return { error: "That item isn't on this closing." };
  const side = viewerSide(actor, { sellerId: item.closing.listing.sellerId, buyerIds: item.buyerIds });
  if (!side) return { error: "Only the parties and the desk keep this list." };
  const runs = side === "desk" && deskCan(actor, "closings");
  if (side === "desk" && !runs) return { error: DESK_DENIED };
  if (item.closing.status !== "COMPLETE") return { error: "Trailing documents start once the file is closed." };
  return { error: null, item, side, runs };
}

export function loanName(notes: { id: string; streetAddress: string; city: string; state: string }[], noteId: string | null) {
  if (!noteId) return null;
  const note = notes.find((row) => row.id === noteId);
  return note ? `${note.streetAddress ? `${note.streetAddress}, ` : ""}${note.city}, ${note.state}` : "A loan";
}

const link = (closingId: string) => `${process.env.NEXT_PUBLIC_APP_URL || ""}/closings/${closingId}#trailing`;

function itemName(item: Item, kind = item.doc.kind) {
  const loan = loanName(item.closing.listing.notes, item.doc.noteId);
  return `${kindLabel(kind).toLowerCase()}${loan ? ` for ${loan}` : ""}`;
}

// The other side hears. On a desk purchase the desk is the buyer.
async function tellSide(closing: Item["closing"], side: Side, subject: string, body: string) {
  if (side === "seller") return notify(closing.listing.seller.email, subject, body);
  if (side === "desk" || closing.deskBidId) return notifyDesk(subject, body, { capability: "closings" });
  for (const email of await buyerSideEmails(closing.id)) await notify(email, subject, body);
}

// A step on the closed file holds the upload, so the closing-files route serves it to the same people as the
// closing's own files.
const FILE_STEP: Record<string, string> = { RECORDED_ASSIGNMENT: "ASSIGNMENT", ALLONGE: "ASSIGNMENT", GOODBYE_LETTER: "CLOSED", HELLO_LETTER: "CLOSED", SERVICER_BOARDED: "CLOSED" };

async function storeFile(item: Item, actorId: string, file: NonNullable<SentInput["file"]>): Promise<Outcome<string>> {
  const problem = uploadProblem(file.name, file.bytes.length, file.bytes);
  if (problem) return fail(problem);
  const ext = extensionOf(file.name);
  if (!ext) return fail("That file type is not accepted.");
  const key = FILE_STEP[item.doc.kind] ?? "COLLATERAL_TRANSFER";
  const step = item.closing.steps.find((row) => row.key === key) ?? item.closing.steps[0];
  if (!step) return fail("This closing has no checklist to file it under.");
  const storageKey = `closings/${item.closing.id}/trailing/${crypto.randomUUID()}-${safeBasename(file.name)}`;
  const mime = mimeFor(ext, file.type || "application/octet-stream");
  await putBytes(storageKey, file.bytes, mime);
  const row = await prisma.closingFile.create({ data: { stepId: step.id, originalName: file.name.slice(0, 180), storageKey, mime, size: file.bytes.length, uploadedById: actorId } });
  return { ok: true, value: row.id };
}

// DUE → SENT, by the side that owes it or the desk. Sending again corrects what was recorded.
export async function recordSent(actor: Actor, input: SentInput, now = new Date()): Promise<Outcome<{ id: string }>> {
  const found = await itemFor(actor, input.docId);
  if (found.error !== null) return fail(found.error);
  const { item, side, runs } = found;
  const { doc } = item;
  if (!trailingActions(doc, side, runs).send) {
    return fail(doc.status === "RECEIVED" || doc.status === "WAIVED" ? "That item is already received or waived." : `The ${sideWord(deliveringSide(doc))} records this one.`);
  }
  const hasFile = Boolean(input.file && input.file.bytes.length);
  const proof = readProof(doc.kind, input, hasFile);
  if (proof.error !== null) return fail(proof.error);
  let documentId = doc.documentId;
  if (hasFile) {
    const stored = await storeFile(item, actor.id, input.file!);
    if (!stored.ok) return fail(stored.error);
    documentId = stored.value;
  }
  const data = { status: "SENT", sentAt: doc.sentAt ?? now, carrier: proof.carrier, trackingNumber: proof.trackingNumber, reference: proof.reference, documentId };
  const claim = await prisma.trailingDoc.updateMany({ where: { id: doc.id, status: { in: ["DUE", "SENT"] } }, data });
  if (claim.count !== 1) return fail("That item was received or waived a moment ago.");
  const names = [itemName(item)];
  // The allonge travels fixed to the note, so it goes under the same tracking.
  if (doc.kind === "ORIGINAL_NOTE" && input.withAllonge) {
    const allonge = await prisma.trailingDoc.updateMany({
      where: { closingId: item.closing.id, kind: "ALLONGE", status: "DUE", ...(doc.noteId ? { noteId: doc.noteId } : unset("noteId")) },
      data: { ...data, sentAt: now, documentId: null },
    });
    if (allonge.count) names.push(itemName(item, "ALLONGE"));
  }
  await audit(actor.id, "TRAILING_SENT", "closing", item.closing.id, `${names.join(" and ")}: ${proofLine(proof) || "file attached"}`);
  const from = side === "desk" ? "The desk" : `The ${sideWord(side)}`;
  const tracked = trackingUrl(proof.carrier, proof.trackingNumber);
  await tellSide(
    item.closing,
    receivingSide(doc),
    `Sent · ${item.closing.listing.title}`,
    `${from} recorded the ${names.join(" and the ")} as sent${proofLine(proof) ? `: ${proofLine(proof)}` : ""}.${tracked ? ` Track it: ${tracked}` : ""} Confirm receipt in the closing room when it arrives: ${link(item.closing.id)}`,
  );
  return { ok: true, value: { id: doc.id } };
}

// SENT → RECEIVED, by the receiving side or the desk. Receipt counts whether or not the sender recorded it.
export async function confirmReceived(actor: Actor, input: { docId: string }, now = new Date()): Promise<Outcome<{ id: string; complete: boolean }>> {
  const found = await itemFor(actor, input.docId);
  if (found.error !== null) return fail(found.error);
  const { item, side, runs } = found;
  const { doc } = item;
  if (!trailingActions(doc, side, runs).confirm) {
    return fail(doc.status === "RECEIVED" || doc.status === "WAIVED" ? "That item is already received or waived." : `The ${sideWord(receivingSide(doc))} confirms this one.`);
  }
  const claim = await prisma.trailingDoc.updateMany({ where: { id: doc.id, status: { in: ["DUE", "SENT"] } }, data: { status: "RECEIVED", receivedAt: now, confirmedById: actor.id } });
  if (claim.count !== 1) return fail("That item was received or waived a moment ago.");
  await audit(actor.id, "TRAILING_RECEIVED", "closing", item.closing.id, itemName(item));
  return { ok: true, value: { id: doc.id, complete: await completeIfDone(item.closing.id, now) } };
}

// Any → WAIVED, by the closings side of the desk, with the reason both sides read.
export async function waiveTrailingDoc(actor: Actor, input: { docId: string; reason: string }, now = new Date()): Promise<Outcome<{ id: string; complete: boolean }>> {
  if (actor.role !== "ADMIN") return fail("Only the desk waives an item.");
  const found = await itemFor(actor, input.docId);
  if (found.error !== null) return fail(found.error);
  const { item, side, runs } = found;
  if (!trailingActions(item.doc, side, runs).waive) return fail("That item is already waived.");
  const reason = squeeze(input.reason, 300);
  if (reason.length < 5) return fail("Say why it isn't needed, in a sentence. Both sides read it.");
  const claim = await prisma.trailingDoc.updateMany({ where: { id: item.doc.id, status: { not: "WAIVED" } }, data: { status: "WAIVED", waivedById: actor.id, waivedReason: reason } });
  if (claim.count !== 1) return fail("That item is already waived.");
  await audit(actor.id, "TRAILING_WAIVED", "closing", item.closing.id, `${itemName(item)}: ${reason}`);
  return { ok: true, value: { id: item.doc.id, complete: await completeIfDone(item.closing.id, now) } };
}

// The buyer names the MERS Org ID an eNote moves to, its own or its custodian's. The seller hears.
export async function recordTransferee(actor: Actor, input: { docId: string; orgId: string }): Promise<Outcome<{ orgId: string }>> {
  const found = await itemFor(actor, input.docId);
  if (found.error !== null) return fail(found.error);
  const { item, side, runs } = found;
  if (!trailingActions(item.doc, side, runs).transferee) return fail("The buyer names the Org ID before the transfer is made.");
  const orgId = parseMersOrgId(input.orgId);
  if (!orgId) return fail("A MERS Org ID is 7 digits.");
  await prisma.trailingDoc.update({ where: { id: item.doc.id }, data: { note: transfereeNote(orgId) } });
  await audit(actor.id, "TRAILING_ORG_ID", "closing", item.closing.id, `${itemName(item)}: MERS Org ID ${orgId}`);
  await notify(
    item.closing.listing.seller.email,
    `MERS Org ID · ${item.closing.listing.title}`,
    `The buyer named MERS Org ID ${orgId} for the ${itemName(item)}. Make the transfer on the eRegistry, then record its transfer ID in the closing room: ${link(item.closing.id)}`,
  );
  return { ok: true, value: { orgId } };
}

// ---------------------------------------------------------------------------------------------------------------
// Records kept elsewhere receive their items: the sale notice the buyer recorded is the hello letter, the boarding
// date is the servicer boarding, and the old servicer's letter date is the goodbye.

export async function syncTrailingDocs(closingId: string, now = new Date()) {
  const closing = await prisma.closing.findUnique({ where: { id: closingId }, select: { id: true, status: true, ownerNoticeSentAt: true, boarding: { select: { boardedAt: true, goodbyeSentAt: true } } } });
  if (!closing || closing.status !== "COMPLETE") return 0;
  const boardedAt = closing.boarding?.boardedAt && closing.boarding.boardedAt.getTime() <= now.getTime() ? closing.boarding.boardedAt : null;
  const records: [TrailingKind, Date | null | undefined, string][] = [
    ["HELLO_LETTER", closing.ownerNoticeSentAt, "the sale notice recorded"],
    ["SERVICER_BOARDED", boardedAt, "the boarding date on file"],
    ["GOODBYE_LETTER", closing.boarding?.goodbyeSentAt, "the old servicer's letter date on file"],
  ];
  let received = 0;
  for (const [kind, at, source] of records) {
    if (!at) continue;
    const moved = await prisma.trailingDoc.updateMany({ where: { closingId, kind, status: { in: ["DUE", "SENT"] } }, data: { status: "RECEIVED", receivedAt: at } });
    if (moved.count) {
      received += moved.count;
      await audit(null, "TRAILING_RECEIVED", "closing", closingId, `${kindLabel(kind)}: from ${source}, ${prettyDate(at)}`);
    }
  }
  if (received) await completeIfDone(closingId, now);
  return received;
}

// Once every item is received or waived, the file is complete. Claimed once, so both sides hear once.
export async function completeIfDone(closingId: string, now = new Date()) {
  const docs = await prisma.trailingDoc.findMany({ where: { closingId }, select: { status: true } });
  if (!docs.length || docs.some((doc) => doc.status !== "RECEIVED" && doc.status !== "WAIVED")) return false;
  const claim = await prisma.closing.updateMany({ where: { id: closingId, status: "COMPLETE", ...unset("postCloseCompleteAt") }, data: { postCloseCompleteAt: now } });
  if (claim.count !== 1) return false;
  const closing = await prisma.closing.findUnique({ where: { id: closingId }, select: { id: true, deskBidId: true, listing: { select: { title: true, seller: { select: { email: true } } } } } });
  if (!closing) return true;
  await audit(null, "TRAILING_COMPLETE", "closing", closingId, `${docs.length} items received or waived`);
  const subject = `File complete · ${closing.listing.title}`;
  const body = `Every trailing document on ${closing.listing.title} is received or waived, so the post-closing file is complete. The list stays in the closing room: ${link(closingId)}`;
  await notify(closing.listing.seller.email, subject, body);
  if (closing.deskBidId) await notifyDesk(subject, body, { capability: "closings" });
  else for (const email of await buyerSideEmails(closingId)) await notify(email, subject, body);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Reminders and escalation

// The reminder this run owes: three days out, on the day, then once a week while it's late. Each is a point in time,
// and an item reminded at or after the latest one has had it.
export function reminderSlot(dueAt: Date, now = new Date()) {
  const due = calendarDay(dueAt).getTime();
  const today = calendarDay(now).getTime();
  if (today < due - REMIND_BEFORE_DAYS * DAY) return null;
  if (today < due) return new Date(due - REMIND_BEFORE_DAYS * DAY);
  return new Date(due + Math.floor((today - due) / (7 * DAY)) * 7 * DAY);
}

export function needsReminder(doc: { status: string; dueAt: Date; remindedAt: Date | null }, now = new Date()) {
  if (doc.status !== "DUE") return false;
  const slotAt = reminderSlot(doc.dueAt, now);
  return Boolean(slotAt && (!doc.remindedAt || calendarDay(doc.remindedAt).getTime() < slotAt.getTime()));
}

export function needsEscalation(doc: { status: string; dueAt: Date; escalatedAt: Date | null }, now = new Date()) {
  return doc.status === "DUE" && !doc.escalatedAt && daysLate(doc.dueAt, now) >= ESCALATE_DAYS;
}

// A marker still at the value this run read, as in lib/jobs.ts, so an overlapping run sends nothing twice.
function still<K extends string>(field: K, seen: Date | null) {
  return seen ? ({ [field]: seen } as Record<K, Date>) : unset(field);
}

async function dueForNotice(now: Date, closingIds?: string[]) {
  return prisma.trailingDoc.findMany({
    where: {
      status: "DUE",
      dueAt: { lte: new Date(calendarDay(now).getTime() + REMIND_BEFORE_DAYS * DAY) },
      closing: { is: { status: "COMPLETE" } },
      ...(closingIds ? { closingId: { in: closingIds } } : {}),
    },
    orderBy: { dueAt: "asc" },
  });
}

// One message per closing and side: every item this run claimed, the late ones said so. Items 14 days late go to
// the closing's desk owner, or the closings desk when it has none, once each. `closingIds` narrows it for tests.
export async function remindTrailingDocs(now = new Date(), options: { closingIds?: string[] } = {}): Promise<Tally> {
  const docs = await dueForNotice(now, options.closingIds);
  const byClosing = new Map<string, typeof docs>();
  for (const doc of docs) byClosing.set(doc.closingId, [...(byClosing.get(doc.closingId) ?? []), doc]);
  return eachItem("trailing reminder", [...byClosing.entries()], ([closingId]) => `closing ${closingId}`, async ([closingId, items]) => {
    const reminded: typeof items = [];
    const escalated: typeof items = [];
    for (const doc of items) {
      if (needsReminder(doc, now)) {
        const claim = await prisma.trailingDoc.updateMany({ where: { id: doc.id, status: "DUE", ...still("remindedAt", doc.remindedAt) }, data: { remindedAt: now } });
        if (claim.count === 1) reminded.push(doc);
      }
      if (needsEscalation(doc, now)) {
        const claim = await prisma.trailingDoc.updateMany({ where: { id: doc.id, status: "DUE", ...unset("escalatedAt") }, data: { escalatedAt: now } });
        if (claim.count === 1) escalated.push(doc);
      }
    }
    if (!reminded.length && !escalated.length) return false;
    const closing = await prisma.closing.findUnique({
      where: { id: closingId },
      select: { id: true, deskBidId: true, deskOwnerId: true, listing: { select: { title: true, seller: { select: { email: true } }, notes: { select: { id: true, streetAddress: true, city: true, state: true } } } } },
    });
    if (!closing) return false;
    const line = (doc: (typeof items)[number]) => {
      const loan = loanName(closing.listing.notes, doc.noteId);
      const late = daysLate(doc.dueAt, now);
      return `${kindLabel(doc.kind)}${loan ? ` · ${loan}` : ""}: ${late > 0 ? `late, was due ${prettyDate(doc.dueAt)}` : `due ${prettyDate(doc.dueAt)}`}`;
    };
    const subject = `Trailing documents · ${closing.listing.title}`;
    for (const side of ["seller", "buyer", "desk"] as const) {
      const mine = reminded.filter((doc) => deliveringSide(doc) === side);
      if (!mine.length) continue;
      const body = `${mine.map(line).join("\n")}\n\nRecord each in the closing room once it's on its way, with the tracking number, the recording or the eRegistry transfer ID: ${link(closing.id)}`;
      if (side === "seller") await notify(closing.listing.seller.email, subject, body);
      else if (side === "desk" || closing.deskBidId) await notifyDesk(subject, body, { capability: "closings" });
      else for (const email of await buyerSideEmails(closing.id)) await notify(email, subject, body);
    }
    if (escalated.length) {
      const owed = [...new Set(escalated.map((doc) => sideWord(deliveringSide(doc))))].join(" and the ");
      const body = `These are ${ESCALATE_DAYS} days or more late, from the ${owed}:\n${escalated.map(line).join("\n")}\n\nChase them, or waive any that won't come, with a reason: ${link(closing.id)}`;
      const owner = await deskContact(closing.deskOwnerId);
      if (owner) await notify(owner.email, `Trailing documents late · ${closing.listing.title}`, body);
      else await notifyDesk(`Trailing documents late · ${closing.listing.title}`, body, { capability: "closings" });
      await audit(null, "TRAILING_ESCALATED", "closing", closing.id, escalated.map(line).join("; "));
    }
    return true;
  });
}

// The job's line: build lists the close missed, receive what other records show, then remind and escalate.
export async function runTrailingDocs(now = new Date(), options: { closingIds?: string[] } = {}) {
  await backfillTrailingDocs(now, options);
  const open = await prisma.closing.findMany({
    where: {
      status: "COMPLETE",
      AND: [unset("postCloseCompleteAt")],
      trailingDocs: { some: { status: { in: ["DUE", "SENT"] } } },
      ...(options.closingIds ? { id: { in: options.closingIds } } : {}),
    },
    select: { id: true },
    take: 500,
  });
  for (const closing of open) await syncTrailingDocs(closing.id, now);
  return remindTrailingDocs(now, options);
}

// ---------------------------------------------------------------------------------------------------------------
// The desk's view across closings

export async function overdueTrailingDocs(now = new Date()) {
  const [late, waiting] = await Promise.all([
    prisma.trailingDoc.findMany({
      where: { status: "DUE", dueAt: { lt: calendarDay(now) }, closing: { is: { status: "COMPLETE" } } },
      orderBy: { dueAt: "asc" },
      take: 500,
    }),
    // Sent a fortnight ago and still not confirmed: worth a call to the receiving side.
    prisma.trailingDoc.findMany({
      where: { status: "SENT", sentAt: { lt: new Date(now.getTime() - ESCALATE_DAYS * DAY) }, closing: { is: { status: "COMPLETE" } } },
      orderBy: { sentAt: "asc" },
      take: 200,
    }),
  ]);
  const ids = [...new Set([...late, ...waiting].map((doc) => doc.closingId))];
  const closings = ids.length
    ? await prisma.closing.findMany({
        where: { id: { in: ids } },
        select: { id: true, closedAt: true, deskOwnerId: true, listing: { select: { title: true, notes: { select: { id: true, streetAddress: true, city: true, state: true } } } } },
      })
    : [];
  const owners = await prisma.user.findMany({ where: { id: { in: closings.map((row) => row.deskOwnerId).filter((id): id is string => Boolean(id)) } }, select: { id: true, name: true } });
  const ownerName = new Map(owners.map((row) => [row.id, row.name]));
  const byId = new Map(closings.map((row) => [row.id, row]));
  const view = (doc: (typeof late)[number]) => {
    const closing = byId.get(doc.closingId);
    return {
      id: doc.id,
      closingId: doc.closingId,
      title: closing?.listing.title ?? "A closing",
      owner: closing?.deskOwnerId ? ownerName.get(closing.deskOwnerId) ?? null : null,
      kind: kindLabel(doc.kind),
      loan: closing ? loanName(closing.listing.notes, doc.noteId) : null,
      from: sideWord(deliveringSide(doc)),
      dueAt: doc.dueAt,
      daysLate: daysLate(doc.dueAt, now),
      sentAt: doc.sentAt,
      escalated: Boolean(doc.escalatedAt),
    };
  };
  return { late: late.map(view), waiting: waiting.map(view) };
}
