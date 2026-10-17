import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { APP_NAME, niceDate, niceDateTime, rwf } from './emailTemplates.js';
import { paymentTransfers, remainingDue } from '../domain/lifecycle.js';
import { bookingLines } from '../domain/availability.js';
import { projectRoot } from '../config.js';

export interface InvoiceHost {
  businessName: string;
  ownerName?: string;
  email?: string;
  phone?: string;
}

export type InvoiceState = 'PAID' | 'PARTIALLY PAID' | 'PAYMENT PENDING CONFIRMATION' | 'REFUNDED' | 'UNPAID';

/** Where the booking stands financially, in words an invoice can print. */
export function invoiceState(booking: any): InvoiceState {
  const p = booking.payment;
  if (!p) return 'UNPAID';
  if (p.status === 'Refunded' || booking.status === 'Refunded') return 'REFUNDED';
  const transfers = paymentTransfers(p);
  const confirmed = transfers.filter((t) => t.status === 'Paid').reduce((s, t) => s + t.amountRwf, 0);
  if (confirmed <= 0) return 'PAYMENT PENDING CONFIRMATION';
  return confirmed >= booking.totalRwf ? 'PAID' : 'PARTIALLY PAID';
}

export type ReceiptState = 'PAID IN FULL' | 'PARTIALLY PAID' | 'AWAITING CONFIRMATION' | 'REFUNDED';

/** What a receipt can honestly say: money confirmed received, money waiting, or nothing yet. */
export function receiptState(booking: any): ReceiptState {
  const p = booking.payment;
  if (!p) return 'AWAITING CONFIRMATION';
  if (p.status === 'Refunded' || booking.status === 'Refunded') return 'REFUNDED';
  const confirmed = paymentTransfers(p).filter((t) => t.status === 'Paid').reduce((s, t) => s + t.amountRwf, 0);
  if (confirmed <= 0) return 'AWAITING CONFIRMATION';
  return confirmed >= booking.totalRwf ? 'PAID IN FULL' : 'PARTIALLY PAID';
}

const idOf = (booking: { _id?: string; id?: string }) => String(booking._id ?? booking.id).toUpperCase();

export const invoiceNumber = (booking: { _id?: string; id?: string }) => `INV-${idOf(booking)}`;
export const receiptNumber = (booking: { _id?: string; id?: string }) => `RCT-${idOf(booking)}`;

/** PDF core fonts only cover Latin-1; anything else is replaced so text never renders as garbage. */
const latin = (value: unknown) =>
  String(value ?? '').replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/[^\x20-\x7E\u00A0-ÿ•]/g, '?');

const BRAND = '#00628b';
const GREEN = '#16794a';
const INK = '#14201a';
const MUTED = '#5b6b62';
const RULE = '#dfe6e1';
const MARGIN = 48;

const METHOD: Record<string, string> = { card: 'Bank transfer', mtn: 'MTN Mobile Money', airtel: 'Airtel Money' };

/** The platform's wordmark, read once from `assets/`. Missing file simply falls back to text. */
let logoCache: Buffer | null | undefined;
function wordLogo(): Buffer | null {
  if (logoCache !== undefined) return logoCache;
  try {
    logoCache = fs.readFileSync(path.join(projectRoot, 'assets', 'word-logo.jpeg'));
  } catch {
    logoCache = null;
  }
  return logoCache;
}

/** Type of the pdfkit document, spelled once. */
type Doc = PDFKit.PDFDocument;

/**
 * Document header: the wordmark on the left, the document kind on the right, a brand rule underneath.
 * Leaves the cursor just below the rule so callers can keep writing.
 */
function drawHeader(doc: Doc, kind: string, width: number) {
  const logo = wordLogo();
  if (logo) {
    doc.image(logo, MARGIN, 36, { width: 170 });
  } else {
    doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(22).text(APP_NAME, MARGIN, 66);
  }
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(18).text(kind, MARGIN, 56, { width, align: 'right' });
  doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(APP_NAME, MARGIN, 84, { width, align: 'right' });
  doc.moveTo(MARGIN, 142).lineTo(MARGIN + width, 142).strokeColor(BRAND).lineWidth(2).stroke();
  doc.x = MARGIN;
  doc.y = 164;
  doc.fillColor(INK);
}

function rule(doc: Doc, width: number) {
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y).strokeColor(RULE).lineWidth(1).stroke();
  doc.moveDown(0.6);
}

/** BILLED TO / PROVIDER (invoice) or PAID BY / RECEIVED BY (receipt). */
function parties(doc: Doc, booking: any, host: InvoiceHost, width: number, [leftLabel, rightLabel]: [string, string]) {
  const top = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text(leftLabel, MARGIN, top);
  doc.font('Helvetica').fontSize(11).fillColor(INK)
    .text(latin(booking.customerName), MARGIN, top + 14, { width: width / 2 - 10 })
    .text(latin(booking.customerEmail))
    .text(latin(booking.customerPhone || ''));
  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text(rightLabel, MARGIN + width / 2, top);
  doc.font('Helvetica').fontSize(11).fillColor(INK)
    .text(latin(host.businessName), MARGIN + width / 2, top + 14, { width: width / 2 })
    .text(latin(host.ownerName ?? ''))
    .text(latin([host.email, host.phone].filter(Boolean).join('  |  ')));
  doc.y = Math.max(doc.y, top + 74);
  doc.x = MARGIN;
  doc.moveDown(0.6);
  rule(doc, width);
}

function bookingBlock(doc: Doc, booking: any) {
  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('BOOKING', MARGIN);
  doc.moveDown(0.3);
  const dates = booking.endDate ? `${niceDate(booking.date)} to ${niceDate(booking.endDate)}` : niceDate(booking.date);
  doc.font('Helvetica').fontSize(11).fillColor(INK)
    .text(latin(booking.targetName), MARGIN)
    .text(`Dates: ${dates}${booking.nights ? `  (${booking.nights} ${booking.nights === 1 ? 'night/day' : 'nights/days'})` : ''}`)
    .text(`Guests: ${booking.people}`)
    .text(`Reference: ${idOf(booking)}`);
  doc.moveDown(0.8);
}

/** Every transfer on the booking, one line each. */
function transferRows(doc: Doc, booking: any, width: number) {
  const colRef = MARGIN + 175;
  doc.font('Helvetica').fontSize(10).fillColor(INK);
  for (const t of paymentTransfers(booking.payment)) {
    const y = doc.y;
    doc.text(`${niceDateTime(t.paidAt)}`, MARGIN, y, { width: 170 })
      .text(`${METHOD[t.method] ?? t.method}  |  ${latin(t.reference)}`, colRef, y, { width: 190 })
      .text(`${rwf(t.amountRwf)}  ${t.status === 'Paid' ? 'confirmed' : 'awaiting confirmation'}`, MARGIN + width - 140, y, { width: 140, align: 'right' });
    doc.y = y + 16;
    doc.x = MARGIN;
  }
}

function footer(doc: Doc, text: string, width: number) {
  doc.fontSize(9).fillColor(MUTED).font('Helvetica')
    .text(text, MARGIN, doc.page.height - 80, { width, align: 'center' });
}

export function buildInvoicePdf(booking: any, host: InvoiceHost): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: `Invoice ${invoiceNumber(booking)}`, Author: APP_NAME } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - MARGIN * 2;
    const state = invoiceState(booking);

    drawHeader(doc, 'Invoice', width);

    doc.font('Helvetica-Bold').fontSize(18).fillColor(INK).text(invoiceNumber(booking), MARGIN, doc.y);
    doc.font('Helvetica').fontSize(10).fillColor(MUTED)
      .text(`Issued ${niceDate(new Date().toISOString())}  |  Booked ${niceDate(booking.createdAt)}`);
    const stateColor = state === 'PAID' ? GREEN : state === 'REFUNDED' ? '#8a5a00' : '#a14a00';
    doc.moveDown(0.4).font('Helvetica-Bold').fontSize(11).fillColor(stateColor).text(`Status: ${state}`);
    doc.moveDown(1);

    parties(doc, booking, host, width, ['BILLED TO', 'PROVIDER']);
    bookingBlock(doc, booking);

    // Lines
    const colQty = MARGIN + width - 190;
    const colUnit = MARGIN + width - 120;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED);
    const headY = doc.y;
    doc.text('ITEM', MARGIN, headY).text('QTY', colQty, headY, { width: 40, align: 'right' })
      .text('UNIT PRICE', colUnit, headY, { width: 70, align: 'right' }).text('TOTAL', MARGIN + width - 50, headY, { width: 50, align: 'right' });
    doc.y = headY + 14;
    doc.x = MARGIN;
    rule(doc, width);
    doc.font('Helvetica').fontSize(11).fillColor(INK);
    for (const line of bookingLines(booking)) {
      const y = doc.y;
      const name = latin(line.serviceName) + (line.plateNumbers?.length ? `\nPlate: ${line.plateNumbers.map(latin).join(', ')}` : '');
      doc.text(name, MARGIN, y, { width: colQty - MARGIN - 8 });
      const after = doc.y;
      doc.text(String(line.units), colQty, y, { width: 40, align: 'right' })
        .text(rwf(line.unitPriceRwf).replace('RWF ', ''), colUnit, y, { width: 70, align: 'right' })
        .text(rwf(line.lineTotalRwf).replace('RWF ', ''), MARGIN + width - 50, y, { width: 50, align: 'right' });
      doc.y = Math.max(after, y + 14) + 4;
      doc.x = MARGIN;
    }
    rule(doc, width);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(INK);
    const totalY = doc.y;
    doc.text('Total', MARGIN, totalY).text(rwf(booking.totalRwf), MARGIN, totalY, { width, align: 'right' });
    doc.moveDown(1.2);
    doc.x = MARGIN;

    // Payments
    const transfers = paymentTransfers(booking.payment);
    if (transfers.length) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('PAYMENTS', MARGIN);
      doc.moveDown(0.3);
      transferRows(doc, booking, width);
      doc.moveDown(0.5);
      const confirmed = transfers.filter((t) => t.status === 'Paid').reduce((s, t) => s + t.amountRwf, 0);
      doc.font('Helvetica').fontSize(11).fillColor(INK);
      const row = (label: string, value: string, bold = false) => {
        const y = doc.y;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(label, MARGIN, y).text(value, MARGIN, y, { width, align: 'right' });
        doc.x = MARGIN;
      };
      row('Confirmed by the host', rwf(confirmed));
      row('Sent, awaiting confirmation', rwf(transfers.filter((t) => t.status === 'Pending').reduce((s, t) => s + t.amountRwf, 0)));
      if (state !== 'REFUNDED') row('Balance still due', rwf(remainingDue(booking)), true);
      if (booking.payment?.sentToLabel) {
        doc.moveDown(0.8).font('Helvetica').fontSize(10).fillColor(MUTED)
          .text(`Paid to: ${latin(booking.payment.sentToLabel)}${booking.payment.sentTo ? `  ${latin(booking.payment.sentTo)}` : ''}`, MARGIN);
      }
    }

    footer(doc, 'This invoice is generated by Tourista Rwanda. Payments are made directly to the provider; Tourista Rwanda records and confirms them.', width);
    doc.end();
  });
}

export function buildReceiptPdf(booking: any, host: InvoiceHost): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: `Receipt ${receiptNumber(booking)}`, Author: APP_NAME } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - MARGIN * 2;
    const state = receiptState(booking);
    const transfers = paymentTransfers(booking.payment);
    const confirmed = transfers.filter((t) => t.status === 'Paid').reduce((s, t) => s + t.amountRwf, 0);
    const awaiting = transfers.filter((t) => t.status === 'Pending').reduce((s, t) => s + t.amountRwf, 0);

    drawHeader(doc, 'Receipt', width);

    doc.font('Helvetica-Bold').fontSize(18).fillColor(INK).text(receiptNumber(booking), MARGIN, doc.y);
    doc.font('Helvetica').fontSize(10).fillColor(MUTED)
      .text(`Issued ${niceDate(new Date().toISOString())}  |  Booking ${niceDate(booking.createdAt)}`);
    const stateColor = state === 'PAID IN FULL' ? GREEN : state === 'REFUNDED' ? '#8a5a00' : '#a14a00';
    doc.moveDown(0.4).font('Helvetica-Bold').fontSize(11).fillColor(stateColor).text(`Status: ${state}`);
    doc.moveDown(1);

    parties(doc, booking, host, width, ['PAID BY', 'RECEIVED BY']);
    bookingBlock(doc, booking);

    if (transfers.length) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('PAYMENTS RECEIVED', MARGIN);
      doc.moveDown(0.3);
      transferRows(doc, booking, width);
      doc.moveDown(0.5);
      const row = (label: string, value: string, bold = false) => {
        const y = doc.y;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(INK).text(label, MARGIN, y).text(value, MARGIN, y, { width, align: 'right' });
        doc.x = MARGIN;
      };
      row('Booking total', rwf(booking.totalRwf));
      row('Received so far', rwf(confirmed), true);
      row('Awaiting confirmation', rwf(awaiting));
      if (state !== 'REFUNDED') row('Balance still due', rwf(remainingDue(booking)));
      doc.moveDown(0.8);
      doc.x = MARGIN;
      if (booking.payment?.sentToLabel) {
        doc.font('Helvetica').fontSize(10).fillColor(MUTED)
          .text(`Paid to: ${latin(booking.payment.sentToLabel)}${booking.payment.sentTo ? `  ${latin(booking.payment.sentTo)}` : ''}`, MARGIN);
      }
    }

    footer(doc, 'This receipt records payments sent to the provider for this booking and confirmed on Tourista Rwanda. Keep it as your proof of payment.', width);
    doc.end();
  });
}
