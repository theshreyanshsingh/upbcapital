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
      <ol className="mt-8 space-y-4">
        {thread.posts.map((post) => (
          <li key={post.id} className="border border-border p-4 rounded-xl">
            <p className="text-[13px] font-medium text-muted-foreground">{post.author.name} · {prettyDate(post.createdAt)}</p>
            <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{post.body}</p>
            {post.files.map((file) => (
              <a key={file.id} href={`/api/threads/files/${file.id}`} className="mt-2 block text-sm text-link">{file.originalName}</a>
            ))}
            {post.authorId === user.id && (
              <p className="mt-2 text-xs font-medium text-muted-foreground">{messageWasRead(post.createdAt, others) ? "Read" : "Sent"}</p>
            )}
          </li>
        ))}
      </ol>
      <form action={postThread} className="mt-8 space-y-3 border border-border p-5 rounded-xl">
        <input type="hidden" name="threadId" value={thread.id} />
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Reply</span>
          <textarea name="body" className="desk-input mt-2 min-h-24" aria-label="Reply" />
        </label>
        <label className="block text-sm text-muted-foreground">
          Attachment
          <input name="file" type="file" className="mt-2 block w-full text-sm" aria-label="Attachment" />
        </label>
        <SubmitButton className="h-11 text-[13px] font-medium">Send</SubmitButton>
      </form>
    </div>
  );
}
