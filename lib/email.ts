import { prisma } from "@/lib/prisma";
import { deliverable, deskRecipients, resolveMailTransport, type MailTransport } from "@/lib/mail-config";

async function deliver(transport: MailTransport, toEmail: string, subject: string, body: string) {
  const from = process.env.EMAIL_FROM || "UPB Capital <desk@localhost>";
  if (transport === "resend") {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [toEmail], subject, text: body }),
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
    await transporter.sendMail({ from, to: toEmail, subject, text: body });
  }
}

// For mail that carries a secret, such as a reset link: no in-app copy, and a failure never logs the body.
export async function sendSecret(toEmail: string, subject: string, body: string) {
  const transport = deliverable(toEmail) ? resolveMailTransport() : "log";
  if (transport === "log") {
    console.info(`[upb-mail] to=${toEmail} subject=${subject}\n${body}`);
    return;
  }
  try {
    await deliver(transport, toEmail, subject, body);
  } catch (error) {
    console.error(`[upb-mail] ${transport} failed for ${toEmail}:`, error instanceof Error ? error.message : "unknown error");
  }
}

export async function notify(toEmail: string, subject: string, body: string) {
  const user = await prisma.user.findUnique({
    where: { email: toEmail },
    select: { id: true, notifyEmail: true, notifyInApp: true },
  });
  const sendEmail = !user || user.notifyEmail;
  const keepInApp = !user || user.notifyInApp;
  if (!sendEmail && !keepInApp) return;
  const transport = deliverable(toEmail) ? resolveMailTransport() : "log";
  let delivery: string = sendEmail ? transport : "skipped";
  if (sendEmail && transport === "log") {
    console.info(`[upb-mail] to=${toEmail} subject=${subject}\n${body}`);
  } else if (sendEmail) {
    try {
      await deliver(transport, toEmail, subject, body);
    } catch (error) {
      delivery = "failed";
      console.error(`[upb-mail] ${transport} failed for ${toEmail}:`, error);
      console.info(`[upb-mail] to=${toEmail} subject=${subject}\n${body}`);
    }
  }
  if (!keepInApp) return;
  await prisma.notification.create({
    data: { toEmail, userId: user?.id, subject, body, delivery },
  });
}

export async function notifyDesk(subject: string, body: string) {
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN", accountStatus: "APPROVED" },
    select: { email: true },
  });
  const recipients = deskRecipients(admins.map((admin) => admin.email), process.env.DESK_EMAIL);
  if (!recipients.length) console.warn(`[upb-mail] no desk recipient for ${subject}`);
  for (const email of recipients) await notify(email, subject, body);
}
