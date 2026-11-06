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
      {/* Below 1024px the tabs hold under the top bar while the section scrolls, edge to edge, and swipe sideways
          if they run long. With the sidebar they sit in the page. The active tab's underline is drawn at the tab's own
          foot, inside the strip: the line variant's default hangs it below the tab, where a scrolling strip clips it. */}
      <div data-slot="listing-tabs" className="sticky top-[calc(3.25rem+1px+env(safe-area-inset-top))] z-20 bleed-x overflow-x-auto overflow-y-hidden border-b border-border bg-background/92 no-scrollbar backdrop-blur-xl lg:static lg:mx-0 lg:bg-transparent lg:px-0 lg:backdrop-blur-none">
        <TabsList variant="line" aria-label="Listing sections" className="pb-0 group-data-horizontal/tabs:h-11 md:group-data-horizontal/tabs:h-10">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} className="px-3.5 text-sm group-data-horizontal/tabs:after:bottom-0 md:px-3 md:text-[13px]">
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
