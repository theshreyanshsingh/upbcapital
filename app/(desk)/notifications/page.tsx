import { markNotificationsRead } from "@/actions/notifications";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireUser } from "@/lib/auth";
import { prettyDate, q } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Notices" };

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const notes = await prisma.notification.findMany({
    where: { OR: [{ userId: user.id }, { toEmail: user.email }] },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return (
    <div className="max-w-3xl">
      <PageIntro eyebrow="Notices" title="What the desk sent." lede="The same note is mailed when a provider is configured, and kept here either way." />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      {notes.some((note) => !note.readAt) && (
        <form action={markNotificationsRead} className="mt-4">
          <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Saving…">
            Mark all read
          </SubmitButton>
        </form>
      )}
      <ul className="mt-8 divide-y divide-border border border-border rounded-xl">
        {notes.length === 0 && <li className="px-5 py-8 text-sm text-muted-foreground">Nothing yet.</li>}
        {notes.map((note) => (
          <li key={note.id} className="px-5 py-5">
            <p className="text-xs font-medium text-link">
              {prettyDate(note.createdAt)} · {note.delivery}{note.readAt ? "" : " · new"}
            </p>
            <p className="mt-2 font-semibold tracking-tight text-2xl text-foreground">{note.subject}</p>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{note.body}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
