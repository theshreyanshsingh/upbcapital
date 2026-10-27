import { canReadThreadFile } from "@/lib/acl";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getBytes } from "@/lib/storage";
import { attachmentName } from "@/lib/uploads";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getCurrentUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const file = await prisma.threadFile.findUnique({
    where: { id },
    include: { post: { include: { thread: { include: { members: true } } } } },
  });
  if (!file) return new Response("Not found.", { status: 404 });
  const allowed = canReadThreadFile({
    role: user.role,
    userId: user.id,
    memberIds: file.post.thread.members.map((member) => member.userId),
  });
  if (!allowed) return new Response("Closed.", { status: 403 });
  const bytes = await getBytes(file.storageKey);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": file.mime || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${attachmentName(file.originalName)}"`,
    },
  });
}
