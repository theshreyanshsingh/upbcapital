import { canOpenListing, openableListingIds, type Viewer } from "@/lib/access";
import { loanOpenTo, ndaOpensRoom } from "@/lib/acl";
import { audit } from "@/lib/audit";
import { dealAccess } from "@/lib/data-room";
import { prisma } from "@/lib/prisma";
import { listingSight } from "@/lib/private-listings";
import { getSettings } from "@/lib/settings";
import { extensionOf, mimeFor, putBytes, safeBasename } from "@/lib/storage";
import { uploadProblem } from "@/lib/uploads";

// Property photos. Each is a PHOTO document on one loan of the listing, since a pool's loans are different houses.
// A photo shows the property, so it opens exactly where that loan's street address does. Photos are not data-room
// files: the room's lists and counts leave them out, and they are served only through /api/photos.

export const PHOTO_LIMIT = 12;
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
const PHOTO_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);
export const PHOTO_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

// lib/uploads.ts checks JPEG and PNG by their first bytes. A WebP file is a RIFF container marked WEBP.
const WEBP = (bytes: Buffer) => bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";

export function isPhoto(document: { type: string }) {
  return document.type === "PHOTO";
}

// Why a file can't be a listing photo, or null when it can.
export function photoProblem(name: string, bytes: Buffer) {
  const ext = extensionOf(name);
  if (!ext || !PHOTO_EXTENSIONS.has(ext)) return "Photos are JPEG, PNG or WebP.";
  const problem = uploadProblem(name, bytes.length, bytes, PHOTO_MAX_BYTES);
  if (problem) return problem === "That file is over the size limit." ? "That photo is over 8 MB." : problem;
  if (ext === "webp" && !WEBP(bytes)) return "The file contents do not match its type.";
  return null;
}

// The seller, the broker who filed the listing, and the desk add and remove its photos.
export function canManagePhotos(actor: { id: string; role: string }, listing: { sellerId: string; brokerId: string | null }) {
  return actor.role === "ADMIN" || actor.id === listing.sellerId || (listing.brokerId != null && actor.id === listing.brokerId);
}

export type PhotoViewer = {
  admin: boolean;
  owner: boolean;
  signedNda: boolean;
  deal: { whole: boolean; loans: Set<string> };
};

// The listing page's street rule for one loan: the desk and the listing's own side always, and a buyer by loanOpenTo,
// so one loan sold out of a pool closes to everyone but its buyer. A photo whose loan has gone opens to no buyer.
export function photoOpen(viewer: PhotoViewer, listing: { id: string; status: string }, note: { id: string; listingId: string; tradeStatus: string } | null) {
  if (viewer.admin || viewer.owner) return true;
  if (!note || note.listingId !== listing.id) return false;
  return loanOpenTo({
    tradeStatus: note.tradeStatus,
    listingStatus: listing.status,
    signedNda: viewer.signedNda,
    wholeParty: viewer.deal.whole,
    loanParty: viewer.deal.loans.has(note.id),
  });
}

type ViewerUser = Viewer & { id: string };

// Who is looking, in the terms photoOpen reads. A buyer's NDA and closings are looked up; the listing's side isn't.
export async function photoViewer(user: ViewerUser, listing: { id: string; sellerId: string; brokerId: string | null }): Promise<PhotoViewer> {
  const admin = user.role === "ADMIN";
  const owner = user.id === listing.sellerId || (listing.brokerId != null && user.id === listing.brokerId);
  if (admin || owner) return { admin, owner, signedNda: false, deal: { whole: false, loans: new Set() } };
  const [nda, deal] = await Promise.all([
    prisma.ndaAcknowledgment.findUnique({ where: { userId_listingId: { userId: user.id, listingId: listing.id } } }),
    dealAccess(listing.id, user.id),
  ]);
  // The listing page's own test of an NDA: one still waiting on the seller's approval, or declined, opens nothing.
  return { admin, owner, signedNda: ndaOpensRoom(nda), deal };
}

// The photo a viewer asked for, or why not. A buyer passes the listing page's own check first, so a listing held
// for early access or beyond the free slice shows no photos either.
export async function photoForViewer(user: ViewerUser, photoId: string) {
  const photo = await prisma.document.findUnique({
    where: { id: photoId },
    include: { listing: { select: { id: true, status: true, approvedAt: true, sellerId: true, brokerId: true, launchAt: true, visibility: true } } },
  });
  if (!photo || !isPhoto(photo)) return { photo: null, status: 404 } as const;
  const { listing } = photo;
  const viewer = await photoViewer(user, listing);
  if (!viewer.admin && !viewer.owner) {
    // A listing hidden from this buyer has no photos for them either (lib/private-listings.ts).
    const sight = await listingSight(user, listing);
    if (!sight.visible) return { photo: null, status: 404 } as const;
    const [settings, live] = await Promise.all([
      getSettings(),
      prisma.listing.findMany({ where: { status: { in: ["APPROVED", "PENDING"] } }, select: { id: true, status: true, approvedAt: true, visibility: true } }),
    ]);
    const access = canOpenListing({
      invited: sight.invited,
      viewer: user,
      status: listing.status,
      approvedAt: listing.approvedAt,
      earlyAccessHours: settings.earlyAccessHours,
      openableIds: openableListingIds(live, settings.earlyAccessHours, settings.freeBrowseLimit),
      listingId: listing.id,
      sellerId: listing.sellerId,
      brokerId: listing.brokerId,
      launchAt: listing.launchAt,
    });
    if (!access.ok) return { photo: null, status: 403 } as const;
  }
  const note = photo.noteId ? await prisma.note.findUnique({ where: { id: photo.noteId }, select: { id: true, listingId: true, tradeStatus: true } }) : null;
  if (!photoOpen(viewer, listing, note)) return { photo: null, status: 403 } as const;
  return { photo, status: 200 } as const;
}

// The photos of a listing that this viewer may see, oldest first, and how many stay closed to them.
export async function visiblePhotos(viewer: PhotoViewer, listing: { id: string; status: string; notes: { id: string; listingId: string; tradeStatus: string }[] }) {
  const photos = await prisma.document.findMany({ where: { listingId: listing.id, type: "PHOTO" }, orderBy: { createdAt: "asc" } });
  const notes = new Map(listing.notes.map((note) => [note.id, note]));
  const shown = photos.filter((photo) => photoOpen(viewer, listing, photo.noteId ? notes.get(photo.noteId) ?? null : null));
  return { shown, closed: photos.length - shown.length };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

// Statuses the listing's side can still add photos in. The desk can add them at any point.
const ADDABLE = new Set(["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED", "PENDING"]);

export function photosAddable(actor: { role: string }, status: string) {
  return actor.role === "ADMIN" || ADDABLE.has(status);
}

export async function addPhotos(
  actor: { id: string; role: string },
  input: { listingId: string; noteId?: string | null; files: { name: string; bytes: Buffer }[] },
): Promise<Outcome<{ added: number; skipped: string[] }>> {
  const listing = await prisma.listing.findUnique({ where: { id: input.listingId }, select: { id: true, status: true, sellerId: true, brokerId: true, notes: { select: { id: true } } } });
  if (!listing || !canManagePhotos(actor, listing)) return { ok: false, error: "That listing isn't yours." };
  if (!photosAddable(actor, listing.status)) return { ok: false, error: "Photos can be added while the listing is in review, on the book or in contract." };
  // A single note's photos are of its one property. A pool's photos name the loan they show.
  const noteId = listing.notes.length === 1 ? listing.notes[0].id : input.noteId;
  if (!noteId || !listing.notes.some((note) => note.id === noteId)) return { ok: false, error: "Pick the loan these photos show." };
  if (!input.files.length) return { ok: false, error: "Choose a photo." };
  const room = PHOTO_LIMIT - (await prisma.document.count({ where: { listingId: listing.id, type: "PHOTO" } }));
  if (room <= 0) return { ok: false, error: `A listing holds up to ${PHOTO_LIMIT} photos. Remove one to add another.` };
  const skipped: string[] = [];
  let added = 0;
  for (const file of input.files) {
    const problem = photoProblem(file.name, file.bytes);
    if (problem || added >= room) {
      skipped.push(file.name.slice(0, 60));
      continue;
    }
    const ext = extensionOf(file.name)!;
    const mime = mimeFor(ext, "image/jpeg");
    const storedName = `${crypto.randomUUID()}-${safeBasename(file.name)}`;
    await putBytes(storedName, file.bytes, mime);
    await prisma.document.create({
      data: { listingId: listing.id, noteId, type: "PHOTO", originalName: file.name.slice(0, 180), storedName, mime, size: file.bytes.length },
    });
    added += 1;
  }
  if (added) await audit(actor.id, "PHOTO_ADDED", "listing", listing.id, `${added} photo${added === 1 ? "" : "s"}`);
  return { ok: true, value: { added, skipped } };
}

export async function removePhoto(actor: { id: string; role: string }, photoId: string): Promise<Outcome<{ listingId: string }>> {
  const photo = await prisma.document.findUnique({ where: { id: photoId }, include: { listing: { select: { id: true, sellerId: true, brokerId: true } } } });
  if (!photo || !isPhoto(photo)) return { ok: false, error: "That photo is already gone." };
  if (!canManagePhotos(actor, photo.listing)) return { ok: false, error: "That listing isn't yours." };
  // The stored file stays: a relisted copy of this listing may still show it.
  await prisma.document.deleteMany({ where: { id: photo.id, type: "PHOTO" } });
  await audit(actor.id, "PHOTO_REMOVED", "listing", photo.listing.id, photo.originalName);
  return { ok: true, value: { listingId: photo.listing.id } };
}
