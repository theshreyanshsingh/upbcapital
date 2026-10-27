import Link from "next/link";
import { PageIntro } from "@/components/page-intro";
import { requireUser } from "@/lib/auth";
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
      <ul className="divide-y divide-border border border-border rounded-xl">
        {threads.length === 0 && <li className="px-5 py-10 text-sm text-muted-foreground">No threads yet. An offer or a closing opens one.</li>}
        {threads.map((thread) => {
          const mine = thread.members.find((member) => member.userId === user.id);
          const latest = thread.posts[0];
          const unread = latest && latest.authorId !== user.id && (!mine?.lastReadAt || mine.lastReadAt < latest.createdAt);
          return (
            <li key={thread.id}>
              <Link href={`/inbox/${thread.id}`} className="block px-5 py-5 hover:bg-muted/60">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-semibold tracking-tight text-2xl text-foreground">{thread.subject}</p>
                  {unread && <span className="text-xs font-medium text-link">Unread</span>}
                </div>
                {latest && <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{latest.author.name}: {latest.body}</p>}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
