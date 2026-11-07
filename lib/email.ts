import { prisma } from "@/lib/prisma";
import { isReleaseBuild } from "@/lib/deploy";
import { deliverable, deskRecipients, resolveMailTransport, type MailTransport } from "@/lib/mail-config";
import { pushNotice } from "@/lib/push";
import { deskCan, type DeskCapability } from "@/lib/desk-roles";
import { unsubscribeParts, type MailCategory } from "@/lib/unsubscribe";

async function deliver(transport: MailTransport, toEmail: string, subject: string, body: string, headers: Record<string, string> = {}) {
  const from = process.env.EMAIL_FROM || "UPB Capital <desk@localhost>";
  if (transport === "resend") {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [toEmail], subject, text: body, ...(Object.keys(headers).length ? { headers } : {}) }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Resend ${response.status}: ${detail.slice(0, 300)}`);
    }
    return;
  }
  if (transport === "smtp") {
    const nodemailer = await import("nodemailer");
    const port = Number(process.env.SMTP_PORT || 587);
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || "" } : undefined,
    });
    await transporter.sendMail({ from, to: toEmail, subject, text: body, ...(Object.keys(headers).length ? { headers } : {}) });
  }
}

// For mail that carries a secret, such as a reset link or a sign-in code: it ignores notice settings, keeps no in-app
// copy, never pushes, and a failure never logs the body. A release build keeps the body out of the log transport too.
export async function sendSecret(toEmail: string, subject: string, body: string) {
  const transport = deliverable(toEmail) ? resolveMailTransport() : "log";
  if (transport === "log") {
    console.info(`[upb-mail] to=${toEmail} subject=${subject}${isReleaseBuild(process.env) ? " (body withheld)" : `\n${body}`}`);
    return;
  }
  try {
    await deliver(transport, toEmail, subject, body);
  } catch (error) {
    console.error(`[upb-mail] ${transport} failed for ${toEmail}:`, error instanceof Error ? error.message : "unknown error");
  }
}

// Mail the user chose to get, such as watch alerts or a digest, names its category and user. The email then carries
// a link that turns off that one kind, and the List-Unsubscribe headers a mail client shows as its own button.
// Transactional mail (closings, awards, security, codes) passes none.
export async function notify(toEmail: string, subject: string, body: string, options?: MailCategory) {
  await deliverNotice(toEmail, subject, body, false, options);
}

// Security alerts, such as a changed password, reach the inbox whatever the email notice setting says. The in-app copy
// still follows the user's choice. Use sendSecret for anything that carries a code or a link.
export async function sendAlert(toEmail: string, subject: string, body: string) {
  await deliverNotice(toEmail, subject, body, true);
}

async function deliverNotice(toEmail: string, subject: string, body: string, alwaysEmail: boolean, category?: MailCategory) {
  const user = await prisma.user.findUnique({
    where: { email: toEmail },
    select: { id: true, notifyEmail: true, notifyInApp: true, pushEnabled: true },
  });
  const sendEmail = alwaysEmail || !user || user.notifyEmail;
  const keepInApp = !user || user.notifyInApp;
  // Push is its own opt-in, per device. It runs after the in-app copy so the badge counts this notice, and its
  // payload is only the event name, a generic line and the in-app link (see lib/push.ts).
  const push = user?.pushEnabled ? () => pushNotice(user.id, subject, body) : null;
  if (!sendEmail && !keepInApp) {
    if (push) await push();
    return;
  }
  const transport = deliverable(toEmail) ? resolveMailTransport() : "log";
  let delivery: string = sendEmail ? transport : "skipped";
  // The link goes on the email only. The in-app copy is read signed in, where the settings page does the same job.
  // A category naming someone other than the recipient is dropped, so no email can carry another person's link.
  const parts = mailParts(body, sendEmail && category && user && category.userId === user.id ? category : undefined);
  if (sendEmail && transport === "log") {
    console.info(`[upb-mail] to=${toEmail} subject=${subject}\n${parts.text}`);
  } else if (sendEmail) {
    try {
      await deliver(transport, toEmail, subject, parts.text, parts.headers);
    } catch (error) {
      delivery = "failed";
      console.error(`[upb-mail] ${transport} failed for ${toEmail}:`, error);
      console.info(`[upb-mail] to=${toEmail} subject=${subject}\n${parts.text}`);
    }
  }
  if (keepInApp) {
    await prisma.notification.create({
      data: { toEmail, userId: user?.id, subject, body, delivery },
    });
  }
  if (push) await push();
}

// The email text and headers for one notice: the body as written, plus the unsubscribe footer and headers when the
// mail names a category.
export function mailParts(body: string, category?: MailCategory) {
  const extra = category ? unsubscribeParts(category) : null;
  if (!extra) return { text: body, headers: {} as Record<string, string> };
  return { text: `${body}\n\n${extra.footer}`, headers: extra.headers };
}

// A notice that quotes a bid amount names the capability it needs, so a desk trader or a read-only seat never reads
// a sealed figure from their inbox. The shared desk mailbox still gets every notice.
export async function notifyDesk(subject: string, body: string, options: { capability?: DeskCapability } = {}) {
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN", accountStatus: "APPROVED" },
    select: { email: true, role: true, deskRole: true },
  });
  const readers = options.capability ? admins.filter((admin) => deskCan(admin, options.capability!)) : admins;
  const recipients = deskRecipients(readers.map((admin) => admin.email), process.env.DESK_EMAIL);
  if (!recipients.length) console.warn(`[upb-mail] no desk recipient for ${subject}`);
  for (const email of recipients) await notify(email, subject, body);
}
