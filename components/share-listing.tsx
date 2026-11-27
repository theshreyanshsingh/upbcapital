"use client";

import { useRef, useState } from "react";
import type { SharePanel } from "@/lib/share-cards";

const button = "inline-flex min-h-11 items-center justify-center rounded-lg border px-4 text-[13px] font-medium text-foreground";

// "Share this listing" on the seller's and the broker's listing pages, while a listing is live (lib/share-cards.ts
// builds the link, the share links and the count). The link opens the public teaser, whose preview card shows the
// same facts the teaser does. A private listing has no public link, and says so.
export function ShareListing({ panel }: { panel: SharePanel }) {
  const [copied, setCopied] = useState<"" | "done" | "error">("");
  const field = useRef<HTMLInputElement>(null);

  if (panel.state === "private") {
    return (
      <section id="share" aria-labelledby="share-heading" className="mt-10 scroll-mt-6 border border-border p-5 rounded-xl">
        <p id="share-heading" className="eyebrow">Share this listing</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Private listings have no public link, so there is nothing to share. <a href="#audience" className="text-link">Invite buyers instead</a>.
        </p>
      </section>
    );
  }

  async function copy() {
    if (panel.state !== "public") return;
    try {
      await navigator.clipboard.writeText(panel.url);
      setCopied("done");
      window.setTimeout(() => setCopied(""), 1800);
    } catch {
      setCopied("error");
      field.current?.select();
    }
  }

  return (
    <section id="share" aria-labelledby="share-heading" className="mt-10 scroll-mt-6 border border-border p-5 rounded-xl">
      <p id="share-heading" className="eyebrow">Share this listing</p>
      <p className="mt-2 text-sm text-foreground">Anyone with this link sees the public teaser: the city, the lien, the payment status and the UPB band.</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        The street, the borrower, the price and the seller stay on the desk. Posts on LinkedIn and X show a preview card with the same facts.
      </p>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Public link</span>
          <input ref={field} readOnly value={panel.url} onFocus={(event) => event.currentTarget.select()} className="desk-input min-w-0" />
        </label>
        <button type="button" onClick={copy} className={`${button} shrink-0 border-link/50`}>
          {copied === "done" ? "Copied" : "Copy link"}
        </button>
      </div>
      <p role="status" className={copied === "error" ? "mt-2 text-sm text-bad" : "sr-only"}>
        {copied === "error" ? "Copy is blocked in this browser. Select the link above instead." : copied === "done" ? "Link copied." : ""}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <a href={panel.linkedin} target="_blank" rel="noopener noreferrer" className={`${button} border-border`}>Share on LinkedIn</a>
        <a href={panel.x} target="_blank" rel="noopener noreferrer" className={`${button} border-border`}>Post on X</a>
        <a href={panel.email} target="_blank" rel="noopener noreferrer" className={`${button} border-border`}>Email the link</a>
      </div>
      <p className="mt-4 text-sm text-foreground tabular-nums">
        {panel.visits} {panel.visits === 1 ? "visit" : "visits"} from shared links
      </p>
      <p className="mt-1 text-xs text-muted-foreground">Previews that social sites fetch, and opens by the listing&apos;s own side and the desk, aren&apos;t counted.</p>
    </section>
  );
}
