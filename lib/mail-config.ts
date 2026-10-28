export type MailTransport = "resend" | "smtp" | "log";

export function resolveMailTransport(env: Record<string, string | undefined> = process.env): MailTransport {
  if (env.RESEND_API_KEY && env.EMAIL_FROM) return "resend";
  if (env.SMTP_HOST && env.EMAIL_FROM) return "smtp";
  return "log";
}

// Reserved names (RFC 2606 / 6761) never take mail. The demo desk signs in as @upbcapital.test, and sending
// there through a real provider only bounces against the sending domain, so those stay in the log.
export function deliverable(email: string) {
  const domain = email.trim().toLowerCase().split("@").pop() ?? "";
  return !/(^|\.)(test|example|invalid|localhost)$/.test(domain) && !/(^|\.)example\.(com|net|org)$/.test(domain);
}

export function deskRecipients(adminEmails: string[], deskEmail = "") {
  const seen = new Set<string>();
  return [...adminEmails, deskEmail]
    .map((email) => email.trim())
    .filter((email) => {
      const key = email.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
