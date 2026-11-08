"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDesk } from "@/lib/staff";
import { extensionOf } from "@/lib/storage";
import { MAX_TIE_OUT_BYTES, runTieOut } from "@/lib/tie-out";
import { uploadProblem } from "@/lib/uploads";

// The closings side of the desk runs the tie-out. The action is an endpoint, so it checks the role itself.

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function back(page: string, kind: "notice" | "error", message: string): never {
  redirect(`${page}?${kind}=${encodeURIComponent(message)}#tie-out`);
}

export async function tieOutClosingTape(formData: FormData) {
  const closingId = text(formData, "closingId");
  const page = /^[a-z0-9]{10,40}$/i.test(closingId) ? `/closings/${closingId}` : "/closings";
  const user = await requireDesk("closings", page);
  const file = formData.get("file");
  if (!(file instanceof File) || file.size <= 0) back(page, "error", "Attach the tape as of closing, as a CSV or Excel file.");
  const ext = extensionOf(file.name);
  if (ext !== "csv" && ext !== "xlsx" && ext !== "xls") back(page, "error", "Use the servicer's CSV or Excel export, or a CSV tape.");
  const bytes = Buffer.from(await file.arrayBuffer());
  const problem = uploadProblem(file.name, bytes.length, bytes, MAX_TIE_OUT_BYTES);
  if (problem) back(page, "error", problem);
  const result = await runTieOut(user, { closingId, source: text(formData, "source"), sourceName: text(formData, "sourceName"), filename: file.name, bytes });
  if (!result.ok) back(page, "error", result.error);
  revalidatePath(page);
  const totals = result.value.totals;
  const flagged = totals.changed + totals.paidOff + totals.missing;
  back(page, "notice", flagged ? `Tie-out saved. ${flagged} of ${totals.loans} loans differ from the bid tape. Both sides were told.` : `Tie-out saved. All ${totals.loans} loans agree with the bid tape. Both sides were told.`);
}
