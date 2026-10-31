import { canReadClosingFile } from "@/lib/acl";
import { getApiUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getBytes } from "@/lib/storage";
import { attachmentName } from "@/lib/uploads";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const file = await prisma.closingFile.findUnique({
    where: { id },
    include: { step: { include: { closing: { include: { listing: true } } } } },
  });
  if (!file) return new Response("Not found.", { status: 404 });
  const closing = file.step.closing;
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId } }) : null;
  const funders = await prisma.closingFunder.findMany({ where: { closingId: closing.id }, select: { userId: true } });
  const allowed = canReadClosingFile({
    role: user.role,
    userId: user.id,
    sellerId: closing.listing.sellerId,
    buyerId: inquiry?.buyerId ?? null,
    funderIds: funders.map((funder) => funder.userId),
  });
  if (!allowed) return new Response("Closed.", { status: 403 });
  try {
    const bytes = await getBytes(file.storageKey);
    return new Response(bytes, {
      headers: {
        "Content-Type": file.mime,
        "Content-Disposition": `attachment; filename="${attachmentName(file.originalName)}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return new Response("File missing.", { status: 404 });
  }
}
