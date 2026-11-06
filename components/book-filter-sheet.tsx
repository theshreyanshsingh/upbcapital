"use client";

import { useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { SheetHandle } from "@/components/ui/sheet-handle";

// On a phone the book's filters wait behind one bar that says what's applied, and open as a sheet from the
// bottom, so the first screen is paper rather than form fields. Wider screens show the form inline instead.
export function BookFilterSheet({ count, summary, children }: { count: number; summary: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  // Focus lands on the heading, not the place field, so opening the sheet doesn't throw up the keyboard.
  const heading = useRef<HTMLDivElement>(null);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger className="mt-5 flex h-13 w-full items-center gap-3 rounded-xl border border-input bg-field px-3.5 text-left shadow-card transition-[scale] duration-(--dur-1) active:scale-[0.99] md:hidden">
        <SlidersHorizontal className="size-[18px] shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] leading-5 font-medium text-foreground">Filter and sort</span>
          <span className="block truncate text-xs leading-4 text-muted-foreground">{summary}</span>
        </span>
        {count > 0 && (
          <span className="figure min-w-6 rounded-full bg-link px-2 text-center text-xs leading-6 font-semibold text-background">
            {count}
            <span className="sr-only"> filters on</span>
          </span>
        )}
      </SheetTrigger>
      <SheetContent side="bottom" initialFocus={heading} className="max-h-[92dvh] gap-0 rounded-t-[22px] p-0 sm:mx-auto sm:max-w-lg sm:border-x">
        <SheetHandle>
          <div ref={heading} tabIndex={-1} className="px-5 pt-3 pb-1 outline-none">
            <SheetTitle>Filter the book</SheetTitle>
            <SheetDescription className="text-[13px]">Every filter a card or a row shows. Apply to see the matches.</SheetDescription>
          </div>
        </SheetHandle>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
