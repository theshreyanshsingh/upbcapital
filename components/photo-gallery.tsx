"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ChevronLeft, ChevronRight, XIcon } from "lucide-react";

export type GalleryPhoto = { id: string; src: string; alt: string };

// The listing's photos as a strip that scrolls sideways under a thumb, each loading only as it comes near. A tap
// opens the full-screen view, which swipes the same way and takes the arrow keys on a keyboard.
export function PhotoGallery({ photos, closed = 0 }: { photos: GalleryPhoto[]; closed?: number }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!photos.length && !closed) return null;
  return (
    <section aria-labelledby="photos-heading" className="mt-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="photos-heading" className="eyebrow">Photos{photos.length ? ` · ${photos.length}` : ""}</h2>
        {closed > 0 && (
          <p className="text-xs text-muted-foreground">
            {photos.length ? `${closed} more open` : `${closed === 1 ? "A photo opens" : `${closed} photos open`}`} with the street address.
          </p>
        )}
      </div>
      {photos.length > 0 && (
        <ul className="no-scrollbar mt-3 flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain max-md:bleed-x max-md:scroll-pl-[var(--gutter-l,1rem)]">
          {photos.map((photo, index) => (
            <li key={photo.id} className="shrink-0 basis-[82%] snap-start sm:basis-[46%] lg:basis-[32%]">
              <button
                type="button"
                onClick={() => setOpen(index)}
                className="block aspect-[4/3] w-full overflow-hidden rounded-xl bg-muted outline-offset-2 transition-[scale] duration-(--dur-1) active:scale-[0.99]"
              >
                {/* Served by an authenticated route, so it can't go through the image optimizer. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photo.src} alt={photo.alt} loading={index === 0 ? "eager" : "lazy"} decoding="async" className="size-full object-cover" />
                <span className="sr-only">Open photo {index + 1} of {photos.length} full screen</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open != null && <FullScreen key={open} photos={photos} start={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function FullScreen({ photos, start, onClose }: { photos: GalleryPhoto[]; start: number; onClose: () => void }) {
  const track = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(start);
  const go = (next: number) => {
    const target = Math.max(0, Math.min(photos.length - 1, next));
    setShown(target);
    track.current?.scrollTo({ left: target * track.current.clientWidth, behavior: "smooth" });
  };
  // Opening on a photo lands on it at once, without sliding past the ones before it.
  const place = useCallback((el: HTMLDivElement | null) => {
    track.current = el;
    if (el) el.scrollLeft = start * el.clientWidth;
  }, [start]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (track.current) track.current.scrollLeft = start * track.current.clientWidth;
    });
    return () => cancelAnimationFrame(frame);
  }, [start]);
  return (
    <DialogPrimitive.Root open onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/95" />
        <DialogPrimitive.Popup
          className="fixed inset-0 z-50 flex flex-col text-white outline-none"
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") go(shown + 1);
            if (event.key === "ArrowLeft") go(shown - 1);
          }}
        >
          <div className="flex items-center justify-between gap-3 px-4 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-2">
            <DialogPrimitive.Title className="text-sm font-medium tabular-nums">
              Photo {shown + 1} of {photos.length}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close className="inline-flex size-11 items-center justify-center rounded-full bg-white/10 hover:bg-white/20" aria-label="Close photos">
              <XIcon className="size-5" aria-hidden />
            </DialogPrimitive.Close>
          </div>
          <div
            ref={place}
            onScroll={(event) => {
              const el = event.currentTarget;
              if (el.clientWidth) setShown(Math.round(el.scrollLeft / el.clientWidth));
            }}
            className="no-scrollbar flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overscroll-contain"
          >
            {photos.map((photo) => (
              <div key={photo.id} className="flex w-full shrink-0 snap-center items-center justify-center px-2 pb-[env(safe-area-inset-bottom)]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photo.src} alt={photo.alt} loading="lazy" decoding="async" className="max-h-full max-w-full object-contain" />
              </div>
            ))}
          </div>
          {photos.length > 1 && (
            <div className="flex items-center justify-center gap-4 px-4 pt-2 pb-[calc(1rem+env(safe-area-inset-bottom))]">
              <button type="button" onClick={() => go(shown - 1)} disabled={shown === 0} className="inline-flex size-11 items-center justify-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-40" aria-label="Previous photo">
                <ChevronLeft className="size-5" aria-hidden />
              </button>
              <button type="button" onClick={() => go(shown + 1)} disabled={shown === photos.length - 1} className="inline-flex size-11 items-center justify-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-40" aria-label="Next photo">
                <ChevronRight className="size-5" aria-hidden />
              </button>
            </div>
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
