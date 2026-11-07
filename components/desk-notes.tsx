import { addDeskNote, removeDeskNote } from "@/actions/desk-notes";
import { SubmitButton } from "@/components/submit-button";
import { prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";

// Desk-only. Render this only on pages an admin is viewing. A read-only desk role reads the notes without the forms.
export async function DeskNotes({ subjectType, subjectId, back, viewerId, readOnly = false }: { subjectType: "listing" | "closing" | "user"; subjectId: string; back: string; viewerId: string; readOnly?: boolean }) {
  const notes = await prisma.deskNote.findMany({
    where: { subjectType, subjectId },
    include: { author: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return (
    <section className="border border-border p-5 rounded-xl">
      <p className="eyebrow">Desk notes</p>
      <p className="mt-1 text-xs text-muted-foreground">Only the desk sees these. The parties never do.</p>
      {readOnly && notes.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No desk notes yet.</p>}
      {!readOnly && <form action={addDeskNote} className="mt-3 space-y-2">
        <input type="hidden" name="subjectType" value={subjectType} />
        <input type="hidden" name="subjectId" value={subjectId} />
        <input type="hidden" name="back" value={back} />
        <textarea name="body" aria-label="New desk note" placeholder="Calls, context, next step" className="desk-input min-h-20" required minLength={2} maxLength={2000} />
        <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Saving…">Add note</SubmitButton>
      </form>}
      {notes.length > 0 && (
        <ul className="mt-4 space-y-3">
          {notes.map((note) => (
            <li key={note.id} className="border-t border-border pt-3">
              <p className="text-xs text-muted-foreground">{note.author.name} · {prettyDate(note.createdAt)}</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{note.body}</p>
              {note.authorId === viewerId && !readOnly && (
                <form action={removeDeskNote} className="mt-1">
                  <input type="hidden" name="noteId" value={note.id} />
                  <input type="hidden" name="back" value={back} />
                  <button type="submit" className="text-xs text-muted-foreground underline-offset-2 hover:underline">Remove</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
