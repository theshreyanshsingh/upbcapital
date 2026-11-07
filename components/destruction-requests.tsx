import { certifyFilesDestroyed } from "@/actions/destruction";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { destructionRequestsFor } from "@/lib/destruction";
import { prettyDate } from "@/lib/format";

// On the buyer's inquiries page: each listing that went to someone else, where the NDA asks the buyer to destroy
// the room's files. Open requests come first, with the certification; certified ones keep their certificate.
export async function DestructionRequests({ userId }: { userId: string }) {
  const requests = await destructionRequestsFor(userId);
  if (!requests.length) return null;
  const open = requests.filter((row) => !row.destroyedAt);
  const done = requests.filter((row) => row.destroyedAt);
  return (
    <section id="destruction" aria-labelledby="destruction-heading" className="mt-8 scroll-mt-6 border border-border p-5 rounded-xl">
      <p id="destruction-heading" className="eyebrow">Data room files to destroy</p>
      {open.length > 0 && (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            These listings went to another buyer, so their rooms are closed to you. Your NDA asks you to destroy every file you took, with any copies and notes that carry borrower details, and to say so here.
          </p>
          <ul className="mt-3 space-y-2">
            {open.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 border border-link/30 bg-link/5 p-4 rounded-xl">
                <div className="min-w-0">
                  <p className="text-sm text-foreground">{row.listing.title}</p>
                  <p className="text-xs text-muted-foreground">Asked {prettyDate(row.destroyRequestedAt)}</p>
                </div>
                <form action={certifyFilesDestroyed}>
                  <input type="hidden" name="ndaId" value={row.id} />
                  <ConfirmSubmit
                    title="Certify the files are destroyed?"
                    consequence={`You confirm you destroyed every file from the ${row.listing.title} data room, with copies and notes. The seller gets a certificate that names you by your bidder letter.`}
                    confirmLabel="I certify I destroyed the files"
                    pendingLabel="Recording…"
                    className="h-9 text-[13px] font-medium"
                  >
                    I certify I destroyed the files
                  </ConfirmSubmit>
                </form>
              </li>
            ))}
          </ul>
        </>
      )}
      {done.length > 0 && (
        <ul className={`${open.length ? "mt-4" : "mt-2"} divide-y divide-border border-y border-border`}>
          {done.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-sm text-foreground">{row.listing.title}</p>
                <p className="text-xs text-muted-foreground">Certified destroyed {prettyDate(row.destroyedAt)}</p>
              </div>
              <a href={`/api/destruction/${row.id}`} className="text-[13px] font-medium text-link">Certificate</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
