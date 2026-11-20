import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { editNoteOnWatch } from "@/actions/note-watch";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { WatchForm } from "../watch-form";

export const metadata = { title: "Edit a watched note" };
export const dynamic = "force-dynamic";

// The holder's own note only. Saving new figures reads it again at once.
export default async function EditWatchedNotePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireRole(["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER"]);
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const note = /^[\w-]{1,64}$/.test(id) ? await prisma.trackedNote.findUnique({ where: { id } }) : null;
  if (!note || note.userId !== user.id) notFound();
  if (note.listingId) redirect(`/seller/watch?error=${encodeURIComponent("This note is listed. Change the listing instead.")}#note-${note.id}`);
  return (
    <div>
      <Link href="/seller/watch" className="-mt-2 mb-2 inline-flex h-10 items-center text-sm text-link">All watched notes</Link>
      <PageIntro eyebrow="Note watch" title="Edit a watched note." lede="Change what has changed: the balance after payments, the value, the payment status. Saving new figures reads the note again." />
      <p className="-mt-2 mb-4 break-words text-[15px] font-medium text-foreground">{note.label}</p>
      <Notice error={q(query, "error")} />
      <div className="mt-4">
        <WatchForm action={editNoteOnWatch} note={note} submitLabel="Save and read again" pendingLabel="Reading…" />
      </div>
    </div>
  );
}
