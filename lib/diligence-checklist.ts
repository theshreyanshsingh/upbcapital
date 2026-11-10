import type { Prisma } from "@prisma/client";
import { audit } from "@/lib/audit";
import { isReleaseBuild } from "@/lib/deploy";
import { showableAvm } from "@/lib/enrichment";
import { isENote } from "@/lib/enotes";
import { chainOfTitle, fieldState, groupByNote, type CollateralRow, type Outcome } from "@/lib/loan-file";
import { prisma } from "@/lib/prisma";
import { deskCan, DESK_DENIED, type Staff } from "@/lib/staff";
import { parseMersMin } from "@/lib/tape-fields";

// The diligence set a pool room expects before a trade: the paper, the pay history, title work, a dated value, the
// endorsements, the recorded assignments and the servicer's own record. Each item reads what the loan file and the
// documents already hold, so nothing here is entered twice. A missing item holds the approval until it is on file or
// compliance waives it with a reason, and buyers see which items were waived.

export const DILIGENCE_ITEMS = [
  { key: "NOTE", label: "Note or lost-note affidavit", scope: "loan", hint: "The signed note, or a lost-note affidavit where the original is gone." },
  { key: "MORTGAGE", label: "Mortgage or deed of trust", scope: "loan", hint: "The recorded mortgage or deed of trust." },
  { key: "PAY_HISTORY", label: "Pay history", scope: "loan", hint: "The servicer's payment history, for a loan that is paying." },
  { key: "TITLE", label: "Title policy or O&E report", scope: "loan", hint: "The lender's title policy, or an owner and encumbrances report." },
  { key: "VALUE", label: "Dated value", scope: "loan", hint: "A BPO or appraisal on file, or an AVM with its date." },
  { key: "ENDORSEMENTS", label: "Endorsement chain", scope: "loan", hint: "Each endorsement from the originator to the seller with no break, or marked not required." },
  {
    key: "ASSIGNMENTS",
    label: "Assignment chain",
    scope: "loan",
    hint: "Each recorded assignment from the originating lender to the seller with no break, or marked not required. A loan MERS holds as original mortgagee needs none once the desk checks its MIN against the mortgage.",
  },
  { key: "SERVICER_REPORT", label: "Servicer's report", scope: "listing", hint: "The servicer's export for the pool, applied through the servicer report." },
] as const;

export type DiligenceKey = (typeof DILIGENCE_ITEMS)[number]["key"];
export type DiligenceScope = (typeof DILIGENCE_ITEMS)[number]["scope"];

export function isDiligenceKey(value: unknown): value is DiligenceKey {
  return typeof value === "string" && DILIGENCE_ITEMS.some((item) => item.key === value);
}

export function diligenceLabel(key: string) {
  return DILIGENCE_ITEMS.find((item) => item.key === key)?.label ?? key;
}

// ---------------------------------------------------------------------------------------------------------------
// Waivers: { "PAY_HISTORY": {...} } covers every loan, { "PAY_HISTORY:<noteId>": {...} } covers one.

export type Waiver = { by: string; at: string; reason: string };

export function waiverKey(item: DiligenceKey, noteId?: string | null) {
  return noteId ? `${item}:${noteId}` : item;
}

// Reads Listing.diligenceWaivers defensively. Anything malformed is dropped, so it reads as not waived.
export function readWaivers(json: unknown): Record<string, Waiver> {
  if (!json || typeof json !== "object" || Array.isArray(json)) return {};
  const out: Record<string, Waiver> = {};
  for (const [key, raw] of Object.entries(json as Record<string, unknown>)) {
    const [item] = key.split(":");
    if (!isDiligenceKey(item) || !raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.by !== "string" || typeof entry.at !== "string" || typeof entry.reason !== "string") continue;
    out[key] = { by: entry.by, at: entry.at, reason: entry.reason };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// What is on file

export type DiligenceNote = {
  id: string;
  streetAddress?: string;
  city: string;
  state: string;
  lienPosition: string;
  paymentStatus: string;
  avmValue?: number | null;
  avmProvider?: string;
  avmAsOf?: Date | null;
  servicerSourcedAt?: Date | null;
  eNote?: boolean | null;
  mersMin?: string | null;
  verifiedFields?: unknown;
};

export type DiligenceDocument = { type: string; noteId?: string | null; originalName: string };

export type DiligenceInput = {
  kind: string;
  notes: DiligenceNote[];
  collateral: (CollateralRow & { noteId: string })[];
  documents: DiligenceDocument[];
  waivers?: unknown;
  holder?: string | null;
  release?: boolean;
};

const AFFIDAVIT = /affidavit/i;

// One collateral kind and the document type that stands for it. The desk's own line wins: a line it marked
// missing or defective isn't on file whatever was uploaded, and one it marked on file is.
function held(rows: CollateralRow[], kind: string, docs: DiligenceDocument[], docType: string) {
  const lines = rows.filter((row) => row.kind === kind);
  if (lines.some((row) => row.status === "PRESENT")) return true;
  if (lines.some((row) => row.status === "MISSING" || row.status === "DEFECTIVE")) return false;
  return docs.some((doc) => doc.type === docType);
}

// MERS is the mortgagee of record on a MOM loan: the mortgage names MERS as nominee and carries the MIN, and sales
// between MERS members are tracked on the MERS System by MIN, so nothing is recorded at the county. An 18-digit MIN
// on the tape only says the loan is registered, which anyone can type, so it counts once the desk has checked the MIN
// against the mortgage (lib/loan-file.ts fieldState). A MIN that has since changed reads as unchecked again.
function mersOriginalMortgagee(note: DiligenceNote) {
  return parseMersMin(note.mersMin ?? "") !== null && fieldState(note, "mersMin").state === "verified";
}

function requiredFor(key: DiligenceKey, note: DiligenceNote, rows: CollateralRow[]) {
  // A loan that is paying is priced off its history. A non-performing loan's history says little the status doesn't.
  if (key === "PAY_HISTORY") return note.paymentStatus === "PERFORMING" || note.paymentStatus === "SUB_PERFORMING";
  // An eNote has no endorsements: control moves on the MERS eRegistry. lib/enotes.ts.
  if (key === "ENDORSEMENTS") return !isENote(note);
  // The mortgage travels by recorded assignment whether the note is paper or an eNote, so an eNote is still asked.
  // A MOM loan with no assignment recorded on file isn't: MERS still holds the lien. Once the desk records a link,
  // the chain is read like any other, so an assignment out of MERS has to reach the seller. A loan assigned into MERS
  // later carries the recorded link to MERS, which the chain reads as unbroken. Anything else, such as a MIN the desk
  // can't check, goes through a compliance waiver.
  if (key === "ASSIGNMENTS") return !(mersOriginalMortgagee(note) && !rows.some((row) => row.kind === "ASSIGNMENT" && row.status !== "NOT_REQUIRED"));
  return true;
}

function onFile(key: DiligenceKey, note: DiligenceNote, rows: CollateralRow[], docs: DiligenceDocument[], holder: string | null, release: boolean) {
  if (key === "NOTE") {
    // The desk notes a lost original on the note's line, or the affidavit comes in as a file.
    if (rows.some((row) => row.kind === "ORIGINAL_NOTE" && AFFIDAVIT.test(row.detail ?? ""))) return true;
    if (docs.some((doc) => AFFIDAVIT.test(doc.originalName))) return true;
    return held(rows, "ORIGINAL_NOTE", docs, "NOTE");
  }
  if (key === "MORTGAGE") return held(rows, "MORTGAGE", docs, "MORTGAGE");
  if (key === "PAY_HISTORY") return held(rows, "PAY_HISTORY", docs, "PAY_HISTORY");
  if (key === "TITLE") return held(rows, "TITLE_POLICY", docs, "TITLE") || held(rows, "OE_REPORT", docs, "OE_REPORT");
  if (key === "VALUE") {
    // A stand-in AVM is hidden from buyers in a release build, so it doesn't count there either.
    const avm = showableAvm({ avmValue: note.avmValue ?? null, avmProvider: note.avmProvider ?? "" }, release);
    return held(rows, "BPO", docs, "BPO") || (avm != null && Boolean(note.avmAsOf));
  }
  if (key === "ENDORSEMENTS") {
    const chain = chainOfTitle(rows, holder).endorsements;
    if (chain.waived !== null) return true;
    if (chain.links.length) return chain.breaks.length === 0;
    // An allonge on file stands until the desk records the chain and finds a break.
    return docs.some((doc) => doc.type === "ALLONGE");
  }
  if (key === "ASSIGNMENTS") {
    // The same reading as the endorsements. Marked not required (the seller originated the loan) counts. Recorded
    // links count only with no break: a gap between links, a link missing a party, one the desk marked missing or
    // defective, or a last assignee who isn't the seller and isn't MERS (lib/loan-file.ts buildChain).
    const chain = chainOfTitle(rows, holder).assignments;
    if (chain.waived !== null) return true;
    if (chain.links.length) return chain.breaks.length === 0;
    // A recorded assignment on file stands until the desk records the chain and finds a break.
    return docs.some((doc) => doc.type === "ASSIGNMENT");
  }
  return false;
}

export type DiligenceGap = { noteId: string | null; label: string };
export type DiligenceLine = {
  key: DiligenceKey;
  label: string;
  hint: string;
  scope: DiligenceScope;
  required: number;
  onFile: number;
  missing: DiligenceGap[];
  waived: (DiligenceGap & { waiver: Waiver; whole: boolean })[];
  state: "complete" | "waived" | "missing" | "not_required";
};

export type Diligence = { lines: DiligenceLine[]; complete: boolean; missing: number; waived: number };

export function loanLabel(note: DiligenceNote, index: number, pool: boolean) {
  const place = `${note.city}, ${note.state}`;
  return pool ? `Loan ${index + 1} · ${place}` : place;
}

export function diligenceChecklist(input: DiligenceInput): Diligence {
  const pool = input.kind === "POOL";
  const waivers = readWaivers(input.waivers);
  const byNote = groupByNote(input.collateral);
  // A single note's files come in on the listing. A pool's listing-level files can't be told apart by loan.
  const docsFor = (noteId: string) => input.documents.filter((doc) => doc.noteId === noteId || (!pool && !doc.noteId));
  const holder = input.holder ?? null;
  const release = input.release ?? isReleaseBuild(process.env);
  const lines = DILIGENCE_ITEMS.map((item): DiligenceLine => {
    const whole = waivers[item.key];
    const gaps: DiligenceGap[] = [];
    let required = 0;
    if (item.scope === "listing") {
      if (pool) {
        required = 1;
        const report = input.notes.some((note) => note.servicerSourcedAt) || input.documents.some((doc) => doc.type === "TAPE" && doc.originalName.startsWith("servicer-report-"));
        if (!report) gaps.push({ noteId: null, label: "The pool" });
      }
    } else {
      input.notes.forEach((note, index) => {
        const rows = byNote.get(note.id) ?? [];
        if (!requiredFor(item.key, note, rows)) return;
        required += 1;
        if (!onFile(item.key, note, rows, docsFor(note.id), holder, release)) gaps.push({ noteId: note.id, label: loanLabel(note, index, pool) });
      });
    }
    const missing: DiligenceGap[] = [];
    const waived: DiligenceLine["waived"] = [];
    for (const gap of gaps) {
      const own = gap.noteId ? waivers[waiverKey(item.key, gap.noteId)] : undefined;
      const waiver = own ?? whole;
      if (waiver) waived.push({ ...gap, waiver, whole: !own });
      else missing.push(gap);
    }
    const state = required === 0 ? "not_required" : missing.length ? "missing" : waived.length ? "waived" : "complete";
    return { key: item.key, label: item.label, hint: item.hint, scope: item.scope, required, onFile: required - gaps.length, missing, waived, state };
  });
  const missing = lines.reduce((sum, line) => sum + line.missing.length, 0);
  const waived = lines.reduce((sum, line) => sum + line.waived.length, 0);
  return { lines, complete: missing === 0, missing, waived };
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// "Pay history on 3 loans", or "Servicer's report" for an item the listing has once.
function gapText(line: DiligenceLine, pool: boolean) {
  if (line.scope === "listing" || !pool) return line.label;
  return `${line.label} on ${plural(line.missing.length, "loan")}`;
}

// What stops an approval, in words, or null when nothing does.
export function diligenceGateMessage(diligence: Diligence, kind: string) {
  if (diligence.complete) return null;
  const open = diligence.lines.filter((line) => line.state === "missing").map((line) => gapText(line, kind === "POOL"));
  return `The diligence set isn't complete: ${open.join(", ")}. Add each to the loan file, or compliance waives it with a reason, before the listing can go live.`;
}

// What a buyer reads: complete, or the items waived and still missing, without loan names.
export function buyerDiligence(diligence: Diligence) {
  const waived = diligence.lines
    .filter((line) => line.waived.length)
    .map((line) => ({
      key: line.key,
      label: line.label,
      loans: line.scope === "loan" ? line.waived.length : 0,
      reasons: [...new Set(line.waived.map((row) => row.waiver.reason))],
    }));
  const missing = diligence.lines.filter((line) => line.missing.length).map((line) => ({ key: line.key, label: line.label, loans: line.scope === "loan" ? line.missing.length : 0 }));
  return { complete: diligence.complete && waived.length === 0, waived, missing };
}

// ---------------------------------------------------------------------------------------------------------------
// Loading

export async function loadDiligence(listingId: string) {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: {
      id: true,
      kind: true,
      status: true,
      updatedAt: true,
      diligenceWaivers: true,
      clientSellerName: true,
      seller: { select: { name: true, companyName: true } },
      notes: { select: { id: true, streetAddress: true, city: true, state: true, lienPosition: true, paymentStatus: true, avmValue: true, avmProvider: true, avmAsOf: true, servicerSourcedAt: true, eNote: true, mersMin: true, verifiedFields: true } },
      documents: { where: { type: { notIn: ["PHOTO", "NDA", "MANDATE"] } }, select: { type: true, noteId: true, originalName: true } },
    },
  });
  if (!listing) return null;
  const collateral = await prisma.collateralItem.findMany({ where: { noteId: { in: listing.notes.map((note) => note.id) } }, orderBy: [{ sequence: "asc" }, { createdAt: "asc" }] });
  const holder = listing.clientSellerName || listing.seller.companyName || listing.seller.name || null;
  const diligence = diligenceChecklist({ kind: listing.kind, notes: listing.notes, collateral, documents: listing.documents, waivers: listing.diligenceWaivers, holder });
  return { listing, diligence };
}

export async function diligenceHold(listingId: string) {
  const loaded = await loadDiligence(listingId);
  return loaded ? diligenceGateMessage(loaded.diligence, loaded.listing.kind) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Waiving, by a compliance desk member with a reason

const WAIVABLE = new Set(["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED"]);
const fail = (error: string): Outcome<never> => ({ ok: false, error });
const clean = (text: string | null | undefined, max: number) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export async function waiveDiligence(
  actor: Staff & { id: string },
  input: { listingId: string; item: string; noteId?: string | null; reason: string; now?: Date },
): Promise<Outcome<{ key: string }>> {
  if (actor.role !== "ADMIN" || !deskCan(actor, "compliance")) return fail(DESK_DENIED);
  if (!isDiligenceKey(input.item)) return fail("Choose an item to waive.");
  const reason = clean(input.reason, 300);
  if (reason.length < 3) return fail("Say why the item is waived. Buyers read the reason.");
  const loaded = await loadDiligence(input.listingId);
  if (!loaded) return fail("That listing isn't on file.");
  if (!WAIVABLE.has(loaded.listing.status)) return fail("Items are waived before the listing is in contract.");
  const line = loaded.diligence.lines.find((row) => row.key === input.item)!;
  const noteId = input.noteId || null;
  if (noteId && line.scope !== "loan") return fail("That item is for the pool as a whole.");
  if (noteId && !loaded.listing.notes.some((note) => note.id === noteId)) return fail("That loan isn't on this listing.");
  const open = noteId ? line.missing.some((gap) => gap.noteId === noteId) : line.missing.length > 0;
  if (!open) return fail("Nothing is missing under that item.");
  const key = waiverKey(input.item, noteId);
  const waivers = { ...readWaivers(loaded.listing.diligenceWaivers), [key]: { by: actor.id, at: (input.now ?? new Date()).toISOString(), reason } };
  // Two waivers at once would each write the map they read, so the second asks for a reload instead.
  const moved = await prisma.listing.updateMany({ where: { id: loaded.listing.id, updatedAt: loaded.listing.updatedAt }, data: { diligenceWaivers: waivers as Prisma.InputJsonValue } });
  if (moved.count !== 1) return fail("The listing changed a moment ago. Reload and try again.");
  await audit(actor.id, "DILIGENCE_WAIVED", "listing", loaded.listing.id, `${line.label}${noteId ? ` · loan ${noteId}` : line.scope === "loan" ? " · every loan" : ""} · ${reason}`);
  return { ok: true, value: { key } };
}

export async function clearDiligenceWaiver(actor: Staff & { id: string }, input: { listingId: string; key: string }): Promise<Outcome<null>> {
  if (actor.role !== "ADMIN" || !deskCan(actor, "compliance")) return fail(DESK_DENIED);
  const listing = await prisma.listing.findUnique({ where: { id: input.listingId }, select: { id: true, status: true, updatedAt: true, diligenceWaivers: true } });
  if (!listing) return fail("That listing isn't on file.");
  if (!WAIVABLE.has(listing.status)) return fail("Waivers are changed before the listing is in contract.");
  const waivers = readWaivers(listing.diligenceWaivers);
  if (!waivers[input.key]) return fail("That waiver isn't on file.");
  const [item] = input.key.split(":");
  delete waivers[input.key];
  const moved = await prisma.listing.updateMany({ where: { id: listing.id, updatedAt: listing.updatedAt }, data: { diligenceWaivers: waivers as Prisma.InputJsonValue } });
  if (moved.count !== 1) return fail("The listing changed a moment ago. Reload and try again.");
  await audit(actor.id, "DILIGENCE_WAIVER_CLEARED", "listing", listing.id, `${diligenceLabel(item)}${input.key.includes(":") ? ` · loan ${input.key.split(":")[1]}` : ""}`);
  return { ok: true, value: null };
}
