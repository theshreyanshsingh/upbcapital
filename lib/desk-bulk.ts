import { isRedirectError } from "next/dist/client/components/redirect-error";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";

// Bulk decisions from the review queue. Each listing goes through the single-listing decision, reviewListing in
// actions/admin.ts, with every gate it runs; nothing here decides anything. That action answers with a redirect,
// so the run reads each answer from the redirect: an error is a listing the desk still has to look at, a notice is
// one that went through.

export const BULK_LIMIT = 50;
export const BULK_ACTIONS = ["APPROVE", "REQUEST_CHANGES"] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

export function isBulkAction(value: unknown): value is BulkAction {
  return typeof value === "string" && (BULK_ACTIONS as readonly string[]).includes(value);
}

export type Outcome = { ok: boolean; message: string };

// What a redirect said, from its URL.
export function outcomeFromUrl(url: string): Outcome {
  const parsed = new URL(url, "http://desk.local");
  const error = parsed.searchParams.get("error");
  if (error) return { ok: false, message: error };
  const notice = parsed.searchParams.get("notice");
  if (notice) return { ok: true, message: notice };
  if (parsed.pathname === "/login" || parsed.pathname === "/") return { ok: false, message: "Your session ended. Sign in again." };
  return { ok: false, message: "The decision didn't finish. Open the listing to see why." };
}

// Runs a redirecting action and returns where it sent the desk. Any other error is a failure for this listing
// alone, so the run goes on to the next.
export async function captureOutcome(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    await run();
    return { ok: false, message: "The decision didn't finish. Open the listing to see why." };
  } catch (error) {
    if (isRedirectError(error)) return outcomeFromUrl(getURLFromRedirectError(error));
    console.error("[bulk-review]", error);
    return { ok: false, message: "Something went wrong on this listing. Open it and decide it on its own." };
  }
}

export type BulkRow = { id: string; title: string; ok: boolean; message: string };

// One listing at a time, in the order picked, so each sees the decisions before it.
export async function runBulk(listings: { id: string; title: string }[], decide: (id: string) => Promise<Outcome>) {
  const rows: BulkRow[] = [];
  for (const listing of listings) rows.push({ ...listing, ...(await decide(listing.id)) });
  return rows;
}

// The ids picked on the queue, once each, at most BULK_LIMIT.
export function pickedIds(values: FormDataEntryValue[]) {
  return [...new Set(values.map((value) => String(value)).filter((value) => /^[A-Za-z0-9_-]{1,64}$/.test(value)))].slice(0, BULK_LIMIT);
}

const VERB: Record<BulkAction, string> = { APPROVE: "Approved", REQUEST_CHANGES: "Sent back for changes" };
const NAME: Record<BulkAction, string> = { APPROVE: "approve", REQUEST_CHANGES: "request changes" };

// The queue's one-line notice after a run. The listings a gate stopped are listed below it, from the audit log.
export function bulkHead(action: BulkAction, rows: BulkRow[]) {
  const done = rows.filter((row) => row.ok).length;
  const left = rows.length - done;
  const head = `${VERB[action]} ${done} of ${rows.length}.`;
  return left ? { ok: false, text: `${head} ${left} still need${left === 1 ? "s" : ""} the desk. The reasons are below.` } : { ok: true, text: head };
}

// Each listing's audit line: "Bulk 1a2b3c4d · approve · not done · <the gate's reason>".
export function bulkDetail(run: string, action: BulkAction, row: Pick<BulkRow, "ok" | "message">) {
  return `Bulk ${run} · ${NAME[action]} · ${row.ok ? "done" : "not done"} · ${row.message}`;
}

export function isRunId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}$/.test(value);
}

export function runPrefix(run: string) {
  return `Bulk ${run} · `;
}

// The audit line read back for the queue's results.
export function parseBulkDetail(detail: string) {
  const [, , outcome, ...rest] = detail.split(" · ");
  return { ok: outcome === "done", message: rest.join(" · ") };
}
