import { AssistantPanel } from "@/components/assistant-panel";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { aiMode } from "@/lib/desk-ai";
import { prisma } from "@/lib/prisma";
import { deskCan } from "@/lib/staff";

export const metadata = { title: "Desk assistant" };

export default async function AssistantPage() {
  // The assistant reads tapes and drafts listings for sales, and its action refuses other desk roles.
  const sells = deskCan(await requireRole(["ADMIN"]), "sales");
  const listings = await prisma.listing.findMany({
    where: { status: { in: ["SUBMITTED", "UNDER_REVIEW", "APPROVED", "PENDING"] } },
    select: { id: true, title: true },
    orderBy: { updatedAt: "desc" },
    take: 40,
  });
  return (
    <div>
      <PageIntro
        eyebrow="Assistant"
        title="A second reader."
        lede={aiMode() === "live"
          ? "An OpenAI-compatible model is configured. It summarizes a tape, explains data issues, and drafts a listing from the facts you give it."
          : "No model key is set, so the desk writes a sketch from the rows. Set LLM_API_KEY or OPENAI_API_KEY, and optionally LLM_BASE_URL and LLM_MODEL, to use a live model."}
      />
      {sells ? <AssistantPanel listings={listings} /> : <p className="mt-8 text-sm text-muted-foreground">The assistant is for the sales side of the desk.</p>}
    </div>
  );
}
