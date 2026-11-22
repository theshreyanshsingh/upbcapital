"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { unset } from "@/lib/db-filters";
import { noticeAccountIds } from "@/lib/seats";

export async function markNotificationsRead() {
  const user = await requireUser();
  await prisma.notification.updateMany({
    where: { userId: { in: noticeAccountIds(user) }, ...unset("readAt") },
    data: { readAt: new Date() },
  });
  revalidatePath("/notifications");
  redirect("/notifications?notice=read");
}
