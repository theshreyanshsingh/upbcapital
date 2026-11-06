import Link from "next/link";
import { PageIntro } from "@/components/page-intro";
import { requireUser } from "@/lib/auth";
import { prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { syncThreadsFor } from "@/lib/threads";

export const metadata = { title: "Inbox" };

export default async function InboxPage() {
  const user = await requireUser();
  await syncThreadsFor(user.id, user.role);
  const threads = await prisma.deskThread.findMany({
    where: user.role === "ADMIN" ? {} : { members: { some: { userId: user.id } } },
    include: {
      posts: { orderBy: { createdAt: "desc" }, take: 1, include: { author: true } },
      members: true,
    },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });
  return (
    <div>
      <PageIntro eyebrow="Inbox" title="One place for the file." lede="Offers, questions, and closings share a thread. Opening a thread marks it read. A reply can carry a file." />
      {/* A message list: an unread dot, the subject, when, and the latest line. A thread opens at its latest post. */}
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {threads.length === 0 && <li className="px-5 py-10 text-sm text-muted-foreground">No threads yet. An offer or a closing opens one.</li>}
        {threads.map((thread) => {
          const mine = thread.members.find((member) => member.userId === user.id);
          const latest = thread.posts[0];
          const unread = latest && latest.authorId !== user.id && (!mine?.lastReadAt || mine.lastReadAt < latest.createdAt);
          return (
            <li key={thread.id}>
              <Link href={`/inbox/${thread.id}#latest`} className="flex gap-3 px-4 py-3.5 transition-colors hover:bg-hover active:bg-hover sm:px-5 sm:py-4">
                <span aria-hidden className={`mt-2 size-2 shrink-0 rounded-full ${unread ? "bg-link" : "bg-transparent"}`} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className={`line-clamp-2 text-[15px] leading-5 ${unread ? "font-semibold text-foreground" : "font-medium text-foreground/90"}`}>{thread.subject}</span>
                    {latest && <span className="figure shrink-0 text-xs text-muted-foreground">{prettyDate(latest.createdAt)}</span>}
                  </span>
                  {latest && <span className="mt-1 block truncate text-sm text-muted-foreground">{latest.author.name}: {latest.body}</span>}
                  {unread && <span className="sr-only">Unread.</span>}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
