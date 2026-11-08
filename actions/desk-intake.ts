"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { secureCookies } from "@/lib/deploy";
import {
  askTapeChanges,
  confirmDeskTape,
  fileDeskIntake,
  INTAKE_COOKIE,
  intakeCookieValue,
  isSplitRule,
  MAX_INTAKE_BYTES,
  parseBands,
  planProblem,
  readIntakeCookie,
  readIntakeTape,
  type PriceMode,
} from "@/lib/desk-intake";
import { typedNumber } from "@/lib/money";
import { requireDesk } from "@/lib/staff";
import { extensionOf } from "@/lib/storage";
import { deleteTapeDraft, readTapeDraft, saveTapeDraft } from "@/lib/tape-draft";
import { uploadProblem } from "@/lib/uploads";

// Each action is a public endpoint. The desk's need the sales side of the desk; the seller's check that the caller
// is the seller of record. Figures never go in the address bar.

const PAGE = "/admin/intake";

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function back(page: string, kind: "notice" | "error" | null, message = "", anchor = ""): never {
  const query = kind ? `${page.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(message)}` : "";
  redirect(`${page}${query}${anchor ? `#${anchor}` : ""}`);
}

const cookieOptions = () => ({ httpOnly: true, sameSite: "lax" as const, secure: secureCookies(), path: PAGE, maxAge: 24 * 60 * 60 });

// Reads the tape and stages it. Nothing is filed until the desk checks the preview and files it.
export async function stageDeskIntake(formData: FormData) {
  const user = await requireDesk("sales", PAGE);
  const sellerId = text(formData, "sellerId");
  if (!/^[a-z0-9]{10,40}$/i.test(sellerId)) back(PAGE, "error", "Choose the seller's account.");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size <= 0) back(PAGE, "error", "Attach the seller's tape as a CSV or Excel file.");
  const ext = extensionOf(file.name);
  if (ext !== "csv" && ext !== "xlsx" && ext !== "xls") back(PAGE, "error", "Use a CSV or Excel tape, or the servicer's export.");
  const bytes = Buffer.from(await file.arrayBuffer());
  const problem = uploadProblem(file.name, bytes.length, bytes, MAX_INTAKE_BYTES);
  if (problem) back(PAGE, "error", problem);
  const priceMode: PriceMode = text(formData, "priceMode") === "PERCENT" ? "PERCENT" : "COLUMN";
  const percent = priceMode === "PERCENT" ? typedNumber(formData.get("percent")) : null;
  const rules = formData.getAll("rule").map(String).filter(isSplitRule);
  const bands = rules.includes("BALANCE") ? parseBands(text(formData, "bands")) : [];
  if (bands === null) back(PAGE, "error", "Write the balance edges as amounts, such as 100k, 250k. Up to six.");
  const plan = planProblem({ rules, bands });
  if (plan) back(PAGE, "error", plan);
  const read = readIntakeTape({ filename: file.name, bytes, priceMode, percent: percent ?? undefined });
  if (!read.ok) back(PAGE, "error", read.error);
  const jar = await cookies();
  // One staged tape at a time: a new upload replaces the last one.
  const earlier = readIntakeCookie(jar.get(INTAKE_COOKIE)?.value);
  if (earlier && (await readTapeDraft(user.id, earlier.token))) await deleteTapeDraft(earlier.token);
  const token = crypto.randomUUID();
  await saveTapeDraft({ token, userId: user.id, filename: file.name.slice(0, 180), bytes });
  jar.set(INTAKE_COOKIE, intakeCookieValue({ token, sellerId, priceMode, percent: percent != null && Number.isFinite(percent) ? percent : null, rules, bands }), cookieOptions());
  back(PAGE, null, "", "preview");
}

export async function fileDeskIntakeTape(formData: FormData) {
  const user = await requireDesk("sales", PAGE);
  const jar = await cookies();
  const staged = readIntakeCookie(jar.get(INTAKE_COOKIE)?.value);
  if (!staged || staged.token !== text(formData, "token")) back(PAGE, "error", "That preview expired. Upload the tape again.");
  const draft = await readTapeDraft(user.id, staged.token);
  if (!draft) {
    jar.delete({ name: INTAKE_COOKIE, path: PAGE });
    back(PAGE, "error", "That preview expired. Upload the tape again.");
  }
  const filed = await fileDeskIntake(user, {
    ...staged,
    filename: draft.filename,
    bytes: draft.bytes,
    title: text(formData, "title"),
    summary: text(formData, "summary"),
  });
  if (!filed.ok) back(PAGE, "error", filed.error, "preview");
  await deleteTapeDraft(staged.token);
  jar.delete({ name: INTAKE_COOKIE, path: PAGE });
  revalidatePath("/admin/queue");
  const count = filed.value.length;
  back(PAGE, "notice", `Filed ${count === 1 ? "one listing" : `${count} listings`} for the seller. Each waits for the seller to confirm the tape before it can be approved.`, "filed");
}

export async function discardDeskIntake() {
  const user = await requireDesk("sales", PAGE);
  const jar = await cookies();
  const staged = readIntakeCookie(jar.get(INTAKE_COOKIE)?.value);
  if (staged && (await readTapeDraft(user.id, staged.token))) await deleteTapeDraft(staged.token);
  jar.delete({ name: INTAKE_COOKIE, path: PAGE });
  back(PAGE, "notice", "The tape was set aside. Nothing was filed.");
}

// ---------------------------------------------------------------------------------------------------------------
// The seller's side

function sellerPage(listingId: string) {
  return /^[a-z0-9]{10,40}$/i.test(listingId) ? `/seller/listings/${listingId}` : "/seller";
}

export async function confirmDeskFiledTape(formData: FormData) {
  const user = await requireUser();
  const listingId = text(formData, "listingId");
  const page = sellerPage(listingId);
  const confirmed = await confirmDeskTape(user, listingId);
  if (!confirmed.ok) back(page, "error", confirmed.error, "desk-intake");
  for (const path of [page, `/admin/listings/${listingId}`, "/admin/queue"]) revalidatePath(path);
  back(page, "notice", "Confirmed. The desk can now finish its review.", "desk-intake");
}

export async function askDeskTapeChanges(formData: FormData) {
  const user = await requireUser();
  const listingId = text(formData, "listingId");
  const page = sellerPage(listingId);
  const asked = await askTapeChanges(user, listingId, String(formData.get("message") ?? ""));
  if (!asked.ok) back(page, "error", asked.error, "desk-intake");
  back(page, "notice", "Sent to the desk. They will correct the tape and tell you when to look again.", "desk-intake");
}
