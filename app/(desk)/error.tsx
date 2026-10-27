"use client";

import { Button } from "@/components/ui/button";

export default function DeskError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="max-w-lg">
      <p className="eyebrow">The desk</p>
      <h1 className="mt-3 font-semibold tracking-tight text-[28px] text-foreground">Something slipped.</h1>
      <p className="mt-4 text-sm text-muted-foreground">The page did not finish. Try it again.</p>
      <Button className="mt-6 h-11 px-5 text-[13px] font-medium" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
