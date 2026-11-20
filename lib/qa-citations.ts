import { PDFDocument } from "pdf-lib";
import { canManageRoom, isDeskOnlyDocument } from "@/lib/acl";
import { decodeText, draftSources, isPdfBytes, pdfText } from "@/lib/ai-reading";
import { audit } from "@/lib/audit";
import { unset } from "@/lib/db-filters";
import { docLabel } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { documentGate } from "@/lib/room-access";
import { getBytes } from "@/lib/storage";

// Cited answers. A published answer can name the data-room file, the page and the words it relies on, so a bidder can
// check it against the file. Whoever answers picks the file. UPB checks that the file is this listing's, that the page
// is in it, and, where the reader's own extraction can read the file's words, that the quote is there. A bidder reads
// the file's name, the quote and the link only when the room's rules already open that file to them.

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string) => ({ ok: false as const, error });

export const QUOTE_MAX = 300;
// The furthest page anyone types for a file whose length UPB can't tell, as the reader takes from a model.
const PAGE_MAX = 5000;

// found: the words are in the file. missing: the file's words were read and the quote isn't among them. unchecked:
// the file has no words UPB can read (a scan, an image), so the quote went out as written. none: no quote given.
export type QuoteCheck = "found" | "missing" | "unchecked" | "none";
export const QUOTE_NOT_CHECKED = "Quote not checked";

export type Citation = { documentId: string; page: number | null; quote: string | null };
export type CitationInput = { documentId?: unknown; page?: unknown; quote?: unknown };

type CitableFile = { type: string; storedName: string };

// The files an answer may cite: the listing's data room and its loans' own files. A photo isn't paper, and a signed
// NDA, the broker's seller authorization and a mandate never go out with the room, so none of them is a source.
export function citable(document: CitableFile, listing: { authorizationKey: string }) {
  if (document.type === "PHOTO" || document.type === "NDA" || isDeskOnlyDocument(document)) return false;
  return !(listing.authorizationKey !== "" && document.storedName === listing.authorizationKey);
}

// The answer form's choice of files, for the seller, the broker and the desk.
export async function citableDocuments(listingId: string) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { authorizationKey: true } });
  if (!listing) return [];
  const documents = await prisma.document.findMany({
    where: { listingId },
    orderBy: { createdAt: "asc" },
    select: { id: true, type: true, storedName: true, originalName: true, noteId: true },
  });
  return documents
    .filter((document) => citable(document, listing))
    .map((document) => ({ id: document.id, type: document.type, originalName: document.originalName, noteId: document.noteId }));
}

// The answer form's three fields. The citation is optional, so empty fields mean none.
export function citationInput(formData: FormData): CitationInput {
  return { documentId: formData.get("sourceDocId"), page: formData.get("sourcePage"), quote: formData.get("sourceQuote") };
}

// Quotes match whatever the spacing, line breaks and case, and a curly quote or a long dash matches a plain one.
function squeeze(text: string) {
  return text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, "-").replace(/\s+/g, "").toLowerCase();
}

export function quoteInText(text: string, quote: string) {
  const key = squeeze(quote);
  return key.length >= 3 && squeeze(text).includes(key);
}

// What UPB can tell of a file with the reader's own extraction (lib/ai-reading.ts): a text or CSV file's words and its
// form-feed pages, and a PDF's page count with whatever words it draws. A scan or an image has no words to read, and
// a file that can't be opened from storage tells nothing. Null means unknown.
export async function fileFacts(document: { storedName: string }): Promise<{ text: string | null; pages: number | null }> {
  let bytes: Awaited<ReturnType<typeof getBytes>>;
  try {
    bytes = await getBytes(document.storedName);
  } catch {
    return { text: null, pages: null };
  }
  if (isPdfBytes(bytes)) {
    let pages: number | null = null;
    let encrypted = false;
    try {
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      pages = pdf.getPageCount();
      encrypted = pdf.isEncrypted;
    } catch {
      // A PDF that won't parse still takes a page; its length just isn't known.
    }
    // An encrypted PDF's words can't be read from its bytes, so its quotes aren't checked.
    return { text: encrypted ? null : pdfText(bytes) || null, pages };
  }
  const text = decodeText(bytes);
  return { text, pages: text == null ? null : text.split("\f").length };
}

// Checks one citation against the listing before it is stored. Refused: a file that isn't this listing's to cite, a
// page that isn't a whole number from 1, or one past the end of the file. A quote is never a reason to refuse: one
// the file's words don't hold is left off (a bidder never reads words the file doesn't have), and one UPB can't read
// the file to check is kept and marked unchecked to the answerer.
export async function checkCitation(listingId: string, input: CitationInput): Promise<Outcome<{ citation: Citation | null; check: QuoteCheck }>> {
  const documentId = String(input.documentId ?? "").trim();
  const pageText = String(input.page ?? "").trim();
  const quote = String(input.quote ?? "").replace(/\s+/g, " ").trim();
  if (!documentId) {
    if (pageText || quote) return fail("Choose the file the source is in, or clear its page and quote.");
    return { ok: true, value: { citation: null, check: "none" } };
  }
  const document = await prisma.document.findUnique({ where: { id: documentId }, include: { listing: { select: { authorizationKey: true } } } });
  if (!document || document.listingId !== listingId || !citable(document, document.listing)) return fail("That file isn't in this listing's data room.");
  let page: number | null = null;
  if (pageText) {
    page = /^\d+$/.test(pageText) ? Number(pageText) : NaN;
    if (!Number.isInteger(page) || page < 1 || page > PAGE_MAX) return fail("The page is a whole number, 1 or more.");
  }
  if (quote.length > QUOTE_MAX) return fail(`Keep the quote to ${QUOTE_MAX} characters.`);
  if (page == null && !quote) return { ok: true, value: { citation: { documentId, page: null, quote: null }, check: "none" } };
  const facts = await fileFacts(document);
  if (page != null && facts.pages != null && page > facts.pages) {
    return fail(`Page ${page} is past the end of that file, which has ${facts.pages} page${facts.pages === 1 ? "" : "s"}.`);
  }
  if (!quote) return { ok: true, value: { citation: { documentId, page, quote: null }, check: "none" } };
  if (facts.text == null) return { ok: true, value: { citation: { documentId, page, quote }, check: "unchecked" } };
  if (quoteInText(facts.text, quote)) return { ok: true, value: { citation: { documentId, page, quote }, check: "found" } };
  return { ok: true, value: { citation: { documentId, page, quote: null }, check: "missing" } };
}

// The row's fields for a checked citation.
export function citationData(citation: Citation) {
  return { answerSourceDocId: citation.documentId, answerSourcePage: citation.page, answerSourceQuote: citation.quote };
}

// What the answerer is told once the source is stored. Kept short and free of file names: notices travel in the
// address bar and show only as plain sentences (lib/notice-text.ts).
export function sourceLine(cited: boolean, check: QuoteCheck) {
  if (!cited) return "";
  if (check === "found") return "The source is attached, and its quote is in the file.";
  if (check === "unchecked") return `The source is attached. ${QUOTE_NOT_CHECKED}: UPB can't read that file's words, so the quote shows as written.`;
  if (check === "missing") return "The source is attached without its quote: UPB couldn't find those words in the file.";
  return "The source is attached.";
}

// Adds the source to an answer already published without one. The answer itself doesn't change, so nobody is told.
// The same people may do it who may answer: the seller, the filing broker and the desk.
export async function citeAnswer(actor: { id: string; role: string }, input: { questionId: string; source: CitationInput }): Promise<Outcome<{ check: QuoteCheck }>> {
  const question = input.questionId
    ? await prisma.listingQuestion.findUnique({ where: { id: input.questionId }, include: { listing: { select: { sellerId: true, brokerId: true } } } })
    : null;
  if (!question || !canManageRoom(actor, question.listing)) return fail("That question isn't on your listing.");
  if (question.status !== "ANSWERED") return fail("Only a published answer takes a source.");
  if (question.answerSourceDocId) return fail("That answer already names its source.");
  if (!String(input.source.documentId ?? "").trim()) return fail("Choose the file the answer relies on.");
  const checked = await checkCitation(question.listingId, input.source);
  if (!checked.ok) return checked;
  const citation = checked.value.citation!;
  // Claimed while it has no source, so two people adding one at once store one.
  const claimed = await prisma.listingQuestion.updateMany({
    where: { id: question.id, status: "ANSWERED", ...unset("answerSourceDocId") },
    data: citationData(citation),
  });
  if (claimed.count !== 1) return fail("That answer already names its source.");
  await audit(actor.id, "QUESTION_SOURCE", "listing", question.listingId, `${question.id} · ${citation.documentId} · ${checked.value.check}`);
  return { ok: true, value: { check: checked.value.check } };
}

// The citation the answer form starts from when the answerer takes the reader's draft: the draft's first source still
// citable on this listing, with its page where the reader knew it.
export function draftCitation(aiSources: string | null | undefined, documents: { id: string }[]): Citation | null {
  const ids = new Set(documents.map((document) => document.id));
  const source = draftSources(aiSources).find((item) => ids.has(item.documentId));
  return source ? { documentId: source.documentId, page: source.page ?? null, quote: source.quote.slice(0, QUOTE_MAX) || null } : null;
}

// One answer's source as one viewer reads it. `href` is the data-room download route, which stamps a bidder's copy
// and logs the download. Without it the viewer reads only the kind of file and the page.
export type SourceView = { name: string; page: number | null; quote: string | null; href: string | null };

type Cited = { id: string; listingId: string; answerSourceDocId?: string | null; answerSourcePage?: number | null; answerSourceQuote?: string | null };
type Viewer = Parameters<typeof documentGate>[0];

// The sources of a listing's published answers as this viewer may read them, by answer id. A file opens to them by
// the download route's own rule (lib/room-access.ts documentGate, over lib/acl.ts and lib/data-room.ts): its name,
// the quote and a link. A file the room doesn't open to them shows as its kind and page, with no quote, since file
// names often carry a borrower or a street (components/data-room-list.tsx). A removed file shows no source.
export async function sourcesFor(viewer: Viewer, rows: Cited[]) {
  const views = new Map<string, SourceView>();
  const gates = new Map<string, Awaited<ReturnType<typeof documentGate>>>();
  for (const row of rows) {
    const documentId = row.answerSourceDocId;
    if (!documentId) continue;
    if (!gates.has(documentId)) gates.set(documentId, await documentGate(viewer, documentId));
    const { document, allowed } = gates.get(documentId)!;
    if (!document || document.listingId !== row.listingId || !citable(document, document.listing)) continue;
    const page = row.answerSourcePage ?? null;
    views.set(
      row.id,
      allowed
        ? { name: document.originalName, page, quote: row.answerSourceQuote || null, href: `/api/documents/${document.id}` }
        : { name: docLabel(document.type), page, quote: null, href: null },
    );
  }
  return views;
}

// The desk's line: answers published without a source, newest first.
export function uncited<T extends { status: string; answerSourceDocId?: string | null }>(rows: T[]) {
  return rows.filter((row) => row.status === "ANSWERED" && !row.answerSourceDocId);
}
