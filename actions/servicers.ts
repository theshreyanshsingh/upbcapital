"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDesk } from "@/lib/staff";
import { saveServicer, setServicerActive } from "@/lib/servicers";

const BACK = "/admin/servicers";

function back(key: "notice" | "error", text: string): never {
  redirect(`${BACK}?${key}=${encodeURIComponent(text)}`);
}

// Both actions are the closings side's. requireDesk signs the caller in and checks the role, and the library checks it
// again before writing.
export async function saveServicerAction(formData: FormData) {
  const user = await requireDesk("closings", BACK);
  const field = (key: string) => String(formData.get(key) ?? "");
  const id = field("id");
  const saved = await saveServicer(user, {
    id: id || null,
    name: field("name"),
    website: field("website"),
    contactEmail: field("contactEmail"),
    states: field("states"),
    importFormat: field("importFormat"),
    boardingFee: field("boardingFee"),
    monthlyFee: field("monthlyFee"),
    notes: field("notes"),
  });
  if (!saved.ok) back("error", saved.error);
  revalidatePath(BACK);
  revalidatePath("/servicers");
  back("notice", id ? "The servicer is saved." : "The servicer is on the directory.");
}

export async function setServicerActiveAction(formData: FormData) {
  const user = await requireDesk("closings", BACK);
  const active = String(formData.get("active") ?? "") === "1";
  const moved = await setServicerActive(user, { id: String(formData.get("id") ?? ""), active });
  if (!moved.ok) back("error", moved.error);
  revalidatePath(BACK);
  revalidatePath("/servicers");
  back("notice", active ? "The servicer is back on the directory." : "The servicer is off the directory. Boardings that name it keep it.");
}
