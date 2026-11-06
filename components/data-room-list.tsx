import { docLabel } from "@/lib/labels";

type RoomDocument = { id: string; type: string; originalName: string };

// The listing's room. A file's name and its download show only to someone who can open the file; everyone else
// sees its type and the gate in front of it.
export function DataRoomList({
  documents,
  canOpen,
  roomClosed,
  gate,
}: {
  documents: RoomDocument[];
  canOpen: (document: RoomDocument) => boolean;
  roomClosed: boolean;
  gate: string;
}) {
  return (
    <section aria-labelledby="room-heading" className="mt-8">
      <h2 id="room-heading" className="eyebrow">Data room</h2>
      <ul className="mt-4 divide-y divide-border border border-border rounded-xl">
        {roomClosed && <li className="px-4 py-4 text-sm text-muted-foreground">The data room closed when this listing went to contract. Only the buyer on the deal can open these files now.</li>}
        {documents.length === 0 && <li className="px-4 py-4 text-sm text-muted-foreground">No documents uploaded.</li>}
        {documents.map((document) => (
          <li key={document.id} className="flex items-center justify-between gap-3 px-4 py-4">
            {/* File names often carry a borrower or a street, so they show only to someone who can open the file. */}
            {canOpen(document) ? (
              <div className="min-w-0">
                <p className="truncate text-sm text-foreground">{document.originalName}</p>
                <p className="text-[13px] font-medium text-muted-foreground">{docLabel(document.type)}</p>
              </div>
            ) : (
              <p className="text-sm text-foreground">{docLabel(document.type)}</p>
            )}
            {canOpen(document) ? (
              <a className="text-[13px] font-medium text-link" href={`/api/documents/${document.id}`}>Download</a>
            ) : (
              <span className="text-[13px] font-medium text-muted-foreground">{gate}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
