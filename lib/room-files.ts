import type { DocType } from "@prisma/client";
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

export function poolFilesBlock(listing: { kind: string; status: string; sellerId: string; brokerId: string | null }, userId: string) {
  if (listing.sellerId !== userId && listing.brokerId !== userId) return "That listing isn't yours.";
  if (listing.kind !== "POOL") return "Files are added to a single note through Edit and resubmit.";
  if (!OPEN_FOR_FILES.includes(listing.status)) return "This listing is past the point of adding files.";
  return null;
}

export type IncomingFile = { name: string; bytes: Buffer; mime?: string; type: string };

// Saves what it can and returns the names it couldn't take, so the seller hears about them.
export async function addPoolFiles(actor: { id: string; name: string; companyName?: string | null }, input: { listingId: string; noteId?: string | null; files: IncomingFile[] }) {
  const listing = await prisma.listing.findUnique({ where: { id: input.listingId }, select: { id: true, kind: true, status: true, title: true, sellerId: true, brokerId: true } });
  if (!listing) return { error: "That listing isn't on file.", added: 0, skipped: [] as string[] };
  const block = poolFilesBlock(listing, actor.id);
  if (block) return { error: block, added: 0, skipped: [] as string[] };
  const noteId = input.noteId || null;
  if (noteId && !(await prisma.note.findFirst({ where: { id: noteId, listingId: listing.id }, select: { id: true } }))) {
    return { error: "That loan isn't in this pool.", added: 0, skipped: [] as string[] };
  }
  const skipped: string[] = [];
  let added = 0;
  for (const file of input.files) {
    if (file.bytes.length <= 0) continue;
    const ext = extensionOf(file.name);
    if (uploadProblem(file.name, file.bytes.length, file.bytes) || !ext) {
      skipped.push(file.name);
      continue;
    }
    const allowed = (SELLER_DOC_TYPES as readonly string[]).includes(file.type) && !(noteId && file.type === "TAPE");
    const type = (allowed ? file.type : "OTHER") as DocType;
    const storedName = `${crypto.randomUUID()}-${safeBasename(file.name)}`;
    const mime = mimeFor(ext, file.mime || "application/octet-stream");
    await putBytes(storedName, file.bytes, mime);
    const document = await prisma.document.create({
      data: { listingId: listing.id, noteId, type, originalName: file.name.slice(0, 180), storedName, mime, size: file.bytes.length },
    });
    await audit(actor.id, "LISTING_DOCUMENT", noteId ? "note" : "listing", noteId ?? listing.id, `${document.type} · ${document.id}`);
    added += 1;
  }
  if (added > 0) {
    const what = `${added} file${added === 1 ? "" : "s"}`;
    await notifyDesk(`Files added · ${listing.title}`, `${actor.companyName || actor.name} added ${what} to ${listing.title}${noteId ? ", on one loan" : ""}.`);
    // Watchers hear about new files only once the listing is live; in review nobody but the desk can see them.
    if (listing.status === "APPROVED") {
      await notifyWatchers({
        listingId: listing.id,
        event: "NEW_FILES",
        subject: `New files · ${listing.title}`,
        body: `The seller added ${what} to the data room on ${listing.title}.`,
        except: [actor.id],
      });
    }
  }
  return { error: null, added, skipped };
}
