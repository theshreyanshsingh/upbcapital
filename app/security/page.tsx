import type { Metadata } from "next";
import Link from "next/link";
import { PublicPage } from "@/components/public-page";
import { API_LIMIT } from "@/lib/api-limit";
import { getCurrentUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { subprocessors } from "./subprocessors";

export const metadata: Metadata = {
  title: "Security",
  description: "How UPB Capital signs people in, screens them, guards the data room, keeps records, deletes accounts, and which outside services it uses.",
};
export const dynamic = "force-dynamic";

// Plain statements of what the code does today, for a bank's vendor review. Anything not built is said to be missing.
export default async function SecurityPage() {
  const [settings, user] = await Promise.all([getSettings(), getCurrentUser()]);
  const twoStep = settings.requireTwoStep !== false;
  const vendors = subprocessors(settings);
  const contact = process.env.SECURITY_EMAIL?.trim() || process.env.DESK_EMAIL?.trim() || "";
  const sections: [string, string[]][] = [
    [
      "Signing in",
      [
        "Passwords are stored as bcrypt hashes. Desk staff must use an authenticator app for a second step at sign-in, with one-time recovery codes.",
        twoStep
          ? "Every approved account that can see borrower data must set up the second step too."
          : "Other accounts can turn on the second step from their security page. The desk does not require it of them today.",
        "Sign-in, sign-up, password resets, codes and the API are rate limited. A session lives on the server for up to 14 days, and you can see and end each signed-in device from your security page.",
      ],
    ],
    [
      "Sanctions screening",
      [
        "The desk screens names against the OFAC sanctions list at sign-up, on a buyer file, when a tape arrives, and again at approval, covering sellers, buyers, brokers' clients and named borrowers.",
        "A possible match stops approval, awards and closing steps until a person decides it, with a reason that stays on the record.",
      ],
    ],
    [
      "The data room",
      [
        "A buyer signs an NDA before the street address, the borrower and the files open. A seller can also approve each bidder by hand.",
        "Each PDF a buyer downloads from the room carries that buyer's name on every page, so a leaked copy says whose it was. Images, spreadsheets and PDFs that can't be read, such as encrypted ones, go out as stored.",
        "Once a listing is under contract, the room closes to every bidder but the deal's own buyers. Each bidder whose room opened is then asked to certify they destroyed the files, and the seller gets a certificate.",
        "Every download is logged. The seller, the broker and the desk can download the room's access log.",
      ],
    ],
    [
      "Records and audit",
      [
        "Sign-ins, failed sign-ins, approvals, sanctions decisions, wire changes, closing steps, downloads and exports are written to an audit log the desk keeps.",
        `The API takes keys stored only as hashes, and each key may make ${API_LIMIT.requests} requests a minute. Webhooks are signed and go only to public https addresses.`,
      ],
    ],
    [
      "Retention and deletion",
      [
        `Deal records are kept for ${settings.retentionYears} years: closings, signed papers, NDAs, the ledger and the audit log. Site visit logs and notices you have read are removed after that.`,
        "You can ask for your account to be deleted from your security page. The desk removes your name, email, phone, company and second factor, signs out every device, and deletes your saved searches, buy boxes, API keys and webhooks. Your proof of funds is removed when no closing names you. Deal records stay, under an account with no name.",
        "A deletion waits while you have an open bid, an open closing, a live listing or an unfunded group seat.",
      ],
    ],
  ];
  return (
    <PublicPage
      title="Security at UPB."
      lede="What the desk does to protect borrower data and the people trading it, and what it doesn't have yet."
      authed={Boolean(user)}
    >
      {sections.map(([heading, lines]) => (
        <section key={heading} aria-label={heading} className="space-y-3">
          <h2 className="font-semibold tracking-tight text-2xl text-foreground">{heading}</h2>
          {lines.map((line) => <p key={line}>{line}</p>)}
        </section>
      ))}

      <section className="glass p-5 md:p-6" aria-labelledby="vendors-heading">
        <h2 id="vendors-heading" className="eyebrow">Outside services</h2>
        <p className="mt-2 text-sm text-muted-foreground">Read from the configuration this site runs with today. The servers and the database run with a cloud host, which this list leaves out.</p>
        <dl className="mt-4 divide-y divide-border">
          {vendors.map((vendor) => (
            <div key={vendor.category} className="grid gap-1 py-3 sm:grid-cols-[140px_110px_minmax(0,1fr)] sm:gap-4">
              <dt className="text-sm font-medium text-foreground">{vendor.category}</dt>
              <dd className={`text-sm ${vendor.inUse ? "text-foreground" : "text-muted-foreground"}`}>{vendor.inUse ? "In use" : "Not in use"}</dd>
              <dd className="text-sm leading-relaxed text-muted-foreground">
                {vendor.inUse ? <span className="text-foreground">{vendor.name}. </span> : null}
                {vendor.detail}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-label="Audits" className="space-y-3">
        <h2 className="font-semibold tracking-tight text-2xl text-foreground">Audits</h2>
        <p>UPB Capital has no SOC 2 report yet, and no outside firm has tested these controls. We answer vendor questionnaires plainly, including when the answer is no.</p>
      </section>

      <section aria-label="Reporting a problem" className="space-y-3">
        <h2 className="font-semibold tracking-tight text-2xl text-foreground">Reporting a problem</h2>
        <p>
          If you find a security problem, write to{" "}
          {contact ? <a href={`mailto:${contact}`} className="text-link">{contact}</a> : "the desk at the address in the privacy policy"} with what you found and how to see it again. We read every report and reply.
        </p>
        <p>Please don&apos;t open other people&apos;s data, run load or denial-of-service tests, or use accounts that aren&apos;t yours. Give us a fair chance to fix a problem before you publish it.</p>
      </section>

      <p className="text-sm text-muted-foreground">
        See also the <Link href="/privacy" className="text-link">privacy policy</Link> and the <Link href="/terms" className="text-link">terms of use</Link>.
      </p>
    </PublicPage>
  );
}
