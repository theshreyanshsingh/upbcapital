"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { secureCookies } from "@/lib/deploy";
import { guardDesk } from "@/lib/staff";
import {
  IMPORT_COOKIE,
  MAX_IMPORT_BYTES,
  OWNED_NOTE_REQUIRED,
  OWNED_NOTE_YIELD,
  importBook,
  ownedNoteProblems,
  previewImport,
  readAcquired,
  undoImport,
} from "@/lib/portfolio-import";
import { emailYearStatement, readReceiptSplit } from "@/lib/portfolio-tax";
import { consumeRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { extensionOf } from "@/lib/storage";
import { deleteTapeDraft, readTapeDraft, saveTapeDraft } from "@/lib/tape-draft";
import { uploadProblem } from "@/lib/uploads";

function amountOf(formData: FormData) {
  const value = Number(String(formData.get("amount") || "").replace(/[$,\s]/g, ""));
  return Number.isFinite(value) ? value : NaN;
}

export async function logBuyerPayment(formData: FormData) {
  const user = await requireRole(["BUYER", "ADMIN"]);
  const holdingId = String(formData.get("holdingId") || "");
  guardDesk(user, "closings", "/buyer/portfolio");
  const holding = await prisma.buyerHolding.findUnique({ where: { id: holdingId } });
  if (!holding || (user.role !== "ADMIN" && holding.userId !== user.id)) {
    redirect("/buyer/portfolio?error=That note is not on your book.");
  }
  const paidOn = String(formData.get("paidOn") || "");
  const memo = String(formData.get("memo") || "").trim().slice(0, 240);
  // The split is optional. Without it the year-end statement estimates one from the loan and says so.
  const read = readReceiptSplit({
    amount: String(formData.get("amount") || ""),
    principal: String(formData.get("principal") || ""),
    interest: String(formData.get("interest") || ""),
    fees: String(formData.get("fees") || ""),
    escrow: String(formData.get("escrow") || ""),
  });
  if (read.error !== null) redirect(`/buyer/portfolio?error=${encodeURIComponent(read.error)}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) redirect("/buyer/portfolio?error=Amount and date are required.");
  await prisma.cashReceipt.create({
    data: { buyerHoldingId: holdingId, amount: read.amount, paidOn: new Date(`${paidOn}T00:00:00Z`), memo, source: "MANUAL", ...(read.split ?? {}) },
  });
  revalidatePath("/buyer/portfolio");
  redirect("/buyer/portfolio?notice=payment");
}

export async function addOwnedNote(formData: FormData) {
  const user = await requireRole(["BUYER"]);
  const title = String(formData.get("title") || "").trim();
  const cost = amountOf(formData);
  const upb = Number(String(formData.get("upb") || "").replace(/[$,\s]/g, ""));
  const yieldRaw = String(formData.get("underwrittenYield") || "").trim();
  const underwrittenYield = yieldRaw ? Number(yieldRaw) : null;
  const acquired = String(formData.get("acquiredAt") || "");
  // The same checks each row of an imported book passes (lib/portfolio-import.ts).
  const acquiredAt = /^\d{4}-\d{2}-\d{2}$/.test(acquired) ? readAcquired(acquired) : null;
  const problems = ownedNoteProblems({ title, cost, upb, underwrittenYield, acquiredAt });
  if (!acquiredAt || problems.some((problem) => problem.field !== "underwrittenYield")) {
    redirect(`/buyer/portfolio?error=${encodeURIComponent(OWNED_NOTE_REQUIRED)}`);
  }
  if (problems.length) redirect(`/buyer/portfolio?error=${encodeURIComponent(OWNED_NOTE_YIELD)}`);
  await prisma.buyerHolding.create({
    data: {
      userId: user.id,
      title,
      costBasis: cost,
      upb,
      underwrittenYield,
      acquiredAt,
    },
  });
  redirect("/buyer/portfolio?notice=owned");
}

export async function setBuyerHoldingStatus(formData: FormData) {
  const user = await requireRole(["BUYER", "ADMIN"]);
  const id = String(formData.get("id") || "");
  const status = String(formData.get("status") || "");
  if (!["CURRENT", "WATCH", "RESOLVED"].includes(status)) redirect("/buyer/portfolio?error=Unknown status.");
  guardDesk(user, "closings", "/buyer/portfolio");
  const holding = await prisma.buyerHolding.findUnique({ where: { id } });
  if (!holding || (user.role !== "ADMIN" && holding.userId !== user.id)) redirect("/buyer/portfolio");
  await prisma.buyerHolding.update({ where: { id }, data: { status: status as "CURRENT" } });
  redirect("/buyer/portfolio?notice=owned");
}

// The year-end statement by email, with the PDF attached. A few an hour is plenty for a buyer's own inbox.
export async function emailStatement(formData: FormData) {
  const user = await requireRole(["BUYER"]);
  const year = Number(String(formData.get("year") || ""));
  if (!(await consumeRateLimit(`statement-mail:${user.id}`, 5, 60 * 60 * 1000))) {
    redirect("/buyer/portfolio?error=That statement was sent a few times already. Try again in an hour.");
  }
  const sent = await emailYearStatement(user, year);
  if (sent.error !== null) redirect(`/buyer/portfolio?error=${encodeURIComponent(sent.error)}`);
  redirect(`/buyer/portfolio?notice=${encodeURIComponent(`Your ${year} statement is on its way to your email.`)}`);
}

// ---------------------------------------------------------------------------------------------------------------
// A whole book from a spreadsheet (lib/portfolio-import.ts). The upload is read and kept as a draft for a day, the page
// shows what would come in, and nothing is written until the buyer confirms. Figures never go in the address bar.

// Its notices show in the import section itself, which the page opens on.
function backToImport(kind: "notice" | "error" | null, message = ""): never {
  const key = kind === "notice" ? "importNotice" : "importError";
  redirect(`/buyer/portfolio${kind ? `?${key}=${encodeURIComponent(message)}` : ""}#import-book`);
}

const plural = (count: number, word: string) => `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;

// The same secure rule as the session cookie, so a plain-HTTP demo host still keeps it.
const importCookie = () => ({ httpOnly: true, sameSite: "lax" as const, secure: secureCookies(), path: "/", maxAge: 24 * 60 * 60 });

export async function previewBookImport(formData: FormData) {
  const user = await requireRole(["BUYER"]);
  const file = formData.get("file");
  if (!(file instanceof File) || file.size <= 0) backToImport("error", "Attach your book as a CSV or Excel file.");
  const ext = extensionOf(file.name);
  if (ext !== "csv" && ext !== "xlsx" && ext !== "xls") backToImport("error", "Upload the book as a CSV or Excel file.");
  const bytes = Buffer.from(await file.arrayBuffer());
  const problem = uploadProblem(file.name, bytes.length, bytes, MAX_IMPORT_BYTES);
  if (problem) backToImport("error", problem);
  // A file that can't import at all says so now, not on an empty preview.
  const read = await previewImport(user.id, file.name, bytes);
  if (!read.ok) backToImport("error", read.error);
  const jar = await cookies();
  // One staged upload at a time: a new one replaces the last.
  const earlier = jar.get(IMPORT_COOKIE)?.value;
  if (earlier && (await readTapeDraft(user.id, earlier))) await deleteTapeDraft(earlier);
  const token = crypto.randomUUID();
  await saveTapeDraft({ token, userId: user.id, filename: file.name.slice(0, 180), bytes });
  jar.set(IMPORT_COOKIE, token, importCookie());
  backToImport(null);
}

export async function confirmBookImport(formData: FormData) {
  const user = await requireRole(["BUYER"]);
  const jar = await cookies();
  const token = String(formData.get("token") || "");
  if (!token || jar.get(IMPORT_COOKIE)?.value !== token) backToImport("error", "That preview expired. Upload the file again.");
  const draft = await readTapeDraft(user.id, token);
  jar.delete(IMPORT_COOKIE);
  if (!draft) backToImport("error", "That preview expired. Upload the file again.");
  // Claimed before anything is written, so a second click can't bring the same file in twice.
  const claimed = await prisma.tapeDraft.deleteMany({ where: { token, userId: user.id } });
  if (claimed.count !== 1) backToImport("error", "That file was already imported.");
  const outcome = await importBook(user, draft);
  if (!outcome.ok) backToImport("error", outcome.error);
  const { imported, skipped, errors } = outcome.value;
  revalidatePath("/buyer/portfolio");
  backToImport(
    "notice",
    `${plural(imported, "note")} imported.${skipped ? ` ${plural(skipped, "duplicate")} already in your portfolio ${skipped === 1 ? "was" : "were"} skipped.` : ""}${errors ? ` ${plural(errors, "row")} with errors ${errors === 1 ? "was" : "were"} left out.` : ""} You can undo this import while its notes are untouched.`,
  );
}

export async function discardBookImport() {
  const user = await requireRole(["BUYER"]);
  const jar = await cookies();
  const token = jar.get(IMPORT_COOKIE)?.value;
  if (token && (await readTapeDraft(user.id, token))) await deleteTapeDraft(token);
  jar.delete(IMPORT_COOKIE);
  backToImport("notice", "The upload was set aside. Nothing was imported.");
}

// Takes back an upload's notes, except any with a payment logged, a relist or a slice sold since.
export async function undoBookImport(formData: FormData) {
  const user = await requireRole(["BUYER"]);
  const outcome = await undoImport(user, String(formData.get("batchId") || ""));
  if (!outcome.ok) backToImport("error", outcome.error);
  const { removed, kept } = outcome.value;
  revalidatePath("/buyer/portfolio");
  backToImport(
    "notice",
    `${plural(removed, "note")} removed from your portfolio.${kept ? ` ${plural(kept, "note")} ${kept === 1 ? "was" : "were"} kept, since a payment was logged or ${kept === 1 ? "it was" : "they were"} relisted after the import.` : ""}`,
  );
}
