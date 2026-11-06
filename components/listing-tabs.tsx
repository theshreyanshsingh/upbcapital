"use client";

import { useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type ListingTab = { value: string; label: string; count?: number };

// The listing's sections as tabs. The open tab lives in the address bar, so a link to a loan's file opens on the
// file and a reload keeps the place. Switching tabs replaces the entry rather than adding to history.
export function ListingTabs({ tabs, fallback, children }: { tabs: ListingTab[]; fallback: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const current = search.toString();
  const asked = search.get("tab");
  const fromUrl = tabs.some((tab) => tab.value === asked) ? (asked as string) : fallback;
  // A click holds until the address changes, so the tab switches at once and a later link still wins.
  const [picked, setPicked] = useState<{ value: string; at: string } | null>(null);
  const active = picked && picked.at === current ? picked.value : fromUrl;
  function choose(value: unknown) {
    const next = new URLSearchParams(current);
    next.set("tab", String(value));
    setPicked({ value: String(value), at: current });
    window.history.replaceState(null, "", `${pathname}?${next.toString()}`);
  }
  return (
    <Tabs value={active} onValueChange={choose} className="mt-8">
      {/* On a phone the tabs hold under the top bar while the section scrolls, and swipe sideways if they run long. */}
      <div className="sticky top-[calc(3.25rem+env(safe-area-inset-top))] z-20 -mx-4 overflow-x-auto border-b border-border bg-background/92 px-4 no-scrollbar backdrop-blur-xl md:static md:mx-0 md:bg-transparent md:px-0 md:backdrop-blur-none">
        <TabsList variant="line" aria-label="Listing sections" className="group-data-horizontal/tabs:h-11 md:group-data-horizontal/tabs:h-10">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} className="px-3.5 text-sm md:px-3 md:text-[13px]">
              {tab.label}
              {tab.count != null && <span className="text-xs text-muted-foreground tabular-nums">{tab.count}</span>}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {children}
    </Tabs>
  );
}
