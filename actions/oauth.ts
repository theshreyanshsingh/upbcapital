"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireRole, requireUser } from "@/lib/auth";
import { approveAuthorization, authorizeParams, authorizePath, denyAuthorization, originFromHeaders, revokeGrantRows } from "@/lib/oauth";
import { canManageSeats } from "@/lib/seats";

const PAGE = "/buyer/api";

// The consent form carries the app's request in hidden fields, and every check runs again here (lib/oauth.ts). A
// request that no longer checks out goes back to the authorize page, which says why.
function formParams(formData: FormData) {
  return authorizeParams((name) => formData.get(name));
}

export async function approveConnection(formData: FormData) {
  const user = await requireUser();
  const params = formParams(formData);
  const decision = await approveAuthorization(user, params, originFromHeaders(await headers()));
  redirect("redirect" in decision ? decision.redirect : authorizePath(params));
}

export async function denyConnection(formData: FormData) {
  await requireUser();
  const params = formParams(formData);
  const decision = await denyAuthorization(params, originFromHeaders(await headers()));
  redirect("redirect" in decision ? decision.redirect : authorizePath(params));
}

// A connected app reads as the whole firm, as a key does, so the same people revoke it (actions/buyer-api.ts).
export async function revokeConnectedApp(formData: FormData) {
  const user = await requireRole(["BUYER"]);
  if (!canManageSeats(user)) redirect(`${PAGE}?error=${encodeURIComponent("Only a managing seat or the account owner can change API keys and connected apps.")}`);
  const id = String(formData.get("id") || "");
  if (!(await revokeGrantRows(id, user.id))) redirect(`${PAGE}?error=${encodeURIComponent("That app isn't connected to this account.")}#connected-apps`);
  await audit(user.id, "OAUTH_GRANT_REVOKED", "oauthGrant", id, "Revoked from the Buyer API page");
  redirect(`${PAGE}?notice=${encodeURIComponent("The app is disconnected. Its access stopped at once.")}#connected-apps`);
}
