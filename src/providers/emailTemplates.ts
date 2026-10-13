// Renders one structured message into matching HTML and plain-text bodies.
// Every user-supplied value is HTML-escaped, so names and notes cannot inject markup into an email.
import { config } from '../config.js';

export const APP_NAME = 'Tourista Rwanda';
const BRAND = '#16794a';
const INK = '#14201a';
const MUTED = '#5b6b62';
const LINE = '#e3e9e5';

export const esc = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const nf = new Intl.NumberFormat('en-US');
export const rwf = (n: number) => `RWF ${nf.format(Math.round(n))}`;

/** `2026-11-12` → `12 Nov 2026`. Plain date strings are never shifted by time zones. */
export function niceDate(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function niceDateTime(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Kigali' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kigali' })} (Kigali)`;
}

export interface EmailContent {
  subject: string;
  /** Hidden preview text shown by mail clients next to the subject. */
  preheader?: string;
  heading: string;
  /** Opening paragraphs. */
  paragraphs?: string[];
  /** Label / value rows. */
  facts?: [string, string][];
  /** An invoice-style table. */
  lines?: { name: string; detail?: string; total: number }[];
  total?: { label: string; value: string };
  /** Highlighted box, e.g. a deadline or a warning. */
  callout?: string;
  cta?: { label: string; url: string };
  /** Closing paragraphs. */
  notes?: string[];
}

export const link = (path: string) => `${config.FRONTEND_URL.replace(/\/$/, '')}${path}`;

export function renderEmail(c: EmailContent): { subject: string; html: string; text: string } {
  const p = (t: string) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:${INK}">${esc(t)}</p>`;
  const facts = c.facts?.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:6px 0 18px;border:1px solid ${LINE};border-radius:10px;border-collapse:separate;overflow:hidden">${
      c.facts.map(([k, v], i) => `<tr><td style="padding:10px 14px;font-size:13px;color:${MUTED};width:38%;${i ? `border-top:1px solid ${LINE};` : ''}">${esc(k)}</td><td style="padding:10px 14px;font-size:14px;color:${INK};font-weight:600;${i ? `border-top:1px solid ${LINE};` : ''}">${esc(v)}</td></tr>`).join('')
    }</table>`
    : '';
  const lines = c.lines?.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:6px 0 6px;border-collapse:collapse">${
      c.lines.map((l) => `<tr><td style="padding:10px 0;border-bottom:1px solid ${LINE};font-size:14px;color:${INK}">${esc(l.name)}${l.detail ? `<br><span style="font-size:12px;color:${MUTED}">${esc(l.detail)}</span>` : ''}</td><td align="right" style="padding:10px 0;border-bottom:1px solid ${LINE};font-size:14px;color:${INK};white-space:nowrap">${esc(rwf(l.total))}</td></tr>`).join('')
    }</table>`
    : '';
  const total = c.total
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 18px"><tr><td style="padding:12px 0;font-size:15px;font-weight:700;color:${INK}">${esc(c.total.label)}</td><td align="right" style="padding:12px 0;font-size:17px;font-weight:700;color:${BRAND}">${esc(c.total.value)}</td></tr></table>`
    : '';
  const callout = c.callout
    ? `<div style="margin:0 0 18px;padding:14px 16px;background:#fff7e0;border:1px solid #f1d98a;border-radius:10px;font-size:14px;line-height:1.5;color:#5c4500">${esc(c.callout)}</div>`
    : '';
  const cta = c.cta
    ? `<p style="margin:22px 0"><a href="${esc(c.cta.url)}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:10px">${esc(c.cta.label)}</a></p>`
    : '';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(c.subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(c.preheader ?? c.heading)}</span>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f6f4"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid ${LINE}">
    <tr><td style="background:${BRAND};padding:18px 28px;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.2px">${esc(APP_NAME)}</td></tr>
    <tr><td style="padding:28px">
      <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:${INK}">${esc(c.heading)}</h1>
      ${(c.paragraphs ?? []).map(p).join('')}
      ${callout}${facts}${lines}${total}${cta}
      ${(c.notes ?? []).map(p).join('')}
    </td></tr>
    <tr><td style="padding:18px 28px;border-top:1px solid ${LINE};font-size:12px;line-height:1.5;color:${MUTED}">
      You are receiving this because of activity on your ${esc(APP_NAME)} account. Questions? Just reply to this email.
    </td></tr>
  </table>
</td></tr></table></body></html>`;

  const text = [
    c.heading,
    '',
    ...(c.paragraphs ?? []).flatMap((t) => [t, '']),
    ...(c.callout ? [`! ${c.callout}`, ''] : []),
    ...(c.facts ?? []).map(([k, v]) => `${k}: ${v}`),
    ...(c.facts?.length ? [''] : []),
    ...(c.lines ?? []).map((l) => `- ${l.name}${l.detail ? ` (${l.detail})` : ''}: ${rwf(l.total)}`),
    ...(c.total ? [`${c.total.label}: ${c.total.value}`, ''] : c.lines?.length ? [''] : []),
    ...(c.cta ? [`${c.cta.label}: ${c.cta.url}`, ''] : []),
    ...(c.notes ?? []).flatMap((t) => [t, '']),
    `— ${APP_NAME}`,
  ].join('\n');

  return { subject: c.subject, html, text };
}
