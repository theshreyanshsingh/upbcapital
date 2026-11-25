import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { approveConnection, denyConnection } from "@/actions/oauth";
import { Logo } from "@/components/logo";
import { SubmitButton } from "@/components/submit-button";
import { SCOPE_LABELS } from "@/lib/api-keys";
import { getCurrentUser, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  approvalProblem,
  authorizeParams,
  authorizePath,
  checkAuthorizeRequest,
  isLoopback,
  originFromHeaders,
  redirectHost,
  type AuthorizeRequest,
} from "@/lib/oauth";

export const dynamic = "force-dynamic";

// The app's request is in this page's URL, so it stays out of Referer headers and out of search.
export const metadata: Metadata = { title: "Connect an app", referrer: "no-referrer", robots: { index: false, follow: false } };

// Where an AI assistant's connector sends a buyer to approve it (lib/oauth.ts). The app's client and exact redirect
// URI are checked before anything else, and until both check out nothing is sent anywhere. A request that is wrong in
// some other way is sent back to the app only when the buyer follows the link, so this page can't bounce a visitor to
// another site on its own. The decision itself is the form's, which checks everything again.
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const params = authorizeParams((name) => query[name]);
  const origin = originFromHeaders(await headers());
  const checked = await checkAuthorizeRequest(params, origin);
  if (checked.kind === "invalid") {
    return (
      <Shell>
        <h1 className="mt-3 text-[26px] font-semibold tracking-tight text-foreground">This connection request can&apos;t be used.</h1>
        <p className="mt-4 text-sm text-muted-foreground">{checked.error}</p>
        <p className="mt-4 text-sm text-muted-foreground">
          How to connect an AI assistant is on <Link href="/developers#mcp" className="text-link">the developers page</Link>.
        </p>
      </Shell>
    );
  }
  if (checked.kind === "refused") {
    return (
      <Shell>
        <h1 className="mt-3 text-[26px] font-semibold tracking-tight text-foreground">The app&apos;s request can&apos;t be used.</h1>
        <p className="mt-4 text-sm text-muted-foreground">{checked.description}</p>
        <p className="mt-4 text-sm text-muted-foreground">Nothing on your account changed. This is how the app asked, so tell its maker if it keeps happening.</p>
        <a href={checked.redirectTo} rel="noreferrer" className="mt-8 inline-flex h-11 w-fit max-w-full items-center rounded-lg border border-border px-5 text-[13px] font-medium text-foreground hover:bg-hover">
          <span className="truncate">Return to {redirectHost(checked.redirectUri)}</span>
        </a>
      </Shell>
    );
  }
  // Signed out, the sign-in page brings them back here with the request intact.
  if (!(await getCurrentUser())) redirect(`/login?next=${encodeURIComponent(authorizePath(params))}`);
  const user = await requireUser();
  const file = user.role === "BUYER" ? await prisma.buyerProfile.findUnique({ where: { userId: user.id }, select: { status: true } }) : null;
  const problem = approvalProblem(user, file);
  const { request } = checked;
  return (
    <Shell>
      <h1 className="mt-3 text-[26px] font-semibold tracking-tight text-foreground">
        {problem ? "This account can't connect an app." : "Let an app read your UPB account?"}
      </h1>
      <AppFacts request={request} account={user.companyName || user.name} email={user.actor?.email ?? user.email} />
      {problem ? (
        <>
          <p className="mt-6 text-sm text-foreground">{problem}</p>
          <DecisionForm action={denyConnection} params={params} label="Go back to the app" pendingLabel="Going back…" variant="outline" className="mt-6" />
        </>
      ) : (
        <>
          <p className="mt-6 text-[13px] text-muted-foreground">It may</p>
          <ul className="mt-2 space-y-1.5 text-sm text-foreground">
            {request.scopes.map((scope) => (
              <li key={scope} className="flex gap-2"><span aria-hidden className="text-muted-foreground">·</span>{SCOPE_LABELS[scope]}</li>
            ))}
          </ul>
          <div className="mt-6 space-y-2 text-sm text-muted-foreground">
            <p>It&apos;s read-only: it can&apos;t bid, message or change anything on UPB, and it reads only what a buyer API key with these scopes reads.</p>
            <p>
              Its access lasts an hour at a time and the app renews it. You can revoke it whenever you like under Connected apps on{" "}
              <Link href="/buyer/api#connected-apps" target="_blank" className="text-link">Buyer API</Link>.
            </p>
            <p>Approve only if you started this from the app yourself.</p>
          </div>
          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            <DecisionForm action={approveConnection} params={params} label="Approve" pendingLabel="Approving…" />
            <DecisionForm action={denyConnection} params={params} label="Deny" pendingLabel="Denying…" variant="outline" />
          </div>
        </>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main id="desk" className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-12 sm:px-5 sm:py-16">
      <Logo />
      <p className="eyebrow mt-10">Connect an app</p>
      {children}
    </main>
  );
}

// The app names itself when it registers, and nobody checks that name, so it is shown as the app's own words, beside
// the address the app will be sent back to, which is the part UPB holds it to.
function AppFacts({ request, account, email }: { request: AuthorizeRequest; account: string; email: string }) {
  const host = redirectHost(request.redirectUri);
  return (
    <dl className="mt-6 space-y-4 rounded-xl border border-border p-4 text-sm">
      <div>
        <dt className="text-[13px] text-muted-foreground">The app calls itself</dt>
        <dd className="mt-0.5 break-words font-medium text-foreground">&ldquo;{request.client.name}&rdquo;</dd>
        <dd className="mt-0.5 text-xs text-muted-foreground">That is the name the app gave UPB. UPB hasn&apos;t checked it.</dd>
      </div>
      <div>
        <dt className="text-[13px] text-muted-foreground">It sends you back to</dt>
        <dd className="mt-0.5 break-all font-mono text-[13px] text-foreground">{host}</dd>
        {isLoopback(request.redirectUri) && <dd className="mt-0.5 text-xs text-muted-foreground">An app running on this computer.</dd>}
      </div>
      <div>
        <dt className="text-[13px] text-muted-foreground">Account</dt>
        <dd className="mt-0.5 break-words text-foreground">{account}</dd>
        <dd className="mt-0.5 break-all text-xs text-muted-foreground">Signed in as {email}</dd>
      </div>
    </dl>
  );
}

// Every parameter of the request goes with the decision, and the action checks them all again.
function DecisionForm({
  action,
  params,
  label,
  pendingLabel,
  variant = "default",
  className,
}: {
  action: (formData: FormData) => Promise<void>;
  params: Record<string, string | undefined>;
  label: string;
  pendingLabel: string;
  variant?: "default" | "outline";
  className?: string;
}) {
  return (
    <form action={action} className={className}>
      {Object.entries(params).map(([name, value]) => (value ? <input key={name} type="hidden" name={name} value={value} /> : null))}
      <SubmitButton variant={variant} pendingLabel={pendingLabel} className="h-11 w-full text-[13px] font-medium">{label}</SubmitButton>
    </form>
  );
}
