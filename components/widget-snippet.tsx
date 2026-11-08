"use client";

import { useState } from "react";

// The iframe a broker pastes into their own site, with a copy button.
export function WidgetSnippet({ snippet }: { snippet: string }) {
  const [copied, setCopied] = useState("");

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied("done");
      window.setTimeout(() => setCopied(""), 1800);
    } catch {
      setCopied("error");
    }
  }

  return (
    <div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-xl border border-border bg-muted/40 p-4 font-mono text-xs leading-relaxed text-foreground">{snippet}</pre>
      <button type="button" onClick={copy} className="mt-3 min-h-11 rounded-lg border border-link/50 px-4 text-[13px] font-medium text-foreground">
        {copied === "done" ? "Snippet copied" : "Copy the snippet"}
      </button>
      {copied === "error" && <p className="mt-2 text-sm text-bad">Copy is blocked in this browser. Select the snippet instead.</p>}
    </div>
  );
}
