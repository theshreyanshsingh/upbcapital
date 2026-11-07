"use client";

import { Button } from "@/components/ui/button";

// Puts the reader's draft into the answer box, where the seller edits it before publishing. Nothing is sent.
export function DraftInsert({ target, text }: { target: string; text: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      className="h-8 px-3 text-[13px] font-medium"
      onClick={() => {
        const box = document.getElementById(target);
        if (box instanceof HTMLTextAreaElement) {
          box.value = text;
          box.focus();
        }
      }}
    >
      Use this draft
    </Button>
  );
}
