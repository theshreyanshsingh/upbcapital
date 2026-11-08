import { prisma } from "@/lib/prisma";
import { appOrigin } from "@/lib/billing";
import { isReleaseBuild } from "@/lib/deploy";
import { deliverable, deskRecipients, resolveMailTransport, type MailTransport } from "@/lib/mail-config";
import { pushNotice } from "@/lib/push";
import { deskCan, type DeskCapability } from "@/lib/desk-roles";
import { categoryText, unsubscribeLinks, unsubscribeParts, type MailCategory } from "@/lib/unsubscribe";

// A file sent with a notice, such as a certificate or a statement. The email carries it; the in-app copy never
// stores the bytes, and keeps the link the body already gives.
export type MailAttachment = { filename: string; content: Buffer; contentType: string };

// One email as it goes out: the plain text (the body as written), the same notice as HTML, and its headers.
export type MailMessage = { subject: string; text: string; html: string | null; headers: Record<string, string>; attachments: MailAttachment[] };

type SmtpMail = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
};
export type SmtpSend = (mail: SmtpMail) => Promise<unknown>;

async function nodemailerSend(mail: SmtpMail) {
  const nodemailer = await import("nodemailer");
  const port = Number(process.env.SMTP_PORT || 587);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || "" } : undefined,
  });
  return transporter.sendMail(mail);
}

// The SMTP leg. Tests swap it for a stub, as they stub fetch for Resend, so no test mail leaves the machine.
let smtpSend: SmtpSend = nodemailerSend;
export function setSmtpSender(send: SmtpSend | null) {
  smtpSend = send ?? nodemailerSend;
}

async function deliver(transport: MailTransport, toEmail: string, message: MailMessage) {
  const from = process.env.EMAIL_FROM || "UPB Capital <desk@localhost>";
  const headers = Object.keys(message.headers).length ? { headers: message.headers } : {};
  if (transport === "resend") {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [toEmail],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...headers,
        ...(message.attachments.length
          ? { attachments: message.attachments.map((file) => ({ filename: file.filename, content: file.content.toString("base64"), content_type: file.contentType })) }
          : {}),
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Resend ${response.status}: ${detail.slice(0, 300)}`);
    }
    return;
  }
  if (transport === "smtp") {
    await smtpSend({
      from,
      to: toEmail,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      ...headers,
      ...(message.attachments.length
        ? { attachments: message.attachments.map((file) => ({ filename: file.filename, content: file.content, contentType: file.contentType })) }
        : {}),
    });
  }
}

// The log transport prints the text and names the files, never their bytes.
function logLine(toEmail: string, message: MailMessage) {
  const files = message.attachments.length ? ` attachments=${message.attachments.map((file) => file.filename).join(",")}` : "";
  return `[upb-mail] to=${toEmail} subject=${message.subject}${files}\n${message.text}`;
}

// For mail that carries a secret, such as a reset link or a sign-in code: it ignores notice settings, keeps no in-app
// copy, never pushes, and a failure never logs the body. A release build keeps the body out of the log transport too.
// It stays plain text, so nothing a mail client renders stands between the reader and the code.
export async function sendSecret(toEmail: string, subject: string, body: string) {
  const transport = deliverable(toEmail) ? resolveMailTransport() : "log";
  if (transport === "log") {
    console.info(`[upb-mail] to=${toEmail} subject=${subject}${isReleaseBuild(process.env) ? " (body withheld)" : `\n${body}`}`);
    return;
  }
  try {
    await deliver(transport, toEmail, { subject, text: body, html: null, headers: {}, attachments: [] });
  } catch (error) {
    console.error(`[upb-mail] ${transport} failed for ${toEmail}:`, error instanceof Error ? error.message : "unknown error");
  }
}

// List mail the sender builds whole, such as a deal announcement with its own unsubscribe link and open pixel, or
// the list's confirmation email. Email only: no in-app copy and no push, since many readers have no account. False
// when the send failed; the failure is logged without the body.
export async function sendListMail(toEmail: string, message: MailMessage) {
  const transport = deliverable(toEmail) ? resolveMailTransport() : "log";
  if (transport === "log") {
    console.info(logLine(toEmail, message));
    return true;
  }
  try {
    await deliver(transport, toEmail, message);
    return true;
  } catch (error) {
    console.error(`[upb-mail] ${transport} failed for ${toEmail}:`, error instanceof Error ? error.message : "unknown error");
    return false;
  }
}

// What notify takes: the category for mail the user chose to get, and any files to attach.
export type NoticeOptions = Partial<MailCategory> & { attachments?: MailAttachment[] };

// Mail the user chose to get, such as watch alerts or a digest, names its category and user. The email then carries
// a link that turns off that one kind, and the List-Unsubscribe headers a mail client shows as its own button.
// Transactional mail (closings, awards, security, codes) passes none.
export async function notify(toEmail: string, subject: string, body: string, options: NoticeOptions = {}) {
  await deliverNotice(toEmail, subject, body, false, options);
}

// Security alerts, such as a changed password, and files the user asked for just now, such as a statement, reach the
// inbox whatever the email notice setting says. The in-app copy still follows the user's choice. Use sendSecret for
// anything that carries a code or a link that signs in.
export async function sendAlert(toEmail: string, subject: string, body: string, options: { attachments?: MailAttachment[] } = {}) {
  await deliverNotice(toEmail, subject, body, true, options);
}

function categoryOf(options: NoticeOptions): MailCategory | undefined {
  return options.category && options.userId ? { category: options.category, userId: options.userId, searchId: options.searchId } : undefined;
}

async function deliverNotice(toEmail: string, subject: string, body: string, alwaysEmail: boolean, options: NoticeOptions) {
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
  const category = categoryOf(options);
  const message = mailMessage(subject, body, sendEmail && category && user && category.userId === user.id ? category : undefined, options.attachments);
  if (sendEmail && transport === "log") {
    console.info(logLine(toEmail, message));
  } else if (sendEmail) {
    try {
      await deliver(transport, toEmail, message);
    } catch (error) {
      delivery = "failed";
      console.error(`[upb-mail] ${transport} failed for ${toEmail}:`, error);
      console.info(logLine(toEmail, message));
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

// The whole email for one notice: the plain text above as the alternative, and the same body as branded HTML.
export function mailMessage(subject: string, body: string, category?: MailCategory, attachments: MailAttachment[] = []): MailMessage {
  const parts = mailParts(body, category);
  const links = category ? unsubscribeLinks(category) : null;
  const unsubscribe = category && links ? { text: categoryText({ category: category.category, searchId: category.searchId ?? null }), href: links.page } : null;
  return { subject, text: parts.text, html: mailHtml(subject, body, unsubscribe), headers: parts.headers, attachments };
}

// ---------------------------------------------------------------------------------------------------------------
// The HTML version. The body stays the source of truth: it is escaped, split into paragraphs on blank lines, and
// its web addresses become links. Colours are set inline for light mail clients and swapped for dark ones.

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;

// A sentence's full stop or a closing bracket after an address belongs to the sentence, not the link.
function trimLink(raw: string) {
  let url = raw;
  while (/[.,;:!?)\]]$/.test(url)) {
    if (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break;
    url = url.slice(0, -1);
  }
  return { url, rest: raw.slice(url.length) };
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const LIGHT = { page: "#f4f4f5", card: "#ffffff", border: "#e4e4e7", ink: "#18181b", body: "#27272a", quiet: "#5f5f66", link: "#1d4ed8" };
const DARK = { page: "#111214", card: "#1b1c1f", border: "#2e2f33", ink: "#f2f2f4", body: "#dcdce0", quiet: "#a6a6ad", link: "#8ab4ff" };

function anchor(href: string, label: string) {
  return `<a href="${escapeHtml(href)}" class="upb-link" style="color:${LIGHT.link};text-decoration:underline;word-break:break-all;">${escapeHtml(label)}</a>`;
}

function inline(text: string) {
  let html = "";
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const { url, rest } = trimLink(match[0]);
    html += escapeHtml(text.slice(last, match.index)) + anchor(url, url) + escapeHtml(rest);
    last = (match.index ?? 0) + match[0].length;
  }
  return html + escapeHtml(text.slice(last));
}

const BULLET = /^\s*[-•]\s+/;

// Paragraphs on blank lines, line breaks kept within one, and a run of "- " lines as a list.
function blocks(body: string) {
  const paragraph = `margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.55;color:${LIGHT.body};`;
  return body
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n\s*\n/)
    .filter((block) => block.trim())
    .map((block) => {
      const lines = block.split("\n");
      if (lines.every((line) => BULLET.test(line))) {
        const items = lines.map((line) => `<li style="margin:0 0 8px;">${inline(line.replace(BULLET, ""))}</li>`).join("");
        return `<ul class="upb-body" style="${paragraph}padding-left:22px;">${items}</ul>`;
      }
      return `<p class="upb-body" style="${paragraph}">${lines.map(inline).join("<br>")}</p>`;
    })
    .join("\n");
}

export function mailHtml(subject: string, body: string, unsubscribe: { text: string; href: string } | null = null) {
  const origin = appOrigin().replace(/\/+$/, "");
  const preview = body.replace(/\s+/g, " ").trim().slice(0, 140);
  const quiet = `margin:0 0 8px;font-family:${FONT};font-size:13px;line-height:1.5;color:${LIGHT.quiet};`;
  const footer = [
    unsubscribe ? `<p class="upb-quiet" style="${quiet}">To stop ${escapeHtml(unsubscribe.text)}, ${anchor(unsubscribe.href, "open the unsubscribe page")}.</p>` : "",
    `<p class="upb-quiet" style="${quiet}">UPB Capital, a marketplace for US mortgage notes. ${/^https?:\/\//.test(origin) ? anchor(`${origin}/account/notifications`, "Notice settings") : ""}</p>`,
  ].join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subject)}</title>
<style>
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
  .upb-page { background-color: ${DARK.page} !important; }
  .upb-card { background-color: ${DARK.card} !important; border-color: ${DARK.border} !important; }
  .upb-ink { color: ${DARK.ink} !important; }
  .upb-body { color: ${DARK.body} !important; }
  .upb-quiet { color: ${DARK.quiet} !important; }
  .upb-link { color: ${DARK.link} !important; }
}
[data-ogsc] .upb-ink { color: ${DARK.ink} !important; }
[data-ogsc] .upb-body { color: ${DARK.body} !important; }
[data-ogsc] .upb-quiet { color: ${DARK.quiet} !important; }
[data-ogsc] .upb-link { color: ${DARK.link} !important; }
[data-ogsb] .upb-page { background-color: ${DARK.page} !important; }
[data-ogsb] .upb-card { background-color: ${DARK.card} !important; }
</style>
</head>
<body class="upb-page" style="margin:0;padding:0;background-color:${LIGHT.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;" aria-hidden="true">${escapeHtml(preview)}</div>
<div role="article" aria-roledescription="email" aria-label="${escapeHtml(subject)}" lang="en">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="upb-page" style="background-color:${LIGHT.page};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;">
<tr><td class="upb-ink" style="padding:0 4px 14px;font-family:${FONT};font-size:17px;font-weight:700;letter-spacing:-0.01em;color:${LIGHT.ink};">UPB Capital</td></tr>
<tr><td class="upb-card" style="background-color:${LIGHT.card};border:1px solid ${LIGHT.border};border-radius:12px;padding:28px 28px 12px;">
<h1 class="upb-ink" style="margin:0 0 18px;font-family:${FONT};font-size:20px;line-height:1.3;font-weight:600;color:${LIGHT.ink};">${escapeHtml(subject)}</h1>
${blocks(body)}
</td></tr>
<tr><td style="padding:16px 4px 0;">
${footer}
</td></tr>
</table>
</td></tr>
</table>
</div>
</body>
</html>`;
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
