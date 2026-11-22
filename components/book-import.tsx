import { cookies } from "next/headers";
import { confirmBookImport, discardBookImport, previewBookImport, undoBookImport } from "@/actions/portfolio";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { SubmitButton } from "@/components/submit-button";
import { money, prettyDate } from "@/lib/format";
import { IMPORT_COOKIE, MAX_IMPORT_ROWS, importBatches, previewImport, type ImportPreview } from "@/lib/portfolio-import";
import { readTapeDraft } from "@/lib/tape-draft";

const SHOWN = 10;
const SHOWN_PROBLEMS = 25;

const plural = (count: number, word: string) => `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;

// The portfolio page's "Import a book": the template, the upload, what it would bring in, and an undo for each recent
// upload. Every list is stacked cards, so a phone reads it without scrolling sideways (lib/portfolio-import.ts).
export async function BookImport({ userId, notice, error }: { userId: string; notice?: string; error?: string }) {
  const jar = await cookies();
  const token = jar.get(IMPORT_COOKIE)?.value ?? "";
  const draft = /^[0-9a-f-]{36}$/i.test(token) ? await readTapeDraft(userId, token) : null;
  const [preview, batches] = await Promise.all([draft ? previewImport(userId, draft.filename, draft.bytes) : null, importBatches(userId)]);
  return (
    <section id="import-book" aria-labelledby="import-book-heading" className="mt-12 scroll-mt-6 border border-border p-5 rounded-xl">
      <h2 id="import-book-heading" className="eyebrow">Import a book</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Bring the notes you already hold in one file, up to {MAX_IMPORT_ROWS.toLocaleString("en-US")} rows. Each row needs what a note added by hand needs: a title, the cost, the UPB and the date you acquired it. A row with no title is named from its address and loan number. A servicer&apos;s export or your own spreadsheet reads without renaming its columns, and you see what comes in before anything is saved.
      </p>
      <a href="/api/portfolio/import-template" className="mt-2 inline-flex min-h-10 items-center text-[13px] font-medium text-link">Download the template (CSV)</a>
      {(notice || error) && <div className="mt-3"><Notice notice={notice} error={error} /></div>}

      {draft && preview?.ok ? (
        <StagedImport filename={draft.filename} token={token} preview={preview.value} />
      ) : draft && preview && !preview.ok ? (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-foreground break-words">{draft.filename} · {preview.error}</p>
          <form action={discardBookImport}>
            <SubmitButton variant="outline" className="h-11 w-full text-[13px] font-medium sm:w-auto" pendingLabel="Setting aside…">Set it aside</SubmitButton>
          </form>
        </div>
      ) : (
        <form action={previewBookImport} className="mt-4 grid gap-3 rounded-lg border border-border p-4">
          <label className="block min-w-0">
            <span className="text-[13px] text-muted-foreground">Your book, as CSV or Excel</span>
            <input type="file" name="file" required accept=".csv,.xlsx,.xls" className="mt-2 block w-full min-w-0 text-sm" />
          </label>
          <div>
            <SubmitButton className="h-11 w-full text-[13px] font-medium sm:w-auto" pendingLabel="Reading…">Preview the import</SubmitButton>
          </div>
        </form>
      )}

      {batches.length > 0 && (
        <div className="mt-6">
          <h3 className="text-[13px] font-medium text-foreground">Recent imports</h3>
          <ul className="mt-2 space-y-2">
            {batches.map((batch) => (
              <li key={batch.id} className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-sm tabular-nums">
                  <p className="text-foreground">
                    Imported {prettyDate(batch.at)} · {batch.left === batch.imported ? plural(batch.imported, "note") : `${batch.left} of ${plural(batch.imported, "note")} still on your book`}
                  </p>
                  {batch.removable < batch.left && (
                    <p className="mt-1 text-[13px] text-muted-foreground">
                      {batch.removable === 0 ? "Each has a payment logged or a relist since, so they stay on your book." : `${batch.left - batch.removable} with a payment logged or a relist since would stay.`}
                    </p>
                  )}
                </div>
                {batch.removable > 0 && (
                  <form action={undoBookImport} className="shrink-0">
                    <input type="hidden" name="batchId" value={batch.id} />
                    <ConfirmSubmit
                      title="Undo this import?"
                      consequence={`${plural(batch.removable, "note")} from this upload ${batch.removable === 1 ? "comes" : "come"} off your portfolio.${batch.removable < batch.left ? ` ${batch.left - batch.removable} with a payment logged or a relist since ${batch.left - batch.removable === 1 ? "stays" : "stay"}.` : ""} Nothing else on your book changes, and the undo is logged.`}
                      confirmLabel="Undo the import"
                      pendingLabel="Undoing…"
                      tone="danger"
                      variant="outline"
                      className="h-11 w-full text-[13px] font-medium sm:w-auto"
                    >
                      Undo this import
                    </ConfirmSubmit>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function StagedImport({ filename, token, preview }: { filename: string; token: string; preview: ImportPreview }) {
  const { rows, errors, duplicates, totals } = preview;
  const left = [duplicates.length ? plural(duplicates.length, "duplicate") : "", errors.length ? `${plural(errors.length, "row")} with errors` : ""].filter(Boolean).join(" and ");
  return (
    <div className="mt-4 space-y-5">
      <div>
        <p className="text-sm font-medium text-foreground break-words">{filename}</p>
        <dl className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-muted sm:grid-cols-3 lg:grid-cols-5">
          {[
            ["Rows to import", totals.count.toLocaleString("en-US")],
            ["Rows with errors", errors.length.toLocaleString("en-US")],
            ["Duplicates skipped", duplicates.length.toLocaleString("en-US")],
            ["UPB", money(totals.upb)],
            ["Cost basis", money(totals.costBasis)],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0 bg-card/80 px-3 py-2">
              <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
              <dd className="mt-1 truncate text-lg font-semibold tracking-tight text-foreground tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-muted-foreground break-words">
          Columns read: {preview.columns.map((column) => `${column.label} (${column.header})`).join(", ") || "none"}.
          {preview.unused.length > 0 && ` Not used: ${preview.unused.slice(0, 12).join(", ")}${preview.unused.length > 12 ? ", and more" : ""}.`}
        </p>
      </div>

      {rows.length > 0 && (
        <div>
          <h3 className="text-[13px] font-medium text-foreground">What comes in</h3>
          <ul className="mt-2 space-y-2">
            {rows.slice(0, SHOWN).map((row) => (
              <li key={row.row} className="rounded-lg border border-border p-3">
                <p className="text-sm text-foreground break-words">{row.title}</p>
                <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                  Row {row.row} · UPB {money(row.upb)} · cost {money(row.costBasis)} · acquired {prettyDate(row.acquiredAt)}
                  {row.underwrittenYield != null ? ` · underwritten ${row.underwrittenYield.toFixed(1)}%` : ""}
                </p>
              </li>
            ))}
          </ul>
          {rows.length > SHOWN && <p className="mt-2 text-xs text-muted-foreground tabular-nums">And {plural(rows.length - SHOWN, "more note")}.</p>}
        </div>
      )}

      {errors.length > 0 && (
        <div>
          <h3 className="text-[13px] font-medium text-foreground">Rows with errors, left out</h3>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground tabular-nums">
            {errors.slice(0, SHOWN_PROBLEMS).map((row) => (
              <li key={row.row} className="break-words">Row {row.row} · {row.label} · {row.reasons.join("; ")}</li>
            ))}
          </ul>
          {errors.length > SHOWN_PROBLEMS && <p className="mt-1 text-xs text-muted-foreground tabular-nums">And {plural(errors.length - SHOWN_PROBLEMS, "more row")}.</p>}
        </div>
      )}

      {duplicates.length > 0 && (
        <div>
          <h3 className="text-[13px] font-medium text-foreground">Duplicates, skipped</h3>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground tabular-nums">
            {duplicates.slice(0, SHOWN_PROBLEMS).map((row) => (
              <li key={row.row} className="break-words">Row {row.row} · {row.label} · {row.reason}</li>
            ))}
          </ul>
          {duplicates.length > SHOWN_PROBLEMS && <p className="mt-1 text-xs text-muted-foreground tabular-nums">And {plural(duplicates.length - SHOWN_PROBLEMS, "more row")}.</p>}
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {rows.length > 0 ? (
          <form action={confirmBookImport}>
            <input type="hidden" name="token" value={token} />
            <ConfirmSubmit
              title={`Import ${plural(totals.count, "note")}?`}
              consequence={`${plural(totals.count, "note")} ${totals.count === 1 ? "comes" : "come"} onto your portfolio, ${money(totals.upb)} of UPB at a cost basis of ${money(totals.costBasis)}.${left ? ` ${left} stay out.` : ""} You can undo the import while its notes have no payments logged and no relist.`}
              confirmLabel="Import the notes"
              pendingLabel="Importing…"
              className="h-11 w-full text-[13px] font-medium sm:w-auto"
            >
              Import {plural(totals.count, "note")}
            </ConfirmSubmit>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">No row is ready to import. Fix the rows above and upload the file again.</p>
        )}
        <form action={discardBookImport}>
          <SubmitButton variant="outline" className="h-11 w-full text-[13px] font-medium sm:w-auto" pendingLabel="Setting aside…">Set it aside</SubmitButton>
        </form>
      </div>
    </div>
  );
}
