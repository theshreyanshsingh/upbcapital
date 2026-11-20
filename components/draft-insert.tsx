"use client";

import { Button } from "@/components/ui/button";

// Puts the reader's draft into the answer box, where the seller edits it before publishing. Nothing is sent.
// `fields` fills other form controls by id as well, such as the answer's source from the draft's own.
export function DraftInsert({ target, text, fields }: { target: string; text: string; fields?: Record<string, string> }) {
  return (
    <Button
      type="button"
      variant="outline"
      className="h-10 px-3 text-[13px] font-medium"
      onClick={() => {
        for (const [id, value] of Object.entries(fields ?? {})) {
          const field = document.getElementById(id);
          if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) field.value = value;
        }
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
