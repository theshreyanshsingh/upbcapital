"use client";

import { useRef } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "cn";

// A bottom sheet's grab bar. Drag it, or the header it wraps, down and the sheet follows the finger; let go past
// a short distance, or flick, and it closes. A smaller pull springs back. It closes through the dialog's own Close
// control, so focus returns and the exit animation runs exactly as for a tap on ×.
export function SheetHandle({ className, children }: { className?: string; children?: React.ReactNode }) {
  const close = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ y: number; at: number; popup: HTMLElement; id: number } | null>(null);

  function down(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // A press on a control in the header is a tap on that control, not a drag.
    if ((event.target as HTMLElement).closest("button, a, input, select, textarea, label")) return;
    const popup = event.currentTarget.closest<HTMLElement>('[data-slot="sheet-content"], [data-slot="dialog-content"]');
    if (!popup) return;
    drag.current = { y: event.clientY, at: performance.now(), popup, id: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
    popup.style.transition = "none";
  }

  function move(event: React.PointerEvent<HTMLDivElement>) {
    const held = drag.current;
    if (!held || held.id !== event.pointerId) return;
    // Down follows the finger; up resists, so the sheet never lifts off the bottom edge.
    const dy = event.clientY - held.y;
    held.popup.style.transform = `translateY(${dy > 0 ? dy : dy / 6}px)`;
  }

  function up(event: React.PointerEvent<HTMLDivElement>) {
    const held = drag.current;
    if (!held || held.id !== event.pointerId) return;
    drag.current = null;
    const dy = Math.max(0, event.clientY - held.y);
    const speed = dy / Math.max(1, performance.now() - held.at);
    held.popup.style.transition = "";
    if (dy > 96 || (dy > 24 && speed > 0.6)) {
      // A dialog leaves by keyframes that end 2rem below where it opened; aim them past where the finger let go, so
      // it carries on down instead of jumping back up. A sheet leaves by transition and is unaffected.
      held.popup.style.setProperty("--tw-exit-translate-y", `${dy + 32}px`);
      close.current?.click();
      return;
    }
    held.popup.style.transform = "";
  }

  return (
    <div onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} className={cn("shrink-0 touch-none select-none", className)}>
      <div aria-hidden className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-border" />
      {children}
      <DialogPrimitive.Close ref={close} tabIndex={-1} aria-hidden className="hidden" />
    </div>
  );
}
