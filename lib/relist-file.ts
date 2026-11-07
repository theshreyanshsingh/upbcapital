import { Prisma, type Document, type Note } from "@prisma/client";
import { isPrivateDocument } from "@/lib/acl";
import { prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";

// A relist is the same loan offered again, so its file travels with it: every fact on the loan, the collateral the
// desk reviewed, its risk checks, the tape differences and how each was answered, and the loan's own documents.
// Checks keep the dates they were made, which say when the desk looked; the listing says they come from the earlier
// sale. Bids, NDAs, views, signed agreements and the broker's seller authorization never travel.

// Not facts about the loan: the row's identity, the listing it sat on, whether it traded there, and when it was filed.
const NOT_LOAN_FACTS = new Set<string>(["id", "listingId", "tradeStatus", "createdAt"]);

// Every scalar on Note but those, read from the generated client, so a field added to the loan later is carried too.
export const RELIST_FIELDS = (Object.values(Prisma.NoteScalarFieldEnum) as string[]).filter((field) => !NOT_LOAN_FACTS.has(field));

// What the relist sets itself: its own asking price, and for a participation the share of balance, value and payment.
export type LoanOverrides = Partial<Pick<Note, "upb" | "estimatedValue" | "monthlyPi" | "askingPrice" | "memo">>;

// A row's fields for a fresh copy. Empty values are left off, so an optional field reads as missing, as it did.
function copyOf(row: object, fields: string[], set: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    if (field === "id") continue;
    const value = (row as Record<string, unknown>)[field];
    if (value !== null && value !== undefined) data[field] = value;
  }
  return { ...data, ...set };
}

export function relistLoanData(note: Note, overrides: LoanOverrides = {}) {
  return copyOf(note, RELIST_FIELDS, overrides);
}

type FileDocument = Pick<Document, "id" | "type" | "storedName" | "noteId">;

// The documents a relist carries. A loan's own files go with that loan and keep its rule, so they still open only
// to who may see it. The room's files cover every loan, so they come only when every loan does. A signed NDA and
// the seller authorization are private wherever they sit.
export function relistDocuments<T extends FileDocument>(listing: { authorizationKey: string; documents: T[] }, noteIds: Set<string>, wholeSource: boolean) {
  return listing.documents.filter((document) => {
    if (isPrivateDocument({ type: document.type, storedName: document.storedName }, listing)) return false;
    if (document.noteId) return noteIds.has(document.noteId);
    return wholeSource && !isPrivateDocument(document, listing);
  });
}

// The line on the new listing that says where the file came from.
export function carriedFileLine(soldOn: Date | null | undefined) {
  return `The desk verified this loan file for the earlier sale${soldOn ? ` on ${prettyDate(soldOn)}` : ""}, and it carries over as it was. Each check shows the date it was made.`;
}

export type CarriedFile = { notes: Map<string, string>; documents: number; collateral: number; risks: number; discrepancies: number; verifiedFields: number };

const COLLATERAL_FIELDS = Object.values(Prisma.CollateralItemScalarFieldEnum) as string[];
const RISK_FIELDS = Object.values(Prisma.RiskCheckScalarFieldEnum) as string[];
const DISCREPANCY_FIELDS = Object.values(Prisma.FieldDiscrepancyScalarFieldEnum) as string[];

// Writes the relisted loans onto the new listing with their verified file. Returns the new loan for each old one.
export async function copyLoanFile(input: {
  source: { id: string; authorizationKey: string };
  notes: Note[];
  toListingId: string;
  overrides?: (note: Note) => LoanOverrides;
  // The room's files come along only when the relist takes every loan on the source listing.
  wholeSource: boolean;
}): Promise<CarriedFile> {
  const ids = input.notes.map((note) => note.id);
  const [documents, collateral, risks, discrepancies] = await Promise.all([
    prisma.document.findMany({ where: { listingId: input.source.id } }),
    prisma.collateralItem.findMany({ where: { noteId: { in: ids } } }),
    prisma.riskCheck.findMany({ where: { noteId: { in: ids } } }),
    prisma.fieldDiscrepancy.findMany({ where: { noteId: { in: ids } } }),
  ]);
  const notes = new Map<string, string>();
  // A field the relist changed, such as a participation's share of the balance, has a different value now, so a
  // difference raised on the old figure no longer applies to it.
  const changed = new Map<string, Set<string>>();
  let verifiedFields = 0;
  for (const note of input.notes) {
    const overrides = input.overrides?.(note) ?? {};
    const created = await prisma.note.create({ data: { ...relistLoanData(note, overrides), listingId: input.toListingId } as never });
    notes.set(note.id, created.id);
    changed.set(note.id, new Set(Object.entries(overrides).filter(([field, value]) => (note as Record<string, unknown>)[field] !== value).map(([field]) => field)));
    if (note.verifiedFields && typeof note.verifiedFields === "object" && !Array.isArray(note.verifiedFields)) verifiedFields += Object.keys(note.verifiedFields).length;
  }
  const moved = new Map<string, string>();
  for (const document of relistDocuments({ authorizationKey: input.source.authorizationKey, documents }, new Set(ids), input.wholeSource)) {
    const created = await prisma.document.create({
      data: {
        listingId: input.toListingId,
        noteId: document.noteId ? notes.get(document.noteId) ?? null : null,
        type: document.type,
        originalName: document.originalName,
        storedName: document.storedName,
        mime: document.mime,
        size: document.size,
        // Filed when it was filed, not when the relist copied it.
        createdAt: document.createdAt,
      },
    });
    moved.set(document.id, created.id);
  }
  const linked = (id: string | null) => (id ? moved.get(id) ?? null : null);
  for (const item of collateral) {
    await prisma.collateralItem.create({
      data: copyOf(item, COLLATERAL_FIELDS, { noteId: notes.get(item.noteId), documentId: linked(item.documentId), photoDocumentId: linked(item.photoDocumentId) }) as never,
    });
  }
  for (const check of risks) {
    await prisma.riskCheck.create({ data: copyOf(check, RISK_FIELDS, { noteId: notes.get(check.noteId), documentId: linked(check.documentId) }) as never });
  }
  let carried = 0;
  for (const row of discrepancies) {
    if (changed.get(row.noteId)?.has(row.field)) continue;
    await prisma.fieldDiscrepancy.create({ data: copyOf(row, DISCREPANCY_FIELDS, { noteId: notes.get(row.noteId), listingId: input.toListingId }) as never });
    carried += 1;
  }
  return { notes, documents: moved.size, collateral: collateral.length, risks: risks.length, discrepancies: carried, verifiedFields };
}

// Whether anything the desk checked came along, so the listing says where it is from.
export function carriedSomething(file: CarriedFile) {
  return file.collateral + file.risks + file.discrepancies + file.verifiedFields > 0;
}
