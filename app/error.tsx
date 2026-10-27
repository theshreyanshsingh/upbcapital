"use client";

import { Button } from "@/components/ui/button";

export default function RootError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main id="desk" className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-5">
      <p className="eyebrow">The desk</p>
      <h1 className="mt-3 font-semibold tracking-tight text-5xl text-foreground">Something slipped.</h1>
      <p className="mt-4 text-sm text-muted-foreground">The page did not finish. Nothing was changed that we can confirm from here.</p>
      <Button className="mt-6 h-11 w-fit px-5 text-[13px] font-medium" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}
