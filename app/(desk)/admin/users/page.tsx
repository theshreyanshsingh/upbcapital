import { setAccountStatus, setMembership } from "@/actions/admin";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { Button } from "@/components/ui/button";
import { requireRole } from "@/lib/auth";
import { q } from "@/lib/format";
import { roleLabel } from "@/lib/labels";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Accounts" };

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole(["ADMIN"]);
  const params = await searchParams;
  const users = await prisma.user.findMany({ orderBy: { createdAt: "desc" } });
  return (
    <div>
      <PageIntro eyebrow="Accounts" title="Who is allowed in." lede="Buyers and institutions wait here until you approve them. Pro can be comped without a charge." />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <div className="mt-8 overflow-x-auto border border-border rounded-xl">
        <table className="min-w-full text-left text-sm">
          <thead className="text-xs font-medium text-muted-foreground">
            <tr>
              {["Name", "Role", "Status", "Membership", ""].map((heading) => <th key={heading} className="px-4 py-3 font-normal">{heading}</th>)}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-t border-border align-top">
                <td className="px-4 py-4">
                  <p className="text-foreground">{user.name}</p>
                  <p className="text-xs text-muted-foreground">{user.email}</p>
                  {user.companyName && <p className="text-xs text-muted-foreground">{user.companyName}</p>}
                </td>
                <td className="px-4 py-4">{roleLabel(user.role)}</td>
                <td className="px-4 py-4">{user.accountStatus.toLowerCase()}</td>
                <td className="px-4 py-4">{user.role === "BUYER" ? `${user.subscriptionTier.toLowerCase()}${user.subscriptionComped ? " · comped" : ""}` : "—"}</td>
                <td className="px-4 py-4">
                  <div className="flex flex-wrap gap-2">
                    {user.role !== "ADMIN" && user.accountStatus !== "APPROVED" && (
                      <form action={setAccountStatus}>
                        <input type="hidden" name="userId" value={user.id} />
                        <input type="hidden" name="status" value="APPROVED" />
                        <Button type="submit" className="h-8 text-[13px] font-medium">Approve</Button>
                      </form>
                    )}
                    {user.role !== "ADMIN" && user.accountStatus !== "REJECTED" && (
                      <form action={setAccountStatus}>
                        <input type="hidden" name="userId" value={user.id} />
                        <input type="hidden" name="status" value="REJECTED" />
                        <Button type="submit" variant="outline" className="h-8 text-[13px] font-medium">Decline</Button>
                      </form>
                    )}
                    {user.role === "BUYER" && user.subscriptionTier !== "PRO" && (
                      <form action={setMembership}>
                        <input type="hidden" name="userId" value={user.id} />
                        <input type="hidden" name="tier" value="PRO" />
                        <Button type="submit" variant="ghost" className="h-8 text-[13px] font-medium">Comp Pro</Button>
                      </form>
                    )}
                    {user.role === "BUYER" && user.subscriptionTier === "PRO" && (
                      <form action={setMembership}>
                        <input type="hidden" name="userId" value={user.id} />
                        <input type="hidden" name="tier" value="FREE" />
                        <Button type="submit" variant="ghost" className="h-8 text-[13px] font-medium">Set free</Button>
                      </form>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
