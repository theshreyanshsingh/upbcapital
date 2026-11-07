import type { DocType } from "@prisma/client";
import { readInBackground } from "@/lib/ai-reading";
import { audit } from "@/lib/audit";
import { notifyDesk } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { extensionOf, mimeFor, putBytes, safeBasename } from "@/lib/storage";
import { uploadProblem } from "@/lib/uploads";
import { notifyWatchers } from "@/lib/watchers";

// A pool's seller or filing broker adds files after filing, in review and while live: listing-wide files, or one
// loan's own file. A loan's file opens by that loan's rule, the same as the desk's.

// The types a seller files with a listing. A loan's own file takes the same, less the tape.
export const SELLER_DOC_TYPES = ["NOTE", "MORTGAGE", "PAY_HISTORY", "BPO", "TITLE", "TAPE", "OTHER"] as const;
const OPEN_FOR_FILES = ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED"];
// A broker also files the note holder's mandate for each listing. It goes on the whole listing, and only the filer
// and the desk read it: lib/acl.ts isDeskOnlyDocument.
export const BROKER_DOC_TYPES = [...SELLER_DOC_TYPES, "MANDATE"] as const;

// The type a file is stored as. A type this filer isn't offered becomes Other, and a tape never goes on one loan.
export function roomFileType(type: string, input: { broker: boolean; noteId: string | null }): DocType {
  const offered: readonly string[] = input.broker ? BROKER_DOC_TYPES : SELLER_DOC_TYPES;
  if (!offered.includes(type) || (input.noteId && type === "TAPE")) return "OTHER";
  return type as DocType;
}

// mandateOnly: a broker adding only a mandate, which a single-note listing takes too, since a broker can't edit one.
export function poolFilesBlock(listing: { kind: string; status: string; sellerId: string; brokerId: string | null }, userId: string, options: { mandateOnly?: boolean } = {}) {
  if (listing.sellerId !== userId && listing.brokerId !== userId) return "That listing isn't yours.";
  if (listing.kind !== "POOL" && !options.mandateOnly) return "Files are added to a single note through Edit and resubmit.";
  if (!OPEN_FOR_FILES.includes(listing.status)) return "This listing is past the point of adding files.";
  return null;
}

export type IncomingFile = { name: string; bytes: Buffer; mime?: string; type: string };

// Saves what it can and returns the names it couldn't take, so the seller hears about them.
export async function addPoolFiles(actor: { id: string; name: string; companyName?: string | null }, input: { listingId: string; noteId?: string | null; files: IncomingFile[] }) {
  const listing = await prisma.listing.findUnique({ where: { id: input.listingId }, select: { id: true, kind: true, status: true, title: true, sellerId: true, brokerId: true } });
  if (!listing) return { error: "That listing isn't on file.", added: 0, skipped: [] as string[] };
  const broker = Boolean(listing.brokerId) && listing.brokerId === actor.id;
  const mandateOnly = broker && input.files.length > 0 && input.files.every((file) => file.type === "MANDATE");
  const block = poolFilesBlock(listing, actor.id, { mandateOnly });
  if (block) return { error: block, added: 0, skipped: [] as string[] };
  const noteId = input.noteId || null;
  if (noteId && !(await prisma.note.findFirst({ where: { id: noteId, listingId: listing.id }, select: { id: true } }))) {
    return { error: "That loan isn't in this pool.", added: 0, skipped: [] as string[] };
  }
  const skipped: string[] = [];
  let added = 0;
  // Files the data room shows. A mandate isn't one of them, so watchers aren't told of it.
  let roomAdded = 0;
  for (const file of input.files) {
    if (file.bytes.length <= 0) continue;
    const ext = extensionOf(file.name);
    if (uploadProblem(file.name, file.bytes.length, file.bytes) || !ext) {
      skipped.push(file.name);
      continue;
    }
    const type = roomFileType(file.type, { broker, noteId });
    // A mandate covers the whole listing, never one loan, so a loan's file rule can't open it.
    const fileNoteId = type === "MANDATE" ? null : noteId;
    const storedName = `${crypto.randomUUID()}-${safeBasename(file.name)}`;
    const mime = mimeFor(ext, file.mime || "application/octet-stream");
    await putBytes(storedName, file.bytes, mime);
    const document = await prisma.document.create({
      data: { listingId: listing.id, noteId: fileNoteId, type, originalName: file.name.slice(0, 180), storedName, mime, size: file.bytes.length },
    });
    await audit(actor.id, "LISTING_DOCUMENT", fileNoteId ? "note" : "listing", fileNoteId ?? listing.id, `${document.type} · ${document.id}`);
    added += 1;
    if (type !== "MANDATE") roomAdded += 1;
  }
  if (added > 0) {
    // The desk's reader reads the new files in the background, after the response has gone back.
    readInBackground(listing.id);
    const what = `${added} file${added === 1 ? "" : "s"}`;
    await notifyDesk(`Files added · ${listing.title}`, `${actor.companyName || actor.name} added ${what} to ${listing.title}${noteId ? ", on one loan" : ""}.`);
    // Watchers hear about new files only once the listing is live; in review nobody but the desk can see them.
    if (listing.status === "APPROVED" && roomAdded > 0) {
      const shown = `${roomAdded} file${roomAdded === 1 ? "" : "s"}`;
      await notifyWatchers({
        listingId: listing.id,
        event: "NEW_FILES",
        subject: `New files · ${listing.title}`,
        body: `The seller added ${shown} to the data room on ${listing.title}.`,
        except: [actor.id],
      });
    }
  }
  return { error: null, added, skipped };
}
