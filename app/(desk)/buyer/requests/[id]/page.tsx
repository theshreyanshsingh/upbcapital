import Link from "next/link";
import { notFound } from "next/navigation";
import { editBuyerRequest } from "@/actions/bids-wanted";
import { RequestForm } from "@/components/bids-wanted";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { buyerRequest } from "@/lib/bids-wanted";
import { bidEntities } from "@/lib/buyer-entities";
import { q } from "@/lib/format";

export const metadata = { title: "Edit request" };

// One of the firm's requests to edit. Saving sets a new expiry from that day, so an expired request comes back here.
export default async function EditBuyerRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["BUYER"]);
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const [request, entities] = await Promise.all([buyerRequest(user.id, id), bidEntities(user.id)]);
  if (!request) notFound();
  const editable = request.status === "OPEN" || request.status === "PAUSED";
  return (
    <div className="max-w-2xl">
      <Link href={`/buyer/requests#request-${request.id}`} className="inline-flex min-h-10 items-center text-[13px] font-medium text-link">Back to requests</Link>
      <PageIntro eyebrow="Edit request" title="Change what you ask for." lede={request.title} />
      <Notice notice={q(query, "notice")} error={q(query, "error")} />
      {editable ? (
        <div className="glass mt-6 p-5">
          <RequestForm action={editBuyerRequest} request={request} entities={entities} submitLabel="Save the request" />
        </div>
      ) : (
        <p className="mt-6 text-sm text-muted-foreground">This request is filled or closed, so it stays as it was. Post a new one from your requests.</p>
      )}
    </div>
  );
}
