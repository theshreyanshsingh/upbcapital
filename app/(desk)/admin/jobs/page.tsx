import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { prettyDate } from "@/lib/format";
import { durationText, jobHistory } from "@/lib/jobs";

export const metadata = { title: "Jobs" };

// Minutes matter for a scheduled run, so each start shows its time in UTC as well as the day.
const stamp = (at: Date) => `${prettyDate(at)} ${at.toISOString().slice(11, 16)} UTC`;

// Every desk role reads the history. Nothing here changes anything; the scheduler runs the jobs.
export default async function JobsPage() {
  await requireRole(["ADMIN"]);
  const runs = await jobHistory(50);
  const last = runs[0];
  const failures = runs.filter((run) => run.failed).length;
  return (
    <div className="max-w-5xl">
      <PageIntro
        eyebrow="Jobs"
        title="What the scheduler did."
        lede="Each run sends digests and reminders, expires bids, opens launches and sends the monthly dispatch. The latest 50 runs, newest first. A failed job is marked, and the others in its run still finished."
      />
      {last ? (
        <p role="status" className={`rounded-lg border px-4 py-3 text-sm tabular-nums ${last.failed ? "border-bad/40 bg-bad/5 text-foreground" : "border-border text-foreground"}`}>
          Last run {stamp(last.startedAt)}, {durationText(last.durationMs).toLowerCase()}.{" "}
          {last.failed ? `${last.summary.failed.length ? `Failed: ${last.summary.failed.join(", ")}.` : "It didn't finish."}` : "Every job finished."}
          {failures > 0 && ` ${failures} of the last ${runs.length} run${runs.length === 1 ? "" : "s"} had a failure.`}
        </p>
      ) : (
        <p className="rounded-xl border border-dashed border-border px-5 py-8 text-sm text-muted-foreground">No runs yet. Each scheduled run is recorded here.</p>
      )}
      <ol className="mt-6 space-y-3">
        {runs.map((run) => (
          <li key={run.id} className={`rounded-xl border p-4 md:p-5 ${run.failed ? "border-bad/40" : "border-border"}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="text-sm font-medium text-foreground tabular-nums">{stamp(run.startedAt)}</p>
              <p className="text-[13px] text-muted-foreground tabular-nums">
                {durationText(run.durationMs)}
                {" · "}
                <span className={run.failed ? "font-medium text-bad" : "text-good"}>{run.failed ? "Failed" : "Finished"}</span>
              </p>
            </div>
            {run.summary.jobs.length ? (
              <ul className="mt-3 grid gap-1.5 text-sm sm:grid-cols-2">
                {run.summary.jobs.map((job, index) => (
                  <li key={`${job.job}-${index}`} className={`min-w-0 break-words ${job.ok ? "text-muted-foreground" : "font-medium text-bad"}`}>
                    {!job.ok && <span className="sr-only">Failed: </span>}
                    {job.line}
                    {job.ms != null && job.ms >= 1000 && <span className="text-xs text-muted-foreground"> · {durationText(job.ms).toLowerCase()}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">No summary was recorded.</p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
