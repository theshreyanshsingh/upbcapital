"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { COMPARE_LIMIT as COMPARE_MAX } from "@/lib/metrics";

const FORM_ID = "compare-picks";

// A card's or a row's box. It belongs to the compare form by id, so it can sit anywhere on the page.
export function CompareToggle({ listingId, title }: { listingId: string; title: string }) {
  return (
    <label className="inline-flex min-h-6 items-center gap-2 text-[13px] font-medium text-muted-foreground pointer-coarse:min-h-10">
      <input type="checkbox" name="ids" value={listingId} form={FORM_ID} className="size-4 accent-link" />
      Compare<span className="sr-only"> {title}</span>
    </label>
  );
}

// The compare form. It floats at the bottom of the results once something is picked, and works as a plain form
// without script, where the compare page keeps the first four.
export function CompareBar() {
  const [picked, setPicked] = useState(0);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const sync = () => {
      const boxes = [...document.querySelectorAll<HTMLInputElement>(`input[form="${FORM_ID}"][name="ids"]`)];
      const count = boxes.filter((box) => box.checked).length;
      setPicked(count);
      boxes.forEach((box) => {
        box.disabled = !box.checked && count >= COMPARE_MAX;
      });
    };
    sync();
    setReady(true);
    document.addEventListener("change", sync);
    return () => document.removeEventListener("change", sync);
  }, []);
  return (
    <div className={picked ? "sticky bottom-[calc(var(--dock,0px)+0.75rem)] z-20 mt-6 lg:bottom-4" : "mt-6"}>
      <form id={FORM_ID} action="/marketplace/compare" method="get" className={`glass flex flex-wrap items-center justify-between gap-3 px-4 py-3 ${picked ? "shadow-lg" : ""}`}>
        <p className="text-[13px] text-muted-foreground tabular-nums" aria-live="polite">
          {picked ? `${picked} of ${COMPARE_MAX} picked to compare.` : `Tick Compare on up to ${COMPARE_MAX} listings to see them side by side.`}
        </p>
        <Button type="submit" variant="outline" disabled={ready && picked < 2} className="h-9 text-[13px] font-medium">
          Compare side by side
        </Button>
      </form>
    </div>
  );
}
