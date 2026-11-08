import Link from "next/link";
import { DiscrepancyLog } from "@/components/discrepancy-log";
import { changeLog, type DiscrepancyRow } from "@/lib/discrepancies";
import { isENote } from "@/lib/enotes";
import { prettyDate } from "@/lib/format";
import { docLabel } from "@/lib/labels";
import {
  chainOfTitle,
  collateralLines,
  collateralStatusLabel,
  completeness,
  cureCountdown,
  displayValue,
  endorsementLabel,
  fieldSpec,
  fieldState,
  inlineSource,
  isChainKind,
  latestChecks,
  LOAN_FIELDS,
  originLabel,
  RISK_KINDS,
  riskResultLabel,
  superLien,
  tapeValue,
  type Chain,
  type CollateralRow,
  type FieldState,
  type RiskRow,
} from "@/lib/loan-file";
import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";

type Tone = "good" | "warn" | "bad" | "plain" | "source";

const TONES: Record<Tone, string> = {
  good: "bg-good/10 text-good",
  warn: "bg-warn/12 text-warn",
  bad: "bg-bad/10 text-bad",
  plain: "bg-muted text-muted-foreground",
  // A third party's record: stronger than the seller's word, short of the desk's check.
  source: "bg-link/10 text-link",
};

export function Tag({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  return <span title={title} className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", TONES[tone])}>{children}</span>;
}

export function collateralTone(status: string): Tone {
  if (status === "PRESENT") return "good";
  if (status === "MISSING" || status === "DEFECTIVE") return "bad";
  return "plain";
}

export function riskTone(result: string | null | undefined): Tone {
  if (result === "CLEAR") return "good";
  if (result === "FLAG") return "bad";
  if (result === "UNKNOWN") return "warn";
  return "plain";
}

// The fact's provenance in words. A value the viewer can't see stays out of the badge too.
// A servicer's report reads "Servicer report · FCI · Nov 6, 2026". The holder's own software reads as its word, so
// it takes the seller-stated colour.
export function FieldBadge({ field, state, showValue }: { field: string; state: FieldState; showValue: boolean }) {
  const spec = fieldSpec(field);
  if (state.state === "verified") return <Tag tone="good">Desk-verified against {inlineSource(state.source)} · {prettyDate(state.at)}</Tag>;
  if (state.state === "sourced") {
    return <Tag tone={state.origin === "servicer" ? "source" : "plain"}>{originLabel(state.origin, state.source)} · {prettyDate(state.at)}</Tag>;
  }
  if (state.state === "disputed") {
    const where = state.origin ? originLabel(state.origin, state.source) : state.source;
    return (
      <Tag tone="warn">
        {showValue && spec ? `${where} shows ${displayValue(spec, state.document)}` : `Differs from the ${inlineSource(where)}`} · {state.origin ? "read" : "checked"} {prettyDate(state.at)}
      </Tag>
    );
  }
  if (state.changed) {
    const after = state.changed.origin ? `the ${state.changed.origin === "servicer" ? "servicer report" : "holder's software"}` : "the desk's check";
    return <Tag tone="plain">Seller-stated · changed after {after} of {prettyDate(state.changed.at)}</Tag>;
  }
  return <Tag tone="plain">Seller-stated</Tag>;
}

type LoanRecord = { id: string; listingId?: string; state: string; propertyType: string; lienPosition: string; hoaLien?: boolean | null; verifiedFields?: unknown } & object;

// "Cure by Dec 1, 2026 · 26 days to cure", with an overdue cure in the bad colour.
export function CureBy({ cureBy, owner }: { cureBy: Date; owner?: string }) {
  const countdown = cureCountdown(cureBy);
  return (
    <span className="tabular-nums">
      Cure by {prettyDate(cureBy)}{owner ? ` · ${owner}` : ""}
      {countdown && <span className={countdown.overdue ? "font-medium text-bad" : undefined}> · {countdown.text}</span>}
    </span>
  );
}

const ADDRESS = new Set(["streetAddress", "borrowerName"]);

// The note's facts with where each one came from. Identity fields follow the loan's rule; balances follow Pro.
// A single listing already shows its street and borrower above, so it leaves them out here.
export function LoanFacts({ note, open, pro, withAddress, title = "The note" }: { note: LoanRecord; open: boolean; pro: boolean; withAddress: boolean; title?: string }) {
  const rows = LOAN_FIELDS.filter((spec) => (withAddress || !ADDRESS.has(spec.field)) && (!spec.optional || tapeValue(note, spec.field) != null));
  return (
    <section className="mt-8">
      <p className="eyebrow">{title}</p>
      <dl className="mt-4 grid gap-px bg-muted sm:grid-cols-2">
        {rows.map((spec) => {
          const hidden = spec.identity && !open;
          const veiled = spec.pro && !pro;
          const value = hidden ? "Withheld until confidentiality" : veiled ? "—" : displayValue(spec, tapeValue(note, spec.field));
          return (
            <div key={spec.field} className="bg-card/80 px-4 py-3">
              <dt className="text-xs font-medium text-muted-foreground">{spec.label}</dt>
              <dd className="mt-1 text-foreground tabular-nums">{value}</dd>
              <dd className="mt-1.5"><FieldBadge field={spec.field} state={fieldState(note, spec.field)} showValue={!hidden && !veiled} /></dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

type FileDocument = { id: string; type: string; originalName: string; createdAt: Date };

export async function LoanFileView({
  note,
  collateral,
  risks,
  documents,
  open,
  docsOpen,
  docGate,
  holder,
  pro,
  facts,
  heading,
  nav,
  discrepancies,
  listedAt,
}: {
  note: LoanRecord;
  collateral: CollateralRow[];
  risks: RiskRow[];
  documents: FileDocument[];
  // The loan's street and borrower are open to this viewer. Detail text and chain parties follow it.
  open: boolean;
  // The loan's own files open to this viewer: the loan is open and they are Pro or buying it.
  docsOpen: boolean;
  docGate: string;
  holder: string | null;
  pro: boolean;
  facts: boolean;
  heading: string;
  nav?: { previous: string | null; next: string | null; position: string };
  // This loan's tape differences and when the listing was filed. Loaded here when the page doesn't pass them.
  discrepancies?: DiscrepancyRow[];
  listedAt?: Date | null;
}) {
  const [rows, filed] = await Promise.all([
    discrepancies ?? prisma.fieldDiscrepancy.findMany({ where: { noteId: note.id } }),
    listedAt !== undefined || !note.listingId
      ? listedAt ?? null
      : prisma.listing.findUnique({ where: { id: note.listingId }, select: { submittedAt: true } }).then((row) => row?.submittedAt ?? null),
  ]);
  // A chain that ends with someone other than the seller counts for everyone. Only the names stay hidden.
  const file = completeness(note, collateral, risks, { holder });
  const lines = collateralLines(note.lienPosition, collateral, { eNote: isENote(note) });
  const chain = chainOfTitle(collateral, holder, { listedAt: filed });
  const latest = latestChecks(risks);
  const flag = superLien(note);
  const defects = file.defects.length + file.chainBreaks;
  return (
    <section id="loan-file" className="mt-10 glass p-6 scroll-mt-6" aria-labelledby="loan-file-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="loan-file-heading" className="eyebrow">Loan file</h2>
        {nav && (
          <nav aria-label="Loans in this pool" className="flex items-center gap-3 text-[13px] font-medium">
            {nav.previous ? <Link className="text-link" href={nav.previous}>Previous loan</Link> : <span className="text-muted-foreground">Previous loan</span>}
            <span className="text-muted-foreground tabular-nums">{nav.position}</span>
            {nav.next ? <Link className="text-link" href={nav.next}>Next loan</Link> : <span className="text-muted-foreground">Next loan</span>}
          </nav>
        )}
      </div>
      <p className="mt-2 text-sm font-medium text-foreground">{heading}</p>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        The UPB desk checks the paper before the price, and every bidder sees this same record. Anything not marked verified, or sourced from a servicer&apos;s report, is as the seller stated it.
      </p>
      {!file.reviewed && <p className="mt-3 text-sm text-foreground">The desk hasn&apos;t reviewed this loan&apos;s file yet.</p>}

      <dl className="mt-5 grid grid-cols-2 gap-px bg-muted sm:grid-cols-4">
        <Summary k="Collateral on file" v={`${file.collateral.present} of ${file.collateral.required}`} hint={collateralHint(file.collateral)} />
        <Summary k="Checks run" v={`${file.checks.run} of ${file.checks.total}`} hint={file.checks.flagged ? `${file.checks.flagged} flagged` : file.checks.unknown ? `${file.checks.unknown} unknown` : undefined} />
        <Summary k="Key fields verified" v={`${file.fields.verified} of ${file.fields.total}`} hint={fieldsHint(file)} />
        <Summary k="Open defects" v={String(defects)} hint={file.chainBreaks ? `${file.chainBreaks} in the chain of title` : undefined} />
      </dl>

      {flag && (
        <p className="mt-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Tag tone="warn" title={flag.cite}>{flag.label} · {flag.state}</Tag>
          <span>
            In {flag.state}, an association&apos;s lien for some months of unpaid dues can outrank this mortgage
            {flag.certain ? "." : ", if the property sits in an HOA."}
          </span>
        </p>
      )}

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div>
          <h3 className="text-[13px] font-medium text-foreground">Collateral</h3>
          <ul className="mt-2 divide-y divide-border text-sm">
            {lines.map((line) =>
              line.items.length === 0 ? (
                <li key={line.kind} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="text-foreground">{line.label}{line.required || line.reason ? "" : " · optional"}</span>
                  <Tag tone="plain" title={line.reason}>{line.reason ? "Not required for an eNote" : "Not reviewed"}</Tag>
                </li>
              ) : (
                line.items.map((item) => (
                  <li key={item.id} className="py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-foreground">{line.label}{isChainKind(item.kind) && item.status !== "NOT_REQUIRED" ? ` ${item.sequence}` : ""}</span>
                      <Tag tone={collateralTone(item.status)}>{collateralStatusLabel(item.status)}</Tag>
                    </div>
                    {(item.status === "MISSING" || item.status === "DEFECTIVE") && item.cureBy && (
                      <p className="mt-1 text-xs text-muted-foreground"><CureBy cureBy={item.cureBy} owner={open ? item.cureOwner : undefined} /></p>
                    )}
                    {open && !isChainKind(item.kind) && item.detail && <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>}
                  </li>
                ))
              ),
            )}
          </ul>
        </div>

        <div>
          <h3 className="text-[13px] font-medium text-foreground">Risk card</h3>
          <ul className="mt-2 divide-y divide-border text-sm">
            {RISK_KINDS.map(({ kind, label }) => {
              const check = latest[kind];
              return (
                <li key={kind} className="py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-foreground">{label}</span>
                    <Tag tone={riskTone(check?.result)}>{check ? riskResultLabel(check.result) : "Not run"}</Tag>
                  </div>
                  {check && <p className="mt-1 text-xs text-muted-foreground tabular-nums">{check.source} · {prettyDate(check.checkedAt)}</p>}
                  {check && open && check.detail && <p className="mt-1 text-xs text-muted-foreground">{check.detail}</p>}
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div className="mt-8">
        <h3 className="text-[13px] font-medium text-foreground">Chain of title</h3>
        <div className="mt-2 grid gap-6 lg:grid-cols-2">
          <ChainSummary chain={chain.endorsements} open={open} />
          <ChainSummary chain={chain.assignments} open={open} />
        </div>
        {chain.cautions.map((item) => <p key={item} className="mt-2 text-xs text-warn">{item}</p>)}
        {!open && <p className="mt-3 text-xs text-muted-foreground">Party names open with the loan&apos;s street and borrower.</p>}
      </div>

      <DiscrepancyLog entries={changeLog(rows, { open, pro })} />

      {documents.length > 0 && (
        <div className="mt-8">
          <h3 className="text-[13px] font-medium text-foreground">Reports on this loan</h3>
          <ul className="mt-2 divide-y divide-border border border-border rounded-xl">
            {documents.map((document) => (
              <li key={document.id} className="flex items-center justify-between gap-3 px-4 py-3">
                {/* File names can carry a borrower or a street, so they show only to someone who can open the file. */}
                <div>
                  <p className="text-sm text-foreground">{docsOpen ? document.originalName : docLabel(document.type)}</p>
                  <p className="text-[13px] font-medium text-muted-foreground tabular-nums">{docsOpen ? `${docLabel(document.type)} · ` : ""}{prettyDate(document.createdAt)}</p>
                </div>
                {docsOpen ? (
                  <a className="text-[13px] font-medium text-link" href={`/api/documents/${document.id}`}>Download</a>
                ) : (
                  <span className="text-[13px] font-medium text-muted-foreground">{docGate}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {facts && <LoanFacts note={note} open={open} pro={pro} withAddress title="This loan's facts" />}
    </section>
  );
}

function fieldsHint(file: { fields: { disputed: number }; sourced: number }) {
  const parts = [
    file.fields.disputed ? `${file.fields.disputed} ${file.fields.disputed === 1 ? "differs" : "differ"} from the tape` : "",
    file.sourced ? `${file.sourced} from a servicer report` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

function collateralHint(counts: { missing: number; defective: number; unreviewed: number }) {
  const parts = [
    counts.missing ? `${counts.missing} missing` : "",
    counts.defective ? `${counts.defective} defective` : "",
    counts.unreviewed ? `${counts.unreviewed} not reviewed` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

function Summary({ k, v, hint }: { k: string; v: string; hint?: string }) {
  return (
    <div className="bg-card/80 px-4 py-3">
      <dt className="text-xs font-medium text-muted-foreground">{k}</dt>
      <dd className="mt-1 text-lg font-semibold tracking-tight text-foreground tabular-nums">{v}</dd>
      {hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}

function ChainSummary({ chain, open }: { chain: Chain; open: boolean }) {
  const noun = chain.kind === "ALLONGE" ? "endorsement" : "assignment";
  return (
    <div>
      <p className="text-sm text-foreground">{chain.label}</p>
      {chain.waived != null ? (
        <p className="mt-1 text-sm text-muted-foreground">Not required{open && chain.waived ? ` · ${chain.waived}` : ""}</p>
      ) : chain.links.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">Not reviewed</p>
      ) : open ? (
        <ol className="mt-1 space-y-1 text-sm">
          {chain.links.map((link) => (
            <li key={link.id}>
              {link.gap && <p className="text-xs text-bad">Break before this step</p>}
              <p className="text-foreground">
                <span className="text-muted-foreground tabular-nums">{link.position}.</span> {link.from || "Not named"} → {link.to || "Not named"}
              </p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {collateralStatusLabel(link.status)}{endorsementLabel(link.endorsement) ? ` · ${endorsementLabel(link.endorsement)?.toLowerCase()}` : ""}{link.datedOn ? ` · dated ${prettyDate(link.datedOn)}` : ""}{link.attachedAt ? ` · fixed to the note by ${prettyDate(link.attachedAt)}` : ""}{link.loanNumberMatch ? " · loan number matches" : ""}{link.photoDocumentId ? " · photographed at intake" : ""}{link.recordedAt ? ` · recorded ${prettyDate(link.recordedAt)}` : ""}{link.recording ? ` · ${link.recording}` : ""}
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground tabular-nums">{chain.links.length} {noun}{chain.links.length === 1 ? "" : "s"} on file</p>
      )}
      {chain.links.length > 0 && (
        chain.breaks.length === 0 ? (
          <p className="mt-1 text-xs text-good">No breaks found{chain.endsInBlank ? ". Ends in a blank endorsement." : "."}</p>
        ) : open ? (
          <ul className="mt-1 space-y-0.5 text-xs text-bad">
            {chain.breaks.map((item) => <li key={item.message}>{item.message}</li>)}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-bad tabular-nums">{closedBreaks(chain)}</p>
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

// Without the parties, a buyer still learns how many gaps there are and how many links are missing.
function closedBreaks(chain: Chain) {
  const gaps = chain.breaks.filter((item) => !item.fromStatus).length;
  const links = chain.breaks.length - gaps;
  return [
    gaps ? `${gaps} break${gaps === 1 ? "" : "s"}` : "",
    links ? `${links} link${links === 1 ? "" : "s"} missing or defective` : "",
  ].filter(Boolean).join(" · ");
}
