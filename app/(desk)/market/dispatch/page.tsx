import Link from "next/link";
import { PageIntro } from "@/components/page-intro";
import { requireUser } from "@/lib/auth";
import { DISPATCH_FOOTNOTE, dispatchIssues } from "@/lib/dispatch";
import { prettyDate } from "@/lib/format";

export const metadata = { title: "Dispatch archive" };

// Every signed-in member reads the back issues. Each is the email as it went out, which carries nothing a free
// member can't see; the full tables stay on the current issue for Pro and the desk.
export default async function DispatchArchivePage() {
  await requireUser();
  const issues = await dispatchIssues();
  return (
    <div className="max-w-3xl">
      <PageIntro eyebrow="Market dispatch" title="Back issues." lede="Each monthly dispatch as it was sent, newest first. Market data, not advice." />
      <p className="text-sm">
        <Link href="/market" className="font-medium text-link">Read this month&apos;s dispatch</Link>
      </p>
      <ul className="mt-6 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {issues.length === 0 && <li className="px-5 py-8 text-sm text-muted-foreground">No issue has gone out yet. The first one is filed here when it is sent.</li>}
        {issues.map((issue) => (
          <li key={issue.month}>
            <Link href={`/market/dispatch/${issue.month}`} className="flex items-baseline justify-between gap-4 px-4 py-3.5 transition-colors hover:bg-hover active:bg-hover sm:px-5">
              <span className="font-medium text-foreground">{issue.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">Sent {prettyDate(issue.sentAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-8 text-xs leading-relaxed text-muted-foreground">{DISPATCH_FOOTNOTE}</p>
    </div>
  );
}
