"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { unset } from "@/lib/db-filters";

export async function markNotificationsRead() {
  const user = await requireUser();
  await prisma.notification.updateMany({
    where: { AND: [unset("readAt"), { OR: [{ userId: user.id }, { toEmail: user.email }] }] },
    data: { readAt: new Date() },
  });
  revalidatePath("/notifications");
  redirect("/notifications?notice=read");
}
