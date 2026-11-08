"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { secureCookies } from "@/lib/deploy";
import { reopenDeskTape } from "@/lib/desk-intake";
import { answerable } from "@/lib/discrepancies";
import { flagDuplicates } from "@/lib/duplicates";
import { notifyDesk } from "@/lib/email";
import { rescoreListing } from "@/lib/matching";
import { prisma } from "@/lib/prisma";
import { guardDesk } from "@/lib/staff";
import {
  applyServicerReport as applyReport,
  canImport,
  MAX_REPORT_BYTES,
  previewCookieValue,
  previewForListing,
  readPreviewCookie,
  SERVICER_COOKIE,
  servicerSource,
  type ImportResult,
  type ServicerSource,
} from "@/lib/servicer-import";
import { extensionOf } from "@/lib/storage";
import { deleteTapeDraft, readTapeDraft, saveTapeDraft } from "@/lib/tape-draft";
import { uploadProblem } from "@/lib/uploads";

// Each action is a public endpoint, so each checks that the caller is the seller of record or the desk. Figures
// never go in the address bar: a notice says what happened, not what a value was.

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

// Back to the page the form was on: the desk's listing, on the loan it had open, or the seller's own page.
function pageFor(listingId: string, role: string, formData: FormData) {
  if (role === "ADMIN" && text(formData, "from") === "desk") {
    const loan = text(formData, "loan");
    return `/admin/listings/${listingId}${/^[a-z0-9]{10,40}$/i.test(loan) ? `?loan=${loan}` : ""}`;
  }
  return `/seller/listings/${listingId}`;
}

function back(page: string, kind: "notice" | "error" | null, message = "", anchor = "servicer-report"): never {
  const query = kind ? `${page.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(message)}` : "";
  redirect(`${page}${query}#${anchor}`);
}

async function listingFor(formData: FormData) {
  const user = await requireUser();
  const listingId = text(formData, "listingId");
  const listing = listingId ? await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, sellerId: true, status: true, title: true } }) : null;
  if (!listing || !canImport(user, listing)) {
    redirect(`${user.role === "ADMIN" ? "/admin/queue" : "/seller"}?error=${encodeURIComponent("That listing isn't yours.")}`);
  }
  if (listing.sellerId !== user.id) guardDesk(user, "sales", `/admin/listings/${listing.id}`);
  return { user, listing, page: pageFor(listing.id, user.role, formData) };
}

// The same secure rule as the session cookie, so a plain-HTTP demo host still keeps it.
const cookieOptions = () => ({ httpOnly: true, sameSite: "lax" as const, secure: secureCookies(), path: "/", maxAge: 24 * 60 * 60 });

// Reads the file and shows what it would change. Nothing is written to the tape until the apply below.
export async function previewServicerReport(formData: FormData) {
  const { user, listing, page } = await listingFor(formData);
  if (!answerable(listing.status)) back(page, "error", "This listing is in contract or closed, so a servicer report can't change its tape here.");
  const source = servicerSource(text(formData, "source"), text(formData, "sourceName"));
  if (!source) back(page, "error", "Choose the servicer, and name it if it isn't listed.");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size <= 0) back(page, "error", "Attach the servicer's export as a CSV or Excel file.");
  const ext = extensionOf(file.name);
  if (ext !== "csv" && ext !== "xlsx" && ext !== "xls") back(page, "error", "Use the servicer's CSV or Excel export.");
  const bytes = Buffer.from(await file.arrayBuffer());
  const problem = uploadProblem(file.name, bytes.length, bytes, MAX_REPORT_BYTES);
  if (problem) back(page, "error", problem);
  const preview = await previewForListing(listing.id, source, file.name, bytes);
  if (!preview.ok) back(page, "error", preview.error);
  const jar = await cookies();
  // One staged report at a time: a new upload replaces the last one.
  const earlier = readPreviewCookie(jar.get(SERVICER_COOKIE)?.value);
  if (earlier && (await readTapeDraft(user.id, earlier.token))) await deleteTapeDraft(earlier.token);
  const token = crypto.randomUUID();
  await saveTapeDraft({ token, userId: user.id, filename: file.name.slice(0, 180), bytes });
  jar.set(SERVICER_COOKIE, previewCookieValue({ listingId: listing.id, token, source }), cookieOptions());
  back(page, null);
}

function appliedNotice(result: ImportResult, source: ServicerSource, seller: boolean) {
  const loans = result.matched === 1 ? "1 loan" : `${result.matched} loans`;
  const fields = (count: number, what: string) => `${count} ${count === 1 ? "field" : "fields"} ${what}`;
  const questions = result.raised === 1 ? "1 difference is" : `${result.raised} differences are`;
  const answer = seller ? "for you to fix or explain" : "for the seller to fix or explain";
  return `The ${source.name} report is applied to ${loans}: ${fields(result.filled, "filled")}, ${result.updated ? `${fields(result.updated, "updated to the report's newer figure")}, ` : ""}and ${fields(result.confirmed, "confirmed")}.${result.raised ? ` ${questions} open ${answer}.` : ""}`;
}

export async function applyServicerReport(formData: FormData) {
  const { user, listing, page } = await listingFor(formData);
  const jar = await cookies();
  const staged = readPreviewCookie(jar.get(SERVICER_COOKIE)?.value);
  const token = text(formData, "token");
  if (!staged || staged.listingId !== listing.id || staged.token !== token) back(page, "error", "That preview expired. Upload the report again.");
  const draft = await readTapeDraft(user.id, token);
  if (!draft) {
    jar.delete(SERVICER_COOKIE);
    back(page, "error", "That preview expired. Upload the report again.");
  }
  const outcome = await applyReport(user.id, { listingId: listing.id, source: staged.source, filename: draft.filename, bytes: draft.bytes });
  if (!outcome.ok) back(page, "error", outcome.error);
  await deleteTapeDraft(token);
  jar.delete(SERVICER_COOKIE);
  const result = outcome.value;
  // A filled field changes how the tape scores against buy boxes, and a new loan number can reveal a duplicate.
  if (result.filled) await rescoreListing(listing.id, false).catch(() => null);
  if (result.identified) await flagDuplicates(listing.id, listing.sellerId);
  // The desk filled blanks on a desk-filed tape the seller confirmed, so the seller confirms it again (lib/desk-intake.ts).
  const written = result.filled + (result.updated ?? 0);
  if (listing.sellerId !== user.id && written) await reopenDeskTape(user.id, listing.id, `${written} field${written === 1 ? "" : "s"} from the ${staged.source.name} report`);
  if (user.role !== "ADMIN") {
    await notifyDesk(
      `Servicer report · ${listing.title}`,
      `The seller applied a ${staged.source.name} report: ${result.matched} of ${result.rows} rows matched, ${result.filled} fields filled, ${result.confirmed} confirmed, ${result.raised} differences opened.`,
    ).catch(() => null);
  }
  for (const path of [`/seller/listings/${listing.id}`, `/admin/listings/${listing.id}`, `/marketplace/${listing.id}`]) revalidatePath(path);
  // Questions it opened are what the reader acts on next, so the page opens on them.
  back(page, "notice", appliedNotice(result, staged.source, listing.sellerId === user.id), result.raised ? "differences" : "servicer-report");
}

export async function discardServicerReport(formData: FormData) {
  const { user, page } = await listingFor(formData);
  const jar = await cookies();
  const staged = readPreviewCookie(jar.get(SERVICER_COOKIE)?.value);
  if (staged && (await readTapeDraft(user.id, staged.token))) await deleteTapeDraft(staged.token);
  jar.delete(SERVICER_COOKIE);
  back(page, "notice", "The report was set aside. Nothing on the tape changed.");
}
