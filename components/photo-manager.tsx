import { deletePhoto, uploadPhotos } from "@/actions/photos";
import { PhotoGallery } from "@/components/photo-gallery";
import { SubmitButton } from "@/components/submit-button";
import { ndaOpensRoom } from "@/lib/acl";
import { PHOTO_LIMIT, photosAddable, visiblePhotos } from "@/lib/photos";
import { prisma } from "@/lib/prisma";

type GalleryListing = {
  id: string;
  kind: string;
  status: string;
  sellerId: string;
  brokerId: string | null;
  notes: { id: string; listingId: string; tradeStatus: string; city: string; state: string }[];
  // The viewer's own NDA on the listing, as the listing page loads it.
  ndas: { accessStatus?: string | null }[];
};

// The listing page's photos, under the same rule as the street address: only the loans this viewer can see.
export async function ListingPhotos({ listing, viewer, deal }: { listing: GalleryListing; viewer: { id: string; role: string }; deal: { whole: boolean; loans: Set<string> } }) {
  const { shown, closed } = await visiblePhotos(
    {
      admin: viewer.role === "ADMIN",
      owner: viewer.id === listing.sellerId || (listing.brokerId != null && viewer.id === listing.brokerId),
      signedNda: ndaOpensRoom(listing.ndas[0]),
      deal,
    },
    listing,
  );
  const place = new Map(listing.notes.map((note) => [note.id, `${note.city}, ${note.state}`]));
  const pool = listing.kind === "POOL";
  return (
    <PhotoGallery
      closed={closed}
      photos={shown.map((photo, index) => ({
        id: photo.id,
        src: `/api/photos/${photo.id}`,
        alt: `Property photo ${index + 1}${pool && photo.noteId ? `, the loan in ${place.get(photo.noteId) ?? "this pool"}` : ""}`,
      }))}
    />
  );
}

// Where the seller, the filing broker or the desk adds and removes a listing's photos.
export async function PhotoManager({ listing, desk = false }: { listing: { id: string; status: string; notes: { id: string; streetAddress: string; city: string; state: string }[] }; desk?: boolean }) {
  const photos = await prisma.document.findMany({ where: { listingId: listing.id, type: "PHOTO" }, orderBy: { createdAt: "asc" } });
  const label = new Map(listing.notes.map((note) => [note.id, `${note.streetAddress || "No street"}, ${note.city}, ${note.state}`]));
  const pool = listing.notes.length > 1;
  const full = photos.length >= PHOTO_LIMIT;
  const addable = photosAddable({ role: desk ? "ADMIN" : "" }, listing.status);
  if (!addable && !photos.length) return null;
  return (
    <section id="photos" aria-labelledby="photos-manage-heading" className="mt-8 scroll-mt-6 border border-border p-5 rounded-xl">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="photos-manage-heading" className="eyebrow">Property photos</h2>
        <span className="text-xs text-muted-foreground tabular-nums">{photos.length} of {PHOTO_LIMIT}</span>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Buyers see photos only once they can see the street address, after they sign the confidentiality agreement. Leave out the borrower and anything else personal.
        {desk ? " The desk can add or remove photos at any stage." : ""}
      </p>
      {photos.length > 0 && (
        <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {photos.map((photo) => (
            <li key={photo.id} className="min-w-0">
              <div className="aspect-[4/3] overflow-hidden rounded-lg bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/photos/${photo.id}`} alt={`Photo ${photo.originalName}`} loading="lazy" decoding="async" className="size-full object-cover" />
              </div>
              {pool && photo.noteId && <p className="mt-1 truncate text-xs text-muted-foreground">{label.get(photo.noteId) ?? "Loan not on file"}</p>}
              <form action={deletePhoto} className="mt-1">
                <input type="hidden" name="photoId" value={photo.id} />
                <input type="hidden" name="listingId" value={listing.id} />
                <SubmitButton variant="ghost" pendingLabel="Removing…" className="h-9 px-0 text-[13px] font-medium text-link">Remove</SubmitButton>
              </form>
            </li>
          ))}
        </ul>
      )}
      {!addable ? null : full ? (
        <p className="mt-4 text-sm text-muted-foreground">This listing has the most photos it can hold. Remove one to add another.</p>
      ) : (
        <form action={uploadPhotos} className="mt-4 space-y-3">
          <input type="hidden" name="listingId" value={listing.id} />
          {pool && (
            <label className="block">
              <span className="text-[13px] text-muted-foreground">The loan these photos show</span>
              <select name="noteId" required defaultValue="" className="desk-input mt-2">
                <option value="" disabled>Pick a loan</option>
                {listing.notes.map((note) => <option key={note.id} value={note.id}>{label.get(note.id)}</option>)}
              </select>
            </label>
          )}
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Photos</span>
            <input type="file" name="photos" accept="image/jpeg,image/png,image/webp" multiple required className="desk-input mt-2 h-auto py-2" />
          </label>
          <p className="text-xs text-muted-foreground">JPEG, PNG or WebP, up to 8 MB each. Add a few at a time.</p>
          <SubmitButton variant="outline" pendingLabel="Adding…" className="h-10 text-[13px] font-medium">Add photos</SubmitButton>
        </form>
      )}
    </section>
  );
}
