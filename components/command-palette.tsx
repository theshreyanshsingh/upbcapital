"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  BookOpen,
  Bookmark,
  FileText,
  FolderOpen,
  Handshake,
  History,
  Keyboard,
  Megaphone,
  Search,
  Users,
  Wallet,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { CommandGroup, CommandItem } from "@/lib/command-search";
import { cn } from "@/lib/utils";

// Other parts of the app open the palette or the shortcuts sheet with these events, so a hint button in the shell
// needs only openCommandPalette().
export const PALETTE_EVENT = "upb:command-palette";
export const SHORTCUTS_EVENT = "upb:shortcuts";

export function openCommandPalette() {
  window.dispatchEvent(new Event(PALETTE_EVENT));
}

export function isMacLike() {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

const ICONS: Record<CommandGroup, LucideIcon> = {
  Recent: History,
  Actions: Zap,
  Pages: ArrowRight,
  Listings: BookOpen,
  "Your listings": BookOpen,
  Bids: Handshake,
  Closings: FolderOpen,
  Holdings: Wallet,
  "Saved views": Bookmark,
  Accounts: Users,
  Borrowers: FileText,
  Leads: Megaphone,
};

const RECENT_MAX = 6;
const DEBOUNCE_MS = 180;

function isItem(value: unknown): value is CommandItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CommandItem>;
  if (typeof item.id !== "string" || typeof item.label !== "string" || typeof item.href !== "string" || typeof item.group !== "string") return false;
  if (item.private) return false;
  return item.action === "shortcuts" || (item.href.startsWith("/") && !item.href.startsWith("//"));
}

// Recent items live in this browser only, one list per account, and never include a result that names a person.
function readRecent(key: string): CommandItem[] {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isItem).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function writeRecent(key: string, items: CommandItem[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // Private windows and full storage just skip it.
  }
}

function subsequence(needle: string, haystack: string) {
  let at = 0;
  for (const char of haystack) {
    if (char === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return needle.length === 0;
}

// Label matches first, then keywords, then letters in order, so "clsg" still finds Closings.
function score(item: CommandItem, query: string) {
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  const label = item.label.toLowerCase();
  const hay = `${label} ${(item.keywords ?? "").toLowerCase()} ${(item.hint ?? "").toLowerCase()}`;
  if (label === q) return 100;
  if (label.startsWith(q)) return 80;
  if (label.split(/\s+/).some((word) => word.startsWith(q))) return 60;
  if (hay.includes(q)) return 40;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((word) => hay.includes(word))) return 30;
  if (q.length >= 3 && subsequence(q.replace(/\s+/g, ""), label)) return 10;
  return 0;
}

type Section = { key: string; title: string; items: CommandItem[] };

function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-border bg-card px-1 font-sans text-[11px] font-medium text-muted-foreground", className)}>
      {children}
    </kbd>
  );
}

const SPOKEN: Record<string, string> = { "⌘": "Command", "?": "question mark", "/": "slash" };

// "chord" keys are held together, like ⌘ K. Otherwise they are pressed in turn, like G then B.
export function ShortcutKeys({ keys, chord = false, className }: { keys: string[]; chord?: boolean; className?: string }) {
  const spoken = keys.map((key) => SPOKEN[key] ?? (key.length === 1 ? key.toUpperCase() : key)).join(chord ? " plus " : " then ");
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span className="inline-flex items-center gap-1" aria-hidden="true">
        {keys.map((key, index) => (
          <Kbd key={`${key}-${index}`}>{key.length === 1 ? key.toUpperCase() : key}</Kbd>
        ))}
      </span>
      <span className="sr-only">{spoken}</span>
    </span>
  );
}

export function CommandPalette({ userKey, commands, placeholder }: { userKey: string; commands: CommandItem[]; placeholder: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<{ term: string; items: CommandItem[] } | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [problem, setProblem] = useState("");
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<CommandItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const afterClose = useRef<(() => void) | null>(null);
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const listboxId = `${baseId}-listbox`;
  const storageKey = `upb:palette-recent:${userKey}`;
  const term = query.trim();

  // ⌘K on a Mac, Ctrl+K elsewhere. It works from inside a field too, since it types nothing, and it also closes.
  useEffect(() => {
    const mac = isMacLike();
    const onKey = (event: KeyboardEvent) => {
      if (typeof event.key !== "string" || event.key.toLowerCase() !== "k" || event.altKey || event.shiftKey || event.isComposing) return;
      const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!mod) return;
      event.preventDefault();
      setOpen((value) => !value);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(PALETTE_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setRemote(null);
    setStatus("idle");
    setActive(0);
    setRecent(readRecent(storageKey));
  }, [open, storageKey]);

  // Records are searched on the server after a short pause. A newer keystroke cancels the older request.
  useEffect(() => {
    if (!open || term.length < 2) {
      setStatus("idle");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setStatus("loading");
      try {
        const response = await fetch("/api/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q: term }),
          signal: controller.signal,
          credentials: "same-origin",
          cache: "no-store",
        });
        const data = (await response.json().catch(() => ({}))) as { items?: unknown; error?: unknown };
        if (!response.ok) {
          setRemote({ term, items: [] });
          setProblem(typeof data.error === "string" ? data.error : "Search is unavailable. Pages and actions still work.");
          setStatus("error");
          return;
        }
        setRemote({ term, items: Array.isArray(data.items) ? (data.items as CommandItem[]) : [] });
        setStatus("idle");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setProblem("Search is unavailable. Pages and actions still work.");
        setStatus("error");
      }
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, term]);

  useEffect(() => {
    setActive(0);
  }, [term]);

  const sections = useMemo<Section[]>(() => {
    if (!term) {
      const list: Section[] = [];
      if (recent.length) list.push({ key: "recent", title: "Recent", items: recent });
      list.push({ key: "actions", title: "Actions", items: commands.filter((item) => item.group === "Actions") });
      list.push({ key: "pages", title: "Pages", items: commands.filter((item) => item.group === "Pages") });
      return list.filter((section) => section.items.length);
    }
    const local = commands
      .map((item) => ({ item, rank: score(item, term) }))
      .filter((row) => row.rank > 0)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 8)
      .map((row) => row.item);
    const list: Section[] = local.length ? [{ key: "jump", title: "Pages and actions", items: local }] : [];
    // While a new search runs, the last results stay up so the list doesn't flicker.
    const found = remote ? remote.items : [];
    for (const item of found) {
      if (!isResult(item)) continue;
      const existing = list.find((section) => section.key === `group:${item.group}`);
      if (existing) existing.items.push(item);
      else list.push({ key: `group:${item.group}`, title: item.group, items: [item] });
    }
    return list;
  }, [term, recent, commands, remote]);

  const flat = useMemo(() => sections.flatMap((section) => section.items.map((item) => ({ item, section: section.key }))), [sections]);
  const current = flat.length ? Math.min(active, flat.length - 1) : -1;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  useEffect(() => {
    if (current < 0) return;
    document.getElementById(`${baseId}-option-${current}`)?.scrollIntoView({ block: "nearest" });
  }, [baseId, current]);

  const run = useCallback(
    (item: CommandItem, newTab = false) => {
      if (!item.private) {
        const keep: CommandItem = { id: item.id, group: item.group, label: item.label, hint: item.hint, href: item.href, action: item.action, shortcut: item.shortcut };
        const next = [keep, ...recent.filter((entry) => entry.id !== item.id)].slice(0, RECENT_MAX);
        setRecent(next);
        writeRecent(storageKey, next);
      }
      if (item.action === "shortcuts") {
        // The sheet opens once the palette has closed and handed focus back.
        afterClose.current = () => window.dispatchEvent(new Event(SHORTCUTS_EVENT));
        setOpen(false);
        return;
      }
      if (!item.href.startsWith("/") || item.href.startsWith("//")) return;
      setOpen(false);
      if (newTab) window.open(item.href, "_blank", "noopener,noreferrer");
      else router.push(item.href);
    },
    [recent, router, storageKey],
  );

  const move = (delta: number) => {
    if (!flat.length) return;
    setActive((value) => {
      const from = Math.min(value, flat.length - 1);
      if (Math.abs(delta) > 1) return Math.max(0, Math.min(flat.length - 1, from + delta));
      return (from + delta + flat.length) % flat.length;
    });
  };

  const onInputKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "PageDown") {
      event.preventDefault();
      move(5);
    } else if (event.key === "PageUp") {
      event.preventDefault();
      move(-5);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = flat[current];
      if (target) run(target.item, event.metaKey || event.ctrlKey);
    }
  };

  const searching = status === "loading";
  const empty = term.length > 0 && !flat.length && !searching;
  const announcement = !term
    ? ""
    : searching
      ? "Searching."
      : status === "error"
        ? problem
        : `${flat.length} result${flat.length === 1 ? "" : "s"}.`;

  let index = -1;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => setOpen(next)}
      onOpenChangeComplete={(next) => {
        if (next) return;
        const then = afterClose.current;
        afterClose.current = null;
        then?.();
      }}
    >
      <DialogContent
        showCloseButton={false}
        initialFocus={inputRef}
        phone="top"
        className="top-[10vh] translate-y-0 gap-0 overflow-hidden p-0 sm:top-[14vh] sm:max-w-xl"
      >
        <DialogTitle className="sr-only">Command menu</DialogTitle>
        <DialogDescription className="sr-only">
          Search pages, actions and records. Use the up and down arrows to move, Enter to open, and Escape to close.
        </DialogDescription>
        <div className="flex items-center gap-2 border-b border-border px-3.5">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <label htmlFor={inputId} className="sr-only">
            Search or jump to
          </label>
          <input
            id={inputId}
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls={listboxId}
            aria-activedescendant={current >= 0 ? optionId(current) : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="go"
            maxLength={80}
            placeholder={placeholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKey}
            className="h-12 min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-faint sm:text-[15px]"
          />
          {searching && <span className="shrink-0 text-xs text-muted-foreground">Searching…</span>}
        </div>
        <div
          id={listboxId}
          role="listbox"
          aria-label="Results"
          className={cn("max-h-[min(60vh,440px)] overflow-y-auto overscroll-contain p-1.5 max-sm:max-h-[min(52dvh,440px)]", !flat.length && "hidden")}
        >
          {sections.map((section) => {
            const headingId = `${baseId}-${section.key.replace(/[^a-z0-9]/gi, "-")}`;
            return (
              <div key={section.key} role="group" aria-labelledby={headingId} className="pb-1">
                <div id={headingId} className="px-2.5 pt-2 pb-1 text-xs text-faint">
                  {section.title}
                </div>
                {section.items.map((item) => {
                  index += 1;
                  const position = index;
                  const selected = position === current;
                  const Icon = section.key === "recent" ? ICONS.Recent : item.action === "shortcuts" ? Keyboard : ICONS[item.group] ?? ArrowRight;
                  return (
                    <div
                      key={`${section.key}-${item.id}`}
                      id={optionId(position)}
                      role="option"
                      aria-selected={selected}
                      onMouseMove={() => {
                        if (!selected) setActive(position);
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => run(item, event.metaKey || event.ctrlKey)}
                      className={cn(
                        "flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] pointer-coarse:min-h-12 pointer-coarse:text-[15px]",
                        selected ? "bg-active text-foreground" : "text-nav",
                      )}
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-foreground">{item.label}</span>
                        {item.hint && <span className="block truncate text-xs text-muted-foreground">{item.hint}</span>}
                      </span>
                      {item.shortcut && <ShortcutKeys keys={item.shortcut} className="hidden shrink-0 sm:inline-flex" />}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        {empty && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            {status === "error" ? problem : term.length < 2 ? "Keep typing to search records." : `Nothing matches “${term}”.`}
          </p>
        )}
        {status === "error" && !empty && <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">{problem}</p>}
        <p className="sr-only" aria-live="polite" role="status">
          {announcement}
        </p>
        <div className="flex items-center justify-end gap-3 border-t border-border bg-muted/40 px-3.5 py-2 text-xs text-muted-foreground sm:justify-between">
          <span className="hidden items-center gap-1.5 sm:inline-flex" aria-hidden="true">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> to move <Kbd className="ml-1.5">Enter</Kbd> to open <Kbd className="ml-1.5">Esc</Kbd> to close
          </span>
          <DialogClose className="rounded-md px-2 py-1 font-medium text-foreground hover:bg-hover">Close</DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Server results are data from the network, so each is checked before it is shown or stored.
function isResult(item: unknown): item is CommandItem {
  if (!item || typeof item !== "object") return false;
  const row = item as Partial<CommandItem>;
  return (
    typeof row.id === "string" &&
    typeof row.label === "string" &&
    typeof row.href === "string" &&
    typeof row.group === "string" &&
    row.href.startsWith("/") &&
    !row.href.startsWith("//")
  );
}
