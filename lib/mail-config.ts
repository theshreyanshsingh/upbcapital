export type MailTransport = "resend" | "smtp" | "log";

export function resolveMailTransport(env: Record<string, string | undefined> = process.env): MailTransport {
  if (env.RESEND_API_KEY && env.EMAIL_FROM) return "resend";
  if (env.SMTP_HOST && env.EMAIL_FROM) return "smtp";
  return "log";
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
