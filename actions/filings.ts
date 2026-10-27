"use server";

import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { FILING_COUNTIES, matchFiling, parseFilingCsv } from "@/lib/filings";
import { prisma } from "@/lib/prisma";

export async function importFilings(formData: FormData) {
  await requireRole(["ADMIN"]);
  const county = String(formData.get("county") || "");
  if (!(FILING_COUNTIES as readonly string[]).includes(county)) redirect("/admin/filings?error=Choose Miami-Dade, Broward, or Palm Beach.");
  const file = formData.get("file");
  const pasted = String(formData.get("csv") || "");
  const text = file instanceof File && file.size > 0 ? await file.text() : pasted;
  const { rows, errors } = parseFilingCsv(text, county);
  if (!rows.length) redirect(`/admin/filings?error=${encodeURIComponent(errors[0] || "Nothing to import.")}`);
  const notes = await prisma.note.findMany({
    where: { state: "FL" },
    select: { id: true, streetAddress: true, city: true },
  });
  let created = 0;
  for (const row of rows) {
    const noteId = matchFiling(row, notes);
    await prisma.courtFiling.upsert({
      where: { county_caseNumber: { county: row.county, caseNumber: row.caseNumber } },
      create: { ...row, noteId },
      update: { ...row, noteId },
    });
    created += 1;
  }
  redirect(`/admin/filings?notice=${encodeURIComponent(`Imported ${created} filings${errors.length ? ` · ${errors.length} skipped` : ""}.`)}`);
}

export async function setFilingStatus(formData: FormData) {
  await requireRole(["ADMIN"]);
  const id = String(formData.get("id") || "");
  const status = String(formData.get("status") || "NEW");
  const outreach = String(formData.get("outreach") || "");
  if (!["NEW", "CONTACTED", "LISTING", "PASSED"].includes(status)) redirect("/admin/filings?error=Unknown status.");
  await prisma.courtFiling.update({ where: { id }, data: { status: status as "NEW", outreach } });
  redirect("/admin/filings?notice=filing");
}
