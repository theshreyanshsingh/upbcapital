"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { isMacLike, SHORTCUTS_EVENT, ShortcutKeys } from "@/components/command-palette";
import type { ShortcutBinding } from "@/lib/command-search";

const SEQUENCE_MS = 1200;
const NOT_TEXT = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);

// A key typed into a field is text, never a shortcut.
function typing(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !NOT_TEXT.has((target as HTMLInputElement).type);
  return target.closest('[contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"], [role="searchbox"]') !== null;
}

// While any dialog is open its own keys win, and a page change behind it would lose what is in it.
function dialogOpen() {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}

function shown(element: HTMLElement) {
  return element.getClientRects().length > 0 && !(element as HTMLInputElement).disabled;
}

// The page's own search first, then any other search field that is on screen, such as the desk's sidebar search.
function searchField() {
  const fields = [
    ...document.querySelectorAll<HTMLInputElement>('[data-shortcut="search"]'),
    ...document.querySelectorAll<HTMLInputElement>('main input[type="search"]'),
    ...document.querySelectorAll<HTMLInputElement>('input[type="search"]'),
  ];
  return fields.find(shown) ?? null;
}

export function Shortcuts({ bindings }: { bindings: ShortcutBinding[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mod, setMod] = useState("Ctrl");
  const pending = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    setMod(isMacLike() ? "⌘" : "Ctrl");
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (typing(event.target) || typing(document.activeElement)) return;
      if (dialogOpen()) return;
      const key = typeof event.key === "string" ? event.key : "";
      const first = pending.current;
      pending.current = null;
      if (first && Date.now() - first.at < SEQUENCE_MS) {
        const binding = bindings.find((entry) => entry.keys[0] === first.key && entry.keys[1] === key.toLowerCase());
        if (binding) {
          event.preventDefault();
          router.push(binding.href);
          return;
        }
      }
      if (key === "?") {
        event.preventDefault();
        setOpen(true);
        return;
      }
      if (key === "/") {
        const field = searchField();
        if (field) {
          event.preventDefault();
          field.focus();
          field.select();
        }
        return;
      }
      if (key.toLowerCase() === "g" && !event.shiftKey && bindings.some((entry) => entry.keys[0] === "g")) {
        pending.current = { key: "g", at: Date.now() };
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(SHORTCUTS_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(SHORTCUTS_EVENT, onOpen);
    };
  }, [bindings, router]);

  const rows: { keys: string[]; label: string; chord?: boolean }[] = [
    { keys: [mod, "K"], label: "Open the command menu", chord: true },
    { keys: ["/"], label: "Go to the search on this page" },
    { keys: ["?"], label: "Show these shortcuts" },
    ...bindings.map((binding) => ({ keys: binding.keys, label: binding.label })),
  ];

  return (
    <Dialog open={open} onOpenChange={(next) => setOpen(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold tracking-tight">Keyboard shortcuts</DialogTitle>
          <DialogDescription>Shortcuts only open pages. They are off while you type in a field.</DialogDescription>
        </DialogHeader>
        <dl className="divide-y divide-border rounded-lg border border-border">
          {rows.map((row) => (
            <div key={row.keys.join("+")} className="flex items-center justify-between gap-4 px-3 py-2.5">
              <dt className="text-[13px] text-foreground">{row.label}</dt>
              <dd>
                <ShortcutKeys keys={row.keys} chord={row.chord} />
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
