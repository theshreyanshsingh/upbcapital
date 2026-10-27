import { NextResponse } from "next/server";
import { getBytes } from "@/lib/storage";
import { prisma } from "@/lib/prisma";
import { mimeFor, extensionOf } from "@/lib/storage";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const profile = await prisma.brokerProfile.findUnique({ where: { userId: id }, include: { user: true } });
  if (!profile || profile.user.accountStatus !== "APPROVED" || !profile.portraitKey || profile.portraitKey.startsWith("/")) {
    return new NextResponse("Not found", { status: 404 });
  }
  const bytes = await getBytes(profile.portraitKey);
  const ext = extensionOf(profile.portraitKey) || "jpg";
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": mimeFor(ext, "image/jpeg"),
      "Cache-Control": "public, max-age=3600",
    },
  });
}
