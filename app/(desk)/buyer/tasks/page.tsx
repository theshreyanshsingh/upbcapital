import Link from "next/link";
import { redirect } from "next/navigation";
import { DueLine, PRIVATE_LINE, TaskToggle } from "@/components/firm-workspace";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { StatusPill } from "@/components/status-pill";
import { requireRole } from "@/lib/auth";
import { myTasks, openTasksText, workspaceOf } from "@/lib/firm-workspace";
import { q } from "@/lib/format";

export const metadata = { title: "My tasks" };

// The diligence tasks assigned to the person signed in, across the listings their firm is working, by listing. The
// rest of the firm's tasks and its notes sit on each listing's Firm notes tab.
export default async function MyTasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireRole(["BUYER"]);
  if (user.accountStatus !== "APPROVED") redirect("/buyer/pending");
  const params = await searchParams;
  const groups = await myTasks(user);
  // A view-only seat reads its list without the checks.
  const canWrite = workspaceOf(user)?.canWrite ?? false;
  return (
    <div className="max-w-3xl">
      <PageIntro
        eyebrow="My tasks"
        title="What's on your list."
        lede={`The open diligence tasks assigned to you, by listing. Your firm's notes and its other tasks are on each listing's Firm notes tab. ${PRIVATE_LINE}`}
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      {groups.length === 0 ? (
        <p className="mt-4 border border-border px-4 py-6 text-sm text-muted-foreground rounded-xl">
          Nothing assigned to you. When someone on your firm gives you a task on a listing, it shows here.{" "}
          <Link href="/marketplace" className="text-link">Open the book</Link>.
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          {groups.map((group) => (
            <section key={group.listing.id} aria-labelledby={`tasks-${group.listing.id}`} className="min-w-0 border border-border rounded-xl">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-3">
                <h2 id={`tasks-${group.listing.id}`} className="min-w-0 break-words text-base font-semibold tracking-tight text-foreground">
                  <Link href={`/marketplace/${group.listing.id}?tab=firm#firm-tasks`} className="hover:text-link">{group.listing.title}</Link>
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                  {group.listing.status !== "APPROVED" && <StatusPill status={group.listing.status} />}
                  <span className="text-[13px] text-muted-foreground tabular-nums">{openTasksText(group.tasks.length)}</span>
                </div>
              </div>
              <ul className="divide-y divide-border">
                {group.tasks.map((task) => (
                  <li key={task.id} className="flex items-start gap-3 px-4 py-3">
                    <TaskToggle task={task} canWrite={canWrite} listingId={group.listing.id} from="tasks" />
                    <div className="min-w-0 flex-1 pt-0.5">
                      <p className="break-words text-sm text-foreground">{task.title}</p>
                      <p className="mt-0.5 text-[13px] text-muted-foreground">{task.dueAt ? <DueLine task={task} /> : "No due date"}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
