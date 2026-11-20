"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { MAX_BID_TAPE_BYTES, placeBidTape, readUploadedTape, type BidTapePreview } from "@/lib/bid-tape";
import { extensionOf } from "@/lib/storage";
import { uploadProblem } from "@/lib/uploads";

// The pool bid form's bid tape: read the upload into a preview, then place the bid the buyer confirms. The work is in
// lib/bid-tape.ts; the bid itself goes through lib/bid-form.ts like a typed one.

export type BidTapeState = { error: string; problems: string[]; preview: BidTapePreview | null };

const failed = (error: string): BidTapeState => ({ error, problems: [], preview: null });

export async function previewBidTape(_prev: BidTapeState, formData: FormData): Promise<BidTapeState> {
  const user = await requireUser();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size <= 0) return failed("Choose your bid tape, as a CSV or Excel file.");
  const ext = extensionOf(file.name);
  if (ext !== "csv" && ext !== "xlsx" && ext !== "xls") return failed("Use a CSV or Excel file, such as the bid template.");
  const bytes = Buffer.from(await file.arrayBuffer());
  const problem = uploadProblem(file.name, bytes.length, bytes, MAX_BID_TAPE_BYTES);
  if (problem) return failed(problem);
  const read = await readUploadedTape(user, String(formData.get("listingId") || ""), { bytes, filename: file.name });
  if (read.error !== null) return { error: read.error, problems: read.problems, preview: null };
  return { error: "", problems: [], preview: read.preview };
}

export async function submitBidTape(formData: FormData) {
  const user = await requireUser();
  if (user.role !== "BUYER") redirect("/");
  if (user.accountStatus !== "APPROVED") redirect("/buyer/pending");
  const back = `/marketplace/${String(formData.get("listingId") || "")}`;
  const result = await placeBidTape(user, formData);
  if (result.error !== null) redirect(result.redirect);
  revalidatePath("/admin/offers");
  if (result.heldId) {
    revalidatePath("/account/team");
    redirect(`${back}?notice=${encodeURIComponent("Your bid is above your limit, so it is waiting for an approving seat. Nothing is placed until one approves it.")}#offer`);
  }
  redirect(`${back}?notice=inquiry`);
}
