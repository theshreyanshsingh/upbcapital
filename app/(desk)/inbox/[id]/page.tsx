import { notFound } from "next/navigation";
import { postThread } from "@/actions/inbox";
import { Notice } from "@/components/notice";
import { SubmitButton } from "@/components/submit-button";
import { requireUser } from "@/lib/auth";
import { q, prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { messageWasRead } from "@/lib/read-state";

export const metadata = { title: "Thread" };

export default async function ThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const query = await searchParams;
  const thread = await prisma.deskThread.findUnique({
    where: { id },
    include: {
      members: { include: { user: true } },
      posts: { orderBy: { createdAt: "asc" }, include: { author: true, files: true } },
    },
  });
  if (!thread) notFound();
  const seated = thread.members.some((member) => member.userId === user.id);
  if (!seated && user.role !== "ADMIN") notFound();
  await prisma.threadMember.upsert({
    where: { threadId_userId: { threadId: id, userId: user.id } },
    create: { threadId: id, userId: user.id, lastReadAt: new Date() },
    update: { lastReadAt: new Date() },
  });
  const others = thread.members.filter((member) => member.userId !== user.id).map((member) => member.lastReadAt);
  return (
    <div className="max-w-3xl">
      <p className="eyebrow">Thread</p>
      <h1 className="mt-3 font-semibold tracking-tight text-3xl text-foreground">{thread.subject}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{thread.members.map((member) => member.user.name).join(" · ")}</p>
      <Notice notice={q(query, "notice")} error={q(query, "error")} />
      {/* A conversation: your posts on the right, everyone else's on the left. The list links here at #latest. */}
      <ol className="mt-8 space-y-4">
        {thread.posts.map((post, index) => {
          const own = post.authorId === user.id;
          return (
            <li key={post.id} id={index === thread.posts.length - 1 ? "latest" : undefined} className={`flex scroll-mt-20 flex-col ${own ? "items-end" : "items-start"}`}>
              <p className="px-1 text-xs font-medium text-muted-foreground">{own ? "You" : post.author.name} · {prettyDate(post.createdAt)}</p>
              <div className={`mt-1 max-w-[88%] rounded-2xl px-3.5 py-2.5 sm:max-w-[80%] ${own ? "rounded-br-md bg-link/10 ring-1 ring-link/25" : "rounded-bl-md bg-card ring-1 ring-border"}`}>
                <p className="text-[15px] leading-6 whitespace-pre-wrap text-foreground sm:text-sm">{post.body}</p>
                {post.files.map((file) => (
                  <a key={file.id} href={`/api/threads/files/${file.id}`} className="mt-1.5 block text-sm font-medium text-link">{file.originalName}</a>
                ))}
              </div>
              {own && <p className="mt-1 px-1 text-xs text-muted-foreground">{messageWasRead(post.createdAt, others) ? "Read" : "Sent"}</p>}
            </li>
          );
        })}
      </ol>
      {/* On a phone the reply box rides at the bottom, above the tab bar, while the thread scrolls under it. */}
      <form
        action={postThread}
        className="sticky bottom-[var(--dock,0px)] z-10 -mx-4 mt-6 border-t border-border bg-background/92 px-4 pt-3 pb-3 backdrop-blur-xl md:static md:mx-0 md:mt-8 md:rounded-xl md:border md:bg-card md:p-5 md:backdrop-blur-none"
      >
        <input type="hidden" name="threadId" value={thread.id} />
        <label className="block">
          <span className="text-[13px] text-muted-foreground max-md:sr-only">Reply</span>
          <textarea name="body" rows={2} placeholder="Write a reply" className="desk-input min-h-12 md:mt-2 md:min-h-24" aria-label="Reply" />
        </label>
        <div className="mt-2 flex items-center justify-between gap-3">
          <input name="file" type="file" className="min-w-0 flex-1" aria-label="Attachment" />
          <SubmitButton className="h-11 shrink-0 px-5 text-sm font-semibold md:text-[13px] md:font-medium">Send</SubmitButton>
        </div>
      </form>
    </div>
  );
}
