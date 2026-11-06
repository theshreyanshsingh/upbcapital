"use client";

import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { PAGE_COLORS } from "@/lib/theme-colors";
import { cn } from "@/lib/utils";

// The theme follows the system until someone picks Light or Dark here; the pick is remembered under
// upb-theme. The inline script in app/layout.tsx applies the same rule before first paint.
export type ThemeChoice = "system" | "light" | "dark";

const KEY = "upb-theme";
const CHANGE = "upb-theme-change";

function readChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) onChange();
  };
  window.addEventListener(CHANGE, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, readChoice, () => "system");
}

export function chooseTheme(choice: ThemeChoice) {
  try {
    if (choice === "system") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, choice);
  } catch {
    // Private windows can refuse storage; the choice still applies to this page.
  }
  const dark = choice === "dark" || (choice === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  syncThemeColor(dark);
  window.dispatchEvent(new Event(CHANGE));
}

// Points the status bar at the theme now on screen, through the theme script's own tag (app/layout.tsx).
function syncThemeColor(dark: boolean) {
  let tag = document.getElementById("theme-color");
  if (!tag) {
    tag = Object.assign(document.createElement("meta"), { name: "theme-color", id: "theme-color" });
    document.head.appendChild(tag);
  }
  tag.setAttribute("content", dark ? PAGE_COLORS.dark : PAGE_COLORS.light);
}

const OPTIONS: { value: ThemeChoice; label: string; icon: LucideIcon }[] = [
  { value: "system", label: "Match system", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

export function ThemeToggle({ className }: { className?: string }) {
  const choice = useThemeChoice();
  return (
    <div role="group" aria-label="Appearance" className={cn("flex items-center justify-between gap-3 rounded-lg px-2 py-1.5", className)}>
      <span className="text-sm text-foreground">Appearance</span>
      <span className="inline-flex rounded-lg bg-muted p-0.5">
        {OPTIONS.map(({ value, label, icon: Icon }) => {
          const on = choice === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => chooseTheme(value)}
              aria-pressed={on}
              aria-label={label}
              title={label}
              className={cn(
                "grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground pointer-coarse:size-9",
                on && "bg-card text-foreground shadow-card",
              )}
            >
              <Icon className="size-3.5" aria-hidden />
            </button>
          );
        })}
      </span>
    </div>
  );
}
