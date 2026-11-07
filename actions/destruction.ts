"use server";

import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { certifyDestruction } from "@/lib/destruction";
import { requestMeta } from "@/lib/request-meta";

export async function certifyFilesDestroyed(formData: FormData) {
  const user = await requireRole(["BUYER"]);
  const meta = await requestMeta();
  const result = await certifyDestruction({ ndaId: String(formData.get("ndaId") || ""), userId: user.id, ipAddress: meta.ipAddress });
  if (result.error) redirect(`/buyer/offers?error=${encodeURIComponent(result.error)}#destruction`);
  redirect(`/buyer/offers?notice=${encodeURIComponent("Recorded. The certificate is in your email, and the seller has a copy.")}#destruction`);
}
