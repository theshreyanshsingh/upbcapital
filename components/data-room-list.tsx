import { docLabel } from "@/lib/labels";

type RoomDocument = { id: string; type: string; originalName: string; finalRoundOnly?: boolean | null };

// The listing's room. A file's name and its download show only to someone who can open the file; everyone else
// sees its type and the gate in front of it. On a two-round sale, `finalRound` says whether files held for the
// final round open to this viewer: they show to everyone, and open once the viewer's firm is shortlisted.
export function DataRoomList({
  documents,
  canOpen,
  roomClosed,
  gate,
  finalRound,
}: {
  documents: RoomDocument[];
  canOpen: (document: RoomDocument) => boolean;
  roomClosed: boolean;
  gate: string;
  finalRound?: { open: boolean } | null;
}) {
  const held = (document: RoomDocument) => Boolean(finalRound && document.finalRoundOnly);
  const opens = (document: RoomDocument) => canOpen(document) && !(held(document) && !finalRound?.open);
  return (
    <section aria-labelledby="room-heading" className="mt-8">
      <h2 id="room-heading" className="eyebrow">Data room</h2>
      <ul className="mt-4 divide-y divide-border border border-border rounded-xl">
        {roomClosed && <li className="px-4 py-4 text-sm text-muted-foreground">The data room closed when this listing went to contract. Only the buyer on the deal can open these files now.</li>}
        {documents.length === 0 && <li className="px-4 py-4 text-sm text-muted-foreground">No documents uploaded.</li>}
        {documents.map((document) => (
          <li key={document.id} className="flex items-center justify-between gap-3 px-4 py-4">
            {/* File names often carry a borrower or a street, so they show only to someone who can open the file. */}
            {opens(document) ? (
              <div className="min-w-0">
                <p className="truncate text-sm text-foreground">{document.originalName}</p>
                <p className="text-[13px] font-medium text-muted-foreground">{docLabel(document.type)}{held(document) ? " · final round only" : ""}</p>
              </div>
            ) : (
              <p className="min-w-0 text-sm text-foreground">{docLabel(document.type)}{held(document) ? <span className="text-muted-foreground"> · final round only</span> : null}</p>
            )}
            {opens(document) ? (
              <a className="shrink-0 text-[13px] font-medium text-link" href={`/api/documents/${document.id}`}>Download</a>
            ) : (
              <span className="shrink-0 text-right text-[13px] font-medium text-muted-foreground">{held(document) && !finalRound?.open && canOpen(document) ? "Shortlisted bidders" : gate}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
