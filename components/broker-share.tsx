"use client";

import { useState } from "react";

export function ReferralKit({
  url,
  code,
  svg,
}: {
  url: string;
  code: string;
  svg: string;
}) {
  const [copied, setCopied] = useState("");

  async function copy(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(""), 1800);
    } catch {
      setCopied("error");
    }
  }

  async function share() {
    if (navigator.share) {
      try {
        await navigator.share({ title: "UPB Capital", text: "A seat on the UPB Capital desk, with this introduction attached.", url });
        return;
      } catch {
        return;
      }
    }
    await copy(url, "link");
  }

  return (
    <div className="grid gap-6 md:grid-cols-[180px_minmax(0,1fr)] md:items-center">
      <div className="mx-auto w-40 rounded-xl border border-border bg-white p-3 md:mx-0 [&_svg]:h-auto [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
      <div>
        <p className="font-semibold tracking-tight text-3xl text-foreground">{code}</p>
        <p className="mt-2 break-all text-sm text-muted-foreground">{url}</p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <button type="button" onClick={() => copy(url, "link")} className="min-h-12 flex-1 border border-link/50 px-4 text-[13px] font-medium text-foreground rounded-lg">
            {copied === "link" ? "Link copied" : "Copy link"}
          </button>
          <button type="button" onClick={() => copy(code, "code")} className="min-h-12 flex-1 border border-border px-4 text-[13px] font-medium text-foreground rounded-lg">
            {copied === "code" ? "Code copied" : "Copy code"}
          </button>
          <button type="button" onClick={share} className="min-h-12 flex-1 bg-primary px-4 text-[13px] font-medium text-primary-foreground rounded-lg">
            Share
          </button>
        </div>
        {copied === "error" && <p className="mt-2 text-sm text-bad">Copy is blocked in this browser. Select the link instead.</p>}
      </div>
    </div>
  );
}
