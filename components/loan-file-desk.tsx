import Link from "next/link";
import { cookies } from "next/headers";
import { clearField, logRisk, moveCollateral, removeCollateral, saveCollateral, uploadLoanReport, verifyField } from "@/actions/loan-file";
import { applyServicerReport, discardServicerReport, previewServicerReport } from "@/actions/servicer-import";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { DiscrepancyRaise } from "@/components/discrepancy-desk";
import { collateralTone, CureBy, FieldBadge, riskTone, Tag } from "@/components/loan-file-view";
import { SubmitButton } from "@/components/submit-button";
import type { DiscrepancyRow } from "@/lib/discrepancies";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { answerable } from "@/lib/discrepancies";
import { isoDate, prettyDate } from "@/lib/format";
import { docLabel } from "@/lib/labels";
import {
  chainOfTitle,
  chainParties,
  COLLATERAL_STATUSES,
  collateralLines,
  collateralStatusLabel,
  completeness,
  completenessLine,
  displayValue,
  endorsementLabel,
  ENDORSEMENTS,
  fieldSpec,
  fieldState,
  isChainKind,
  latestChecks,
  LOAN_DOCUMENT_TYPES,
  LOAN_FIELDS,
  RISK_KINDS,
  RISK_RESULTS,
  riskKindLabel,
  riskResultLabel,
  superLien,
  tapeValue,
  verifiedMap,
  VERIFY_SOURCES,
  type Chain,
  type CollateralRow,
  type FieldSpec,
  type RiskRow,
} from "@/lib/loan-file";
import {
  readPreviewCookie,
  SERVICER_COOKIE,
  SERVICER_SOURCES,
  stagedReport,
  type LineAction,
  type StagedReport,
} from "@/lib/servicer-import";

type DeskDocument = { id: string; type: string; originalName: string; createdAt: Date; noteId: string | null };
type LoanRecord = { id: string; listingId?: string; state: string; propertyType: string; lienPosition: string; hoaLien?: boolean | null; verifiedFields?: unknown } & object;

const RECORDED = new Set(["MORTGAGE", "ASSIGNMENT"]);
// The paper that travels physically, so the desk photographs it as received.
const PHOTOGRAPHED = new Set(["ORIGINAL_NOTE", "ALLONGE"]);
const RISK_SOURCES = ["PACER", "County tax collector", "County recorder", "ATTOM", "Servicer", "Drive-by inspection", "Borrower contact"];

// Desk-only. Render this only on pages an admin is viewing: it shows every party and every value.
export function LoanFileDesk({
  note,
  collateral,
  risks,
  documents,
  holder,
  people,
  heading,
  picker,
  discrepancies = [],
  listedAt = null,
  readOnly = false,
}: {
  note: LoanRecord;
  collateral: CollateralRow[];
  risks: RiskRow[];
  // This loan's own files and the listing's shared ones, for linking a line or a check to its paper.
  documents: DeskDocument[];
  holder: string | null;
  people: Record<string, string>;
  heading: string;
  picker?: { action: string; options: { id: string; label: string }[]; previous: string | null; next: string | null; position: string };
  // This loan's tape differences, and when the listing was filed, for the "fixed after listing" caution.
  discrepancies?: DiscrepancyRow[];
  listedAt?: Date | null;
  // A desk role outside sales reads the whole file without the forms. The actions refuse it too.
  readOnly?: boolean;
}) {
  const file = completeness(note, collateral, risks, { holder });
  const lines = collateralLines(note.lienPosition, collateral);
  const chain = chainOfTitle(collateral, holder, { listedAt });
  const openFields = new Set(discrepancies.filter((row) => row.noteId === note.id && row.status === "OPEN").map((row) => row.field));
  const latest = latestChecks(risks);
  const flag = superLien(note);
  const entries = verifiedMap(note.verifiedFields);
  const loanDocs = documents.filter((document) => document.noteId === note.id);
  const log = [...risks].sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime()).slice(0, 50);
  const who = (id: string | null | undefined) => (id ? people[id] ?? "Desk" : "Desk");

  return (
    <section id="loan-file" className="mt-8 scroll-mt-6 border border-border p-5 rounded-xl" aria-labelledby="loan-file-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="loan-file-heading" className="eyebrow">Loan file</h2>
        {picker && (
          <nav aria-label="Loans in this pool" className="flex items-center gap-3 text-[13px] font-medium">
            {picker.previous ? <Link className="text-link" href={picker.previous}>Previous loan</Link> : <span className="text-muted-foreground">Previous loan</span>}
            <span className="text-muted-foreground tabular-nums">{picker.position}</span>
            {picker.next ? <Link className="text-link" href={picker.next}>Next loan</Link> : <span className="text-muted-foreground">Next loan</span>}
          </nav>
        )}
      </div>
      {picker && (
        <form method="get" action={picker.action} className="mt-3 flex flex-wrap items-end gap-2">
          <label className="block min-w-0 flex-1">
            <span className="text-[13px] text-muted-foreground">Loan</span>
            <select name="loan" defaultValue={note.id} className="desk-input mt-2">
              {picker.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          <button type="submit" className="h-10 rounded-lg border border-border px-4 text-[13px] font-medium text-foreground">Open the file</button>
        </form>
      )}
      <p className="mt-3 text-sm font-medium text-foreground">{heading}</p>
      <p className="mt-1 text-sm text-muted-foreground tabular-nums">{completenessLine(file)}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Buyers see the status words, results, sources and dates. Detail, cure owners, recordings and chain parties show only to buyers who can open this loan&apos;s street and borrower.
      </p>
      {flag && (
        <p className="mt-3"><Tag tone="warn" title={flag.cite}>{flag.label} · {flag.state} · {flag.cite}</Tag></p>
      )}

      <h3 className="mt-6 text-[13px] font-medium text-foreground">Collateral</h3>
      <div className="mt-2">
        {lines.map((line) => (
          <div key={line.kind} className="border-t border-border py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-medium text-foreground">{line.label}{line.required ? "" : " · optional for this lien"}</p>
              {line.items.length === 0 && <Tag tone="plain">Not reviewed</Tag>}
            </div>
            <p className="text-xs text-muted-foreground">{line.hint}</p>
            {line.items.map((item, index) => (
              <details key={item.id} className="mt-2 rounded-lg border border-border px-3 py-2">
                <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="text-foreground">{itemTitle(item)}</span>
                  <Tag tone={collateralTone(item.status)}>{collateralStatusLabel(item.status)}</Tag>
                  {(item.status === "MISSING" || item.status === "DEFECTIVE") && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {item.cureBy ? <CureBy cureBy={item.cureBy} owner={item.cureOwner || "no cure owner"} /> : item.cureOwner ? `Cure: ${item.cureOwner} · no date` : "No cure owner or date"}
                    </span>
                  )}
                  {item.recording && <span className="text-xs text-muted-foreground tabular-nums">{item.recording}{item.recordedAt ? ` · ${prettyDate(item.recordedAt)}` : ""}</span>}
                  <span className="text-xs text-muted-foreground">{who(item.updatedById)} · {prettyDate(item.updatedAt ?? item.createdAt)}</span>
                </summary>
                {readOnly ? (
                  item.documentId && <p className="mt-2 text-xs"><a className="text-link" href={`/api/documents/${item.documentId}`}>File on record</a></p>
                ) : (
                  <CollateralForm noteId={note.id} kind={item.kind} item={item} documents={documents} />
                )}
                {item.photoDocumentId && <p className="mt-2 text-xs"><a className="text-link" href={`/api/documents/${item.photoDocumentId}`}>Intake photo</a></p>}
                {!readOnly && <div className="mt-3 flex flex-wrap gap-2">
                  {isChainKind(item.kind) && index > 0 && (
                    <form action={moveCollateral}>
                      <input type="hidden" name="noteId" value={note.id} />
                      <input type="hidden" name="itemId" value={item.id} />
                      <input type="hidden" name="direction" value="up" />
                      <SubmitButton variant="outline" className="h-8 text-xs" pendingLabel="Moving…">Move earlier</SubmitButton>
                    </form>
                  )}
                  {isChainKind(item.kind) && index < line.items.length - 1 && (
                    <form action={moveCollateral}>
                      <input type="hidden" name="noteId" value={note.id} />
                      <input type="hidden" name="itemId" value={item.id} />
                      <input type="hidden" name="direction" value="down" />
                      <SubmitButton variant="outline" className="h-8 text-xs" pendingLabel="Moving…">Move later</SubmitButton>
                    </form>
                  )}
                  <form action={removeCollateral}>
                    <input type="hidden" name="noteId" value={note.id} />
                    <input type="hidden" name="itemId" value={item.id} />
                    <ConfirmSubmit
                      title="Remove this collateral line?"
                      consequence="It comes off this loan's file and the buyer view. The audit log keeps a record of the change."
                      confirmLabel="Remove the line"
                      pendingLabel="Removing…"
                      tone="danger"
                      className="h-8 text-xs"
                    >
                      Remove
                    </ConfirmSubmit>
                  </form>
                </div>}
              </details>
            ))}
            {!readOnly && <details className="mt-2">
              <summary className="cursor-pointer text-[13px] font-medium text-link">
                {line.chain ? (line.items.length ? "Add the next link" : "Add the first link, or mark it not required") : line.items.length ? "Add another" : "Record this line"}
              </summary>
              <CollateralForm noteId={note.id} kind={line.kind} documents={documents} />
            </details>}
          </div>
        ))}
      </div>

      <h3 className="mt-6 text-[13px] font-medium text-foreground">Chain of title</h3>
      <p className="mt-1 text-xs text-muted-foreground">From the originator to today&apos;s holder. Holder on file: {holder || "not named"}.</p>
      <div className="mt-3 grid gap-6 lg:grid-cols-2">
        <DeskChain chain={chain.endorsements} />
        <DeskChain chain={chain.assignments} />
      </div>
      {chain.cautions.map((item) => <p key={item} className="mt-2 text-xs text-warn">{item}</p>)}

      <h3 className="mt-8 text-[13px] font-medium text-foreground">Risk card</h3>
      <div className="mt-2 relative overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="text-xs font-medium text-muted-foreground">
            <tr>{["Check", "Result", "Source", "Checked", "Detail"].map((heading) => <th key={heading} className="px-2 py-2 font-normal">{heading}</th>)}</tr>
          </thead>
          <tbody>
            {RISK_KINDS.map(({ kind, label }) => {
              const check = latest[kind];
              return (
                <tr key={kind} className="border-t border-border align-top">
                  <td className="px-2 py-2 text-foreground">{label}</td>
                  <td className="px-2 py-2"><Tag tone={riskTone(check?.result)}>{check ? riskResultLabel(check.result) : "Not run"}</Tag></td>
                  <td className="px-2 py-2 text-muted-foreground">{check?.source ?? "—"}</td>
                  <td className="px-2 py-2 text-muted-foreground tabular-nums">{check ? `${prettyDate(check.checkedAt)} · ${who(check.checkedById)}` : "—"}</td>
                  <td className="px-2 py-2 text-muted-foreground">{check?.detail || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!readOnly && <form action={logRisk} className="mt-4 grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2">
        <p className="text-[13px] font-medium text-foreground sm:col-span-2">Log a check</p>
        <input type="hidden" name="noteId" value={note.id} />
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Check</span>
          <select name="kind" className="desk-input mt-2" required defaultValue="">
            <option value="" disabled>Choose</option>
            {RISK_KINDS.map((row) => <option key={row.kind} value={row.kind}>{row.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Result</span>
          <select name="result" className="desk-input mt-2" required defaultValue="">
            <option value="" disabled>Choose</option>
            {RISK_RESULTS.map((row) => <option key={row.value} value={row.value}>{row.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Source</span>
          <input name="source" list={`risk-sources-${note.id}`} className="desk-input mt-2" required maxLength={120} placeholder="PACER, county tax collector" />
          <datalist id={`risk-sources-${note.id}`}>
            {RISK_SOURCES.map((source) => <option key={source} value={source} />)}
          </datalist>
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Checked on</span>
          <input type="date" name="checkedAt" className="desk-input mt-2" defaultValue={isoDate(new Date()) ?? ""} />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-[13px] text-muted-foreground">What the desk found</span>
          <textarea name="detail" className="desk-input mt-2 min-h-16" maxLength={400} placeholder="Case number, amount, what the record shows" />
        </label>
        <DocumentSelect documents={documents} />
        <p className="text-xs text-muted-foreground sm:col-span-2">{RISK_KINDS.map((row) => `${row.label}: ${row.hint}`).join(" ")}</p>
        <div className="sm:col-span-2"><SubmitButton className="h-9 text-[13px] font-medium" pendingLabel="Logging…">Log the check</SubmitButton></div>
      </form>}
      {log.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[13px] font-medium text-link">Every check on this loan ({log.length})</summary>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            {log.map((check) => (
              <li key={check.id} className="tabular-nums">
                {prettyDate(check.checkedAt)} · {riskKindLabel(check.kind)} · {riskResultLabel(check.result)} · {check.source} · {who(check.checkedById)}{check.detail ? ` · ${check.detail}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}

      <h3 className="mt-8 text-[13px] font-medium text-foreground">Tape and desk</h3>
      <p className="mt-1 text-xs text-muted-foreground">{readOnly ? "Open a field to see the desk's check. Checks are for the sales side of the desk." : "Open a field to check it. Leave the value as the tape reads to confirm it, or enter what the document says if it differs."}</p>
      <div className="mt-2">
        {LOAN_FIELDS.map((spec) => {
          const tape = tapeValue(note, spec.field);
          const state = fieldState(note, spec.field);
          const entry = entries[spec.field];
          return (
            <details key={spec.field} className="border-t border-border py-2">
              <summary className="grid cursor-pointer gap-1 text-sm sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)_minmax(0,1.5fr)] sm:items-center sm:gap-3">
                <span className="text-muted-foreground">{spec.label}</span>
                <span className="text-foreground tabular-nums">{displayValue(spec, tape)}</span>
                <span className="flex flex-wrap items-center gap-2">
                  <FieldBadge field={spec.field} state={state} showValue />
                  {openFields.has(spec.field) && <Tag tone="warn">Open difference</Tag>}
                  {entry && <span className="text-xs text-muted-foreground">{who(entry.by)}</span>}
                </span>
              </summary>
              {readOnly && (
                <p className="mt-2 text-xs text-muted-foreground tabular-nums">
                  {entry ? `${entry.source} · ${prettyDate(entry.at)}` : "Not checked by the desk yet."}
                </p>
              )}
              {!readOnly && <div className="mt-3 flex flex-wrap items-end gap-3">
                <form action={verifyField} className="flex flex-wrap items-end gap-3">
                  <input type="hidden" name="noteId" value={note.id} />
                  <input type="hidden" name="field" value={spec.field} />
                  <label className="block">
                    <span className="text-[13px] text-muted-foreground">Document shows</span>
                    <DocumentValue spec={spec} value={tape} />
                  </label>
                  <label className="block">
                    <span className="text-[13px] text-muted-foreground">Source</span>
                    <select name="source" defaultValue={entry && !entry.origin ? entry.source : spec.source} className="desk-input mt-2 w-52">
                      {VERIFY_SOURCES.map((source) => <option key={source} value={source}>{source}</option>)}
                    </select>
                  </label>
                  <SubmitButton className="h-10 text-[13px] font-medium" pendingLabel="Saving…">Verify</SubmitButton>
                </form>
                {entry && (
                  <form action={clearField}>
                    <input type="hidden" name="noteId" value={note.id} />
                    <input type="hidden" name="field" value={spec.field} />
                    <SubmitButton variant="outline" className="h-10 text-[13px] font-medium" pendingLabel="Clearing…">{entry.origin ? "Clear the report's badge" : "Clear the check"}</SubmitButton>
                  </form>
                )}
              </div>}
            </details>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">A document that differs from the tape raises a difference the seller fixes or explains. Approval waits until each one has an answer.</p>
      {!readOnly && <DiscrepancyRaise noteId={note.id} />}

      <h3 className="mt-8 text-[13px] font-medium text-foreground">Files on this loan</h3>
      {loanDocs.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">No files on this loan yet.</p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {loanDocs.map((document) => (
            <li key={document.id} className="flex flex-wrap gap-x-2 text-muted-foreground tabular-nums">
              <a className="text-link" href={`/api/documents/${document.id}`}>{document.originalName}</a>
              <span>· {docLabel(document.type)} · {prettyDate(document.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
      {!readOnly && <form action={uploadLoanReport} className="mt-3 grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2">
        <input type="hidden" name="noteId" value={note.id} />
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Kind of file</span>
          <select name="type" className="desk-input mt-2" defaultValue="OE_REPORT">
            {LOAN_DOCUMENT_TYPES.map((type) => <option key={type} value={type}>{docLabel(type)}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">File</span>
          <input type="file" name="file" required accept=".pdf,.png,.jpg,.jpeg,.webp,.csv,.xls,.xlsx,.doc,.docx,.txt" className="mt-2 block w-full text-sm" />
        </label>
        <p className="text-xs text-muted-foreground sm:col-span-2">It opens to the desk, the seller, and buyers who can open this loan&apos;s street and borrower. Pro is needed unless the buyer is buying this loan.</p>
        <div className="sm:col-span-2"><SubmitButton className="h-9 text-[13px] font-medium" pendingLabel="Uploading…">Add to this loan</SubmitButton></div>
      </form>}

      {/* The servicer panel is only an upload and the viewer's own staged preview, so a read-only role skips it. */}
      {note.listingId && !readOnly && <ServicerReportPanel listingId={note.listingId} from="desk" loanId={note.id} nested />}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Servicer report: for the seller of record on their listing page and for the desk here. It shows only what the
// listing's own tape already holds, so it is safe on both. The file waits as a draft until it is applied.

const ACTION_TAGS: Record<LineAction, { tone: "good" | "warn" | "plain" | "source"; text: string }> = {
  fill: { tone: "good", text: "Fills a blank" },
  confirm: { tone: "source", text: "Agrees" },
  differ: { tone: "warn", text: "Differs · opens a question" },
  held: { tone: "plain", text: "Differs · no new question" },
  update: { tone: "source", text: "Newer figure · replaces the tape's" },
};

const SHOWN_LOANS = 25;

export async function ServicerReportPanel({ listingId, from, loanId, nested = false }: { listingId: string; from: "seller" | "desk"; loanId?: string; nested?: boolean }) {
  const [viewer, jar, listing] = await Promise.all([
    getCurrentUser(),
    cookies(),
    prisma.listing.findUnique({ where: { id: listingId }, select: { status: true } }),
  ]);
  const open = Boolean(listing && answerable(listing.status));
  const saved = readPreviewCookie(jar.get(SERVICER_COOKIE)?.value);
  const staged = open && viewer && saved && saved.listingId === listingId ? await stagedReport(viewer.id, saved) : null;
  const hidden = (
    <>
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="from" value={from} />
      {loanId && <input type="hidden" name="loan" value={loanId} />}
    </>
  );
  const Heading = nested ? "h3" : "h2";
  const sub = nested ? "h4" : "h3";
  return (
    <section id="servicer-report" className={nested ? "mt-8 scroll-mt-6" : "mt-8 scroll-mt-6 border border-border p-5 rounded-xl"} aria-labelledby="servicer-report-heading">
      <Heading id="servicer-report-heading" className={nested ? "text-[13px] font-medium text-foreground" : "eyebrow"}>Servicer report</Heading>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Upload the servicer&apos;s export for this listing. Rows match its loans by loan number, then by street and ZIP. Blank fields are filled, fields that agree carry the report&apos;s badge, and a field that differs opens a question for the seller. You see every change before anything is saved.
      </p>
      {!open ? (
        <p className="mt-3 text-sm text-muted-foreground">This listing is in contract or closed, so a servicer report can&apos;t change its tape here.</p>
      ) : staged ? <StagedPreview staged={staged} hidden={hidden} sub={sub} /> : (
        <form action={previewServicerReport} className="mt-4 grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2">
          {hidden}
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Where the report comes from</span>
            <select name="source" required defaultValue="" className="desk-input mt-2">
              <option value="" disabled>Choose</option>
              <optgroup label="Servicer">
                {SERVICER_SOURCES.filter((row) => row.kind === "servicer").map((row) => <option key={row.value} value={row.value}>{row.label}</option>)}
              </optgroup>
              <optgroup label="Software the holder runs">
                {SERVICER_SOURCES.filter((row) => row.kind === "holder").map((row) => <option key={row.value} value={row.value}>{row.label}</option>)}
              </optgroup>
            </select>
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Name, if it isn&apos;t listed</span>
            <input name="sourceName" className="desk-input mt-2" maxLength={28} autoComplete="off" />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-[13px] text-muted-foreground">Servicer&apos;s export</span>
            <input type="file" name="file" required accept=".csv,.xlsx,.xls" className="mt-2 block w-full text-sm" />
          </label>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            A third-party servicer&apos;s report reads as &ldquo;Servicer report&rdquo; on each field it supports. Software the holder runs, such as Terra Notes or NoteSmith, is the holder&apos;s own record and reads as seller-stated.
          </p>
          <div className="sm:col-span-2"><SubmitButton className="h-9 text-[13px] font-medium" pendingLabel="Reading…">Preview the changes</SubmitButton></div>
        </form>
      )}
    </section>
  );
}

function StagedPreview({ staged, hidden, sub: Sub }: { staged: StagedReport; hidden: React.ReactNode; sub: "h3" | "h4" }) {
  const { preview, source } = staged;
  const totals = preview.totals;
  const changed = preview.loans.filter((loan) => loan.lines.some((line) => line.action !== "confirm"));
  const quiet = preview.loans.length - changed.length;
  const value = (field: string, raw: string | null) => {
    const spec = fieldSpec(field);
    return spec ? displayValue(spec, raw) : raw ?? "—";
  };
  return (
    <div className="mt-4 space-y-5">
      <div>
        <p className="text-sm font-medium text-foreground">{staged.filename} · {source.kind === "servicer" ? `Servicer report · ${source.name}` : `Holder's servicing software · ${source.name}`}</p>
        <dl className="mt-3 grid grid-cols-2 gap-px bg-muted sm:grid-cols-5">
          {[
            ["Rows matched", `${totals.matched} of ${totals.rows}`],
            ["Blanks filled", String(totals.fill)],
            ["Balances updated", String(totals.update)],
            ["Fields agree", String(totals.confirm)],
            ["Questions opened", String(totals.differ)],
            ["Loans without a row", String(preview.missing.length)],
          ].map(([k, v]) => (
            <div key={k} className="bg-card/80 px-3 py-2">
              <dt className="text-xs font-medium text-muted-foreground">{k}</dt>
              <dd className="mt-1 text-lg font-semibold tracking-tight text-foreground tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">
          Columns read: {preview.columns.map((column) => `${column.label} (${column.header})`).join(", ") || "none"}.
          {preview.unused.length > 0 && ` Not used: ${preview.unused.slice(0, 12).join(", ")}${preview.unused.length > 12 ? ", and more" : ""}.`}
        </p>
      </div>

      {changed.length > 0 && (
        <div>
          <Sub className="text-[13px] font-medium text-foreground">What changes</Sub>
          <ul className="mt-2 space-y-3">
            {changed.slice(0, SHOWN_LOANS).map((loan) => (
              <li key={loan.noteId} className="rounded-lg border border-border p-3">
                <p className="text-sm text-foreground">{loan.label}</p>
                <p className="text-xs text-muted-foreground tabular-nums">Row {loan.row} · matched by {loan.by === "loanNumber" ? "loan number" : "street and ZIP"} · {loan.lines.filter((line) => line.action === "confirm").length} fields agree</p>
                <ul className="mt-2 space-y-1 text-sm">
                  {loan.lines.filter((line) => line.action !== "confirm").map((line) => (
                    <li key={line.field} className="flex flex-wrap items-center gap-2">
                      <span className="text-muted-foreground">{line.label}</span>
                      <span className="text-foreground tabular-nums">{line.tape == null ? value(line.field, line.report) : `${value(line.field, line.tape)} on the tape, ${value(line.field, line.report)} in the report`}</span>
                      <Tag tone={ACTION_TAGS[line.action].tone}>{ACTION_TAGS[line.action].text}</Tag>
                      {line.note && <span className="text-xs text-muted-foreground">{line.note}</span>}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          {changed.length > SHOWN_LOANS && <p className="mt-2 text-xs text-muted-foreground tabular-nums">And {changed.length - SHOWN_LOANS} more loans with changes.</p>}
        </div>
      )}
      {quiet > 0 && <p className="text-sm text-muted-foreground tabular-nums">{quiet === 1 ? "1 more matched loan agrees" : `${quiet} more matched loans agree`} with the report on every field it carries.</p>}

      {preview.unmatched.length > 0 && (
        <div>
          <Sub className="text-[13px] font-medium text-foreground">Rows that matched no loan</Sub>
          <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground tabular-nums">
            {preview.unmatched.slice(0, 20).map((row) => <li key={row.row}>Row {row.row} · {row.label} · {row.reason}</li>)}
          </ul>
          {preview.unmatched.length > 20 && <p className="mt-1 text-xs text-muted-foreground tabular-nums">And {preview.unmatched.length - 20} more.</p>}
        </div>
      )}
      {preview.missing.length > 0 && (
        <div>
          <Sub className="text-[13px] font-medium text-foreground">Loans the report doesn&apos;t cover</Sub>
          <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
            {preview.missing.slice(0, 20).map((loan) => <li key={loan.noteId}>{loan.label}</li>)}
          </ul>
          {preview.missing.length > 20 && <p className="mt-1 text-xs text-muted-foreground tabular-nums">And {preview.missing.length - 20} more.</p>}
        </div>
      )}
      {preview.notes.length > 0 && (
        <div>
          <Sub className="text-[13px] font-medium text-foreground">Values left off</Sub>
          <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground tabular-nums">
            {preview.notes.slice(0, 12).map((note, index) => <li key={`${note.row}-${index}`}>Row {note.row}: {note.message}</li>)}
          </ul>
          {preview.notes.length > 12 && <p className="mt-1 text-xs text-muted-foreground tabular-nums">And {preview.notes.length - 12} more.</p>}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <form action={applyServicerReport}>
          {hidden}
          <input type="hidden" name="token" value={staged.token} />
          <ConfirmSubmit
            title={`Apply the ${source.name} report?`}
            consequence={`${totals.fill} blank fields are filled and ${totals.confirm} carry the report's badge. ${totals.update} moving balances take the report's newer figure. ${totals.differ} differences open as questions for the seller. The file is kept with the listing's tape, and the import is logged.`}
            confirmLabel="Apply the report"
            pendingLabel="Applying…"
            className="h-9 text-[13px] font-medium"
          >
            Apply the report
          </ConfirmSubmit>
        </form>
        <form action={discardServicerReport}>
          {hidden}
          <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Setting aside…">Set it aside</SubmitButton>
        </form>
      </div>
    </div>
  );
}

function itemTitle(item: CollateralRow) {
  if (!isChainKind(item.kind)) return item.detail || "No detail";
  if (item.status === "NOT_REQUIRED") return `Not required${item.detail ? ` · ${chainParties(item.detail).note || item.detail}` : ""}`;
  const parties = chainParties(item.detail);
  return `${item.sequence}. ${parties.from || "Not named"} → ${parties.to || "Not named"}${parties.note ? ` · ${parties.note}` : ""}`;
}

function CollateralForm({ noteId, kind, item, documents }: { noteId: string; kind: string; item?: CollateralRow; documents: DeskDocument[] }) {
  const chain = isChainKind(kind);
  const parties = chainParties(item?.detail);
  return (
    <form action={saveCollateral} className="mt-3 grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="noteId" value={noteId} />
      <input type="hidden" name="kind" value={kind} />
      {item && <input type="hidden" name="itemId" value={item.id} />}
      {chain ? (
        <>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">{kind === "ALLONGE" ? "Endorsed by" : "Assignor"}</span>
            <input name="from" defaultValue={parties.from} className="desk-input mt-2" maxLength={120} />
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">{kind === "ALLONGE" ? "Endorsed to, or in blank" : "Assignee"}</span>
            <input name="to" defaultValue={parties.to} className="desk-input mt-2" maxLength={120} />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-[13px] text-muted-foreground">Note</span>
            <input name="note" defaultValue={parties.note} className="desk-input mt-2" maxLength={200} placeholder="Wrong loan number, unsigned, or why none is needed" />
          </label>
        </>
      ) : (
        <label className="block sm:col-span-2">
          <span className="text-[13px] text-muted-foreground">What the desk saw</span>
          <textarea name="detail" defaultValue={item?.detail ?? ""} className="desk-input mt-2 min-h-16" maxLength={400} />
        </label>
      )}
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Status</span>
        <select name="status" defaultValue={item?.status ?? "PRESENT"} className="desk-input mt-2">
          {COLLATERAL_STATUSES.map((row) => <option key={row.value} value={row.value}>{row.label}</option>)}
        </select>
      </label>
      <DocumentSelect documents={documents} value={item?.documentId ?? ""} />
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Cure owner</span>
        <input name="cureOwner" defaultValue={item?.cureOwner ?? ""} className="desk-input mt-2" maxLength={120} placeholder="Seller, custodian, desk" />
      </label>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Cure by</span>
        <input type="date" name="cureBy" defaultValue={isoDate(item?.cureBy) ?? ""} className="desk-input mt-2" />
      </label>
      {chain && (
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Dated on the document</span>
          <input type="date" name="datedOn" defaultValue={isoDate(item?.datedOn) ?? ""} className="desk-input mt-2" />
        </label>
      )}
      {kind === "ALLONGE" && (
        <>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Fixed to the note by</span>
            <input type="date" name="attachedAt" defaultValue={isoDate(item?.attachedAt) ?? ""} className="desk-input mt-2" aria-describedby={`attached-hint-${item?.id ?? "new"}`} />
            <span id={`attached-hint-${item?.id ?? "new"}`} className="mt-1 block text-xs text-muted-foreground">The earliest date the file shows it attached, such as a custodian receipt or the intake photo.</span>
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Endorsement</span>
            <select name="endorsement" defaultValue={item?.endorsement ?? ""} className="desk-input mt-2">
              <option value="">Not recorded</option>
              {ENDORSEMENTS.map((row) => <option key={row.value} value={row.value}>{row.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Loan number on it matches the note</span>
            <select name="loanNumberMatch" defaultValue={item?.loanNumberMatch == null ? "" : item.loanNumberMatch ? "yes" : "no"} className="desk-input mt-2">
              <option value="">Not checked</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
        </>
      )}
      {PHOTOGRAPHED.has(kind) && <DocumentSelect documents={documents} value={item?.photoDocumentId ?? ""} name="photoDocumentId" label="Photo of the original at intake" />}
      {RECORDED.has(kind) && (
        <>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Recording</span>
            <input name="recording" defaultValue={item?.recording ?? ""} className="desk-input mt-2" maxLength={120} placeholder="Instrument, or book and page" />
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Recorded on</span>
            <input type="date" name="recordedAt" defaultValue={isoDate(item?.recordedAt) ?? ""} className="desk-input mt-2" />
          </label>
        </>
      )}
      <div className="sm:col-span-2">
        <SubmitButton className="h-9 text-[13px] font-medium" pendingLabel="Saving…">{item ? "Save the line" : chain ? "Add the link" : "Add the line"}</SubmitButton>
      </div>
    </form>
  );
}

function DocumentSelect({ documents, value = "", name = "documentId", label = "File on record" }: { documents: DeskDocument[]; value?: string; name?: string; label?: string }) {
  return (
    <label className="block">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <select name={name} defaultValue={value} className="desk-input mt-2">
        <option value="">None</option>
        {documents.map((document) => (
          <option key={document.id} value={document.id}>{docLabel(document.type)} · {document.originalName.slice(0, 60)}{document.noteId ? "" : " · listing"}</option>
        ))}
      </select>
    </label>
  );
}

function DocumentValue({ spec, value }: { spec: FieldSpec; value: string | null }) {
  const base = "desk-input mt-2 w-52";
  if (spec.kind === "date") return <input type="date" name="document" defaultValue={value ?? ""} className={base} />;
  if (spec.kind === "money" || spec.kind === "percent" || spec.kind === "number") {
    return <input name="document" inputMode="decimal" defaultValue={value ?? ""} className={`${base} tabular-nums`} />;
  }
  if (spec.kind === "choice" || spec.kind === "bool") {
    const options = spec.kind === "bool" ? [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] : spec.options ?? [];
    return (
      <select name="document" defaultValue={value ?? ""} className={base}>
        <option value="">Not stated</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  }
  return <input name="document" defaultValue={value ?? ""} className={base} maxLength={200} />;
}

function DeskChain({ chain }: { chain: Chain }) {
  return (
    <div>
      <p className="text-sm text-foreground">{chain.label}</p>
      {chain.waived != null ? (
        <p className="mt-1 text-sm text-muted-foreground">Not required{chain.waived ? ` · ${chain.waived}` : ""}</p>
      ) : chain.links.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">Not reviewed. Add the links above, or mark the line not required.</p>
      ) : (
        <ol className="mt-1 space-y-1 text-sm">
          {chain.links.map((link) => (
            <li key={link.id}>
              {link.gap && <p className="text-xs font-medium text-bad">Break before this step</p>}
              <p className="text-foreground"><span className="text-muted-foreground tabular-nums">{link.position}.</span> {link.from || "Not named"} → {link.to || "Not named"}</p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {collateralStatusLabel(link.status)}{endorsementLabel(link.endorsement) ? ` · ${endorsementLabel(link.endorsement)?.toLowerCase()}` : ""}{link.datedOn ? ` · dated ${prettyDate(link.datedOn)}` : ""}{link.attachedAt ? ` · fixed to the note by ${prettyDate(link.attachedAt)}` : ""}{link.loanNumberMatch === true ? " · loan number matches" : ""}{link.photoDocumentId ? " · photographed at intake" : ""}{link.recordedAt ? ` · recorded ${prettyDate(link.recordedAt)}` : ""}{link.recording ? ` · ${link.recording}` : ""}{link.note ? ` · ${link.note}` : ""}
              </p>
            </li>
          ))}
        </ol>
      )}
      {chain.links.length > 0 && (
        chain.breaks.length === 0 ? (
          <p className="mt-1 text-xs text-good">No breaks found{chain.endsInBlank ? ". Ends in a blank endorsement." : "."}</p>
        ) : (
          <ul className="mt-1 space-y-0.5 text-xs text-bad">
            {chain.breaks.map((item) => <li key={item.message}>{item.message}</li>)}
          </ul>
        )
      )}
      {chain.cautions.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-warn">
          {chain.cautions.map((item) => <li key={item}>{item}</li>)}
        </ul>
      )}
    </div>
  );
}
