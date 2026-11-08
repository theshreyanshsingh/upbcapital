import { appOrigin } from "@/lib/billing";
import { fileWidgetLead, widgetBroker, widgetCsp, WIDGET_PATH, type WidgetBroker, type WidgetFields } from "@/lib/broker-widget";
import { escapeHtml } from "@/lib/email";
import { money } from "@/lib/format";
import { LIEN_POSITIONS, PAYMENT_STATUSES, US_STATES } from "@/lib/labels";
import { clientAddress } from "@/lib/request-meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The broker's embedded intake form. It is a route rather than a page so each response carries its own policy: the
// broker's listed sites in frame-ancestors, or 'none' when the form is off or the code is unknown. next.config.ts
// leaves this one path out of the site-wide 'none'. The page is plain HTML with inline style and no script, so
// the policy can shut everything else.

const FIELDS = ["name", "email", "phone", "city", "state", "lienPosition", "paymentStatus", "upb", "estimatedValue", "interestRate", "monthlyPi", "note", "website"];
const MAX_BODY = 20_000;

const STYLE = `
:root{color-scheme:light dark;--bg:#ffffff;--card:#f7f7f8;--ink:#18181b;--quiet:#5f5f66;--line:#e4e4e7;--accent:#1d4ed8;--accent-ink:#ffffff;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#111214;--card:#1b1c1f;--ink:#f2f2f4;--quiet:#a6a6ad;--line:#2e2f33;--accent:#8ab4ff;--accent-ink:#0b0c0e;--bad:#ff8a80}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:640px;margin:0 auto;padding:20px 16px 28px}
.eyebrow{margin:0;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--quiet)}
h1{margin:6px 0 8px;font-size:24px;line-height:1.25;letter-spacing:-.01em}
p{margin:0 0 12px}
.quiet{color:var(--quiet);font-size:14px}
.fine{color:var(--quiet);font-size:12px;margin-top:14px}
form{display:grid;gap:12px;grid-template-columns:1fr;margin-top:16px}
@media (min-width:520px){form{grid-template-columns:1fr 1fr}.wide{grid-column:1/-1}}
label span{display:block;font-size:13px;color:var(--quiet);margin-bottom:4px}
input,select,textarea{width:100%;min-height:44px;padding:9px 11px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);font:inherit}
textarea{min-height:84px}
button,.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 20px;border:0;border-radius:10px;background:var(--accent);color:var(--accent-ink);font:inherit;font-size:14px;font-weight:600;text-decoration:none;cursor:pointer}
.alert{border:1px solid var(--bad);color:var(--bad);border-radius:10px;padding:10px 12px;font-size:14px}
.range{margin:14px 0;padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
.range strong{display:block;font-size:26px;letter-spacing:-.01em}
.hidden{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
a{color:var(--accent)}
`;

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function respond(html: string, status: number, origins: string[]) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": widgetCsp(origins), "Cache-Control": "no-store" },
  });
}

function unavailable() {
  return respond(page("Form unavailable", `<h1>This form isn't available.</h1><p class="quiet">The link may be old, or the broker turned the form off.</p>`), 404, []);
}

function option(value: string, label: string, current: string) {
  return `<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function field(name: string, label: string, values: WidgetFields, extra = "") {
  return `<label><span>${label}</span><input name="${name}" value="${escapeHtml(values[name] ?? "")}" ${extra}></label>`;
}

function privacy() {
  return `${appOrigin().replace(/\/+$/, "")}/privacy`;
}

function formPage(broker: WidgetBroker, values: WidgetFields = {}, error = "") {
  const company = escapeHtml(broker.company);
  const state = values.state || "FL";
  const body = `
<p class="eyebrow">Sell your note</p>
<h1>An indicative range, before the file.</h1>
<p class="quiet">${company} works with UPB Capital, a marketplace for mortgage notes. A few facts give a desk range from the same bands and comps used on the book. It is not an offer.</p>
${error ? `<p class="alert" role="alert">${escapeHtml(error)}</p>` : ""}
<form method="post" action="${WIDGET_PATH}/${encodeURIComponent(broker.code)}">
${field("name", "Name", values, 'required autocomplete="name" maxlength="120"')}
${field("email", "Email", values, 'type="email" required autocomplete="email" maxlength="254"')}
${field("phone", "Phone", values, 'autocomplete="tel" maxlength="40"')}
${field("city", "City", values, 'maxlength="80"')}
<label><span>State</span><select name="state">${US_STATES.map((code) => option(code, code, state)).join("")}</select></label>
<label><span>Lien</span><select name="lienPosition">${LIEN_POSITIONS.map((item) => option(item.value, item.label, values.lienPosition ?? "")).join("")}</select></label>
<label><span>Performance</span><select name="paymentStatus">${PAYMENT_STATUSES.map((item) => option(item.value, item.label, values.paymentStatus ?? "")).join("")}</select></label>
${field("upb", "Unpaid principal", values, 'inputmode="decimal" required')}
${field("estimatedValue", "Estimated value", values, 'inputmode="decimal" required')}
${field("interestRate", "Note rate %", values, 'inputmode="decimal" required')}
${field("monthlyPi", "Monthly P&amp;I", values, 'inputmode="decimal" required')}
<label class="wide"><span>Anything else</span><textarea name="note" maxlength="1000">${escapeHtml(values.note ?? "")}</textarea></label>
<label class="hidden" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
<div class="wide"><button type="submit">See the range</button></div>
</form>
<p class="fine">Your details go to ${company} and the UPB Capital desk, who may contact you about this note. <a href="${escapeHtml(privacy())}" target="_blank" rel="noopener">Privacy policy</a></p>`;
  return page(`Sell your note · ${broker.company}`, body);
}

function resultPage(broker: WidgetBroker, low: number, high: number, basis: string) {
  const company = escapeHtml(broker.company);
  const body = `
<p class="eyebrow">Sell your note</p>
<h1>Your indicative range.</h1>
<div class="range"><strong>${escapeHtml(money(low))} – ${escapeHtml(money(high))}</strong><span class="quiet">${escapeHtml(basis)}</span></div>
<p>It is not an offer. ${company} or the UPB Capital desk will be in touch to look at the file.</p>
<p><a class="button" href="${WIDGET_PATH}/${encodeURIComponent(broker.code)}">Price another note</a></p>
<p class="fine"><a href="${escapeHtml(privacy())}" target="_blank" rel="noopener">Privacy policy</a></p>`;
  return page(`Your range · ${broker.company}`, body);
}

export async function GET(_request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const broker = await widgetBroker(code);
  if (!broker) return unavailable();
  return respond(formPage(broker), 200, broker.origins);
}

export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const broker = await widgetBroker(code);
  if (!broker) return unavailable();
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY) return respond(formPage(broker, {}, "That was too long. Shorten the note and try again."), 413, broker.origins);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return respond(formPage(broker, {}, "That didn't go through. Try again."), 400, broker.origins);
  }
  const values: WidgetFields = Object.fromEntries(FIELDS.map((name) => [name, String(form.get(name) ?? "").slice(0, 2000)]));
  const ip = clientAddress(request.headers.get("x-forwarded-for"), request.headers.get("x-real-ip"));
  const result = await fileWidgetLead(broker, values, ip);
  if (result.error !== null) return respond(formPage(broker, values, result.error), result.status, broker.origins);
  return respond(resultPage(broker, result.quote.low, result.quote.high, result.quote.basis), 200, broker.origins);
}
