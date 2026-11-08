"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { lockBoardMonth, monthLabel, parseMonth } from "@/lib/board-pack";
import { requireDesk } from "@/lib/staff";

function back(month: string | null, kind: "notice" | "error", message: string): never {
  redirect(`/admin/board?${month ? `month=${month}&` : ""}${kind}=${encodeURIComponent(message)}#lock`);
}

// Locking a month's board pack: an owner's job, as fees and settings are. lib/board-pack.ts checks the same.
export async function lockBoardMonthAction(formData: FormData) {
  const month = parseMonth(formData.get("month"));
  const actor = await requireDesk("admin", month ? `/admin/board?month=${month}` : "/admin/board");
  const locked = await lockBoardMonth(actor, { month, note: formData.get("note") });
  if (locked.error !== null) back(month, "error", locked.error);
  revalidatePath("/admin/board");
  const changed = locked.differences.length;
  back(
    month,
    "notice",
    locked.relocked
      ? `${monthLabel(month!)} is locked again. ${changed ? `${changed} figure${changed === 1 ? "" : "s"} changed from the earlier lock.` : "No figure changed."}`
      : `${monthLabel(month!)} is locked. The board pack now shows these figures.`,
  );
}
