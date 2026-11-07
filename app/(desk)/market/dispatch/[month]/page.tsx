import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { dispatchIssue, issueBlocks, linkParts } from "@/lib/dispatch";
import { prettyDate } from "@/lib/format";

export const metadata = { title: "Dispatch" };

function Line({ text }: { text: string }) {
  return (
    <>
      {linkParts(text).map((part, index) =>
        part.href ? (
          <a key={index} href={part.href} className="break-all text-link">{part.text}</a>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

// One back issue, the email as it went out.
export default async function DispatchIssuePage({ params }: { params: Promise<{ month: string }> }) {
  await requireUser();
  const { month } = await params;
  const issue = await dispatchIssue(month);
  if (!issue) notFound();
  return (
    <article className="max-w-3xl">
      <p className="eyebrow">Market dispatch</p>
      <h1 className="mt-1.5 type-display font-semibold text-balance text-foreground">{issue.title}</h1>
      <p className="mt-2 text-sm text-muted-foreground tabular-nums">Sent {prettyDate(issue.sentAt)} · {issue.subject}</p>
      <div className="glass mt-6 space-y-4 p-5 md:p-6">
        {issueBlocks(issue.body).map((block, index) =>
          block.kind === "list" ? (
            <ul key={index} className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-foreground tabular-nums">
              {block.items.map((item, line) => <li key={line}><Line text={item} /></li>)}
            </ul>
          ) : (
            <p key={index} className="text-sm leading-relaxed text-foreground">
              {block.lines.map((line, at) => (
                <span key={at} className="block"><Line text={line} /></span>
              ))}
            </p>
          ),
        )}
      </div>
      <p className="mt-6 text-sm">
        <Link href="/market/dispatch" className="font-medium text-link">All back issues</Link>
        <span className="text-muted-foreground"> · </span>
        <Link href="/market" className="font-medium text-link">This month&apos;s dispatch</Link>
      </p>
    </article>
  );
}
