import PDFDocument from 'pdfkit';
import { APP_NAME, niceDate, niceDateTime, rwf } from './emailTemplates.js';
import { paymentTransfers, remainingDue } from '../domain/lifecycle.js';
import { bookingLines } from '../domain/availability.js';

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

export const invoiceNumber = (booking: { _id?: string; id?: string }) => `INV-${String(booking._id ?? booking.id).toUpperCase()}`;

/** PDF core fonts only cover Latin-1; anything else is replaced so text never renders as garbage. */
const latin = (value: unknown) =>
  String(value ?? '').replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/[^\x20-\x7E\u00A0-ÿ•]/g, '?');

const GREEN = '#16794a';
const INK = '#14201a';
const MUTED = '#5b6b62';
const RULE = '#dfe6e1';

const METHOD: Record<string, string> = { card: 'Bank transfer', mtn: 'MTN Mobile Money', airtel: 'Airtel Money' };

export function buildInvoicePdf(booking: any, host: InvoiceHost): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Invoice ${invoiceNumber(booking)}`, Author: APP_NAME } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 48;
    const right = doc.page.width - 48;
    const width = right - left;
    const rule = () => { doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(RULE).lineWidth(1).stroke(); doc.moveDown(0.6); };
    const state = invoiceState(booking);

    // Header
    doc.rect(0, 0, doc.page.width, 78).fill(GREEN);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20).text(APP_NAME, left, 26);
    doc.font('Helvetica').fontSize(11).text('Invoice', left, 30, { width, align: 'right' });
    doc.fillColor(INK);

    doc.moveDown(3.2);
    doc.font('Helvetica-Bold').fontSize(18).text(invoiceNumber(booking), left);
    doc.font('Helvetica').fontSize(10).fillColor(MUTED)
      .text(`Issued ${niceDate(new Date().toISOString())}  |  Booked ${niceDate(booking.createdAt)}`);
    const stateColor = state === 'PAID' ? GREEN : state === 'REFUNDED' ? '#8a5a00' : '#a14a00';
    doc.moveDown(0.4).font('Helvetica-Bold').fontSize(11).fillColor(stateColor).text(`Status: ${state}`);
    doc.moveDown(1);

    // Parties
    const top = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('BILLED TO', left, top);
    doc.font('Helvetica').fontSize(11).fillColor(INK)
      .text(latin(booking.customerName), left, top + 14, { width: width / 2 - 10 })
      .text(latin(booking.customerEmail))
      .text(latin(booking.customerPhone || ''));
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('PROVIDER', left + width / 2, top);
    doc.font('Helvetica').fontSize(11).fillColor(INK)
      .text(latin(host.businessName), left + width / 2, top + 14, { width: width / 2 })
      .text(latin(host.ownerName ?? ''))
      .text(latin([host.email, host.phone].filter(Boolean).join('  |  ')));
    doc.y = Math.max(doc.y, top + 74);
    doc.x = left;
    doc.moveDown(0.6);
    rule();

    // Booking
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('BOOKING', left);
    doc.moveDown(0.3);
    const dates = booking.endDate ? `${niceDate(booking.date)} to ${niceDate(booking.endDate)}` : niceDate(booking.date);
    doc.font('Helvetica').fontSize(11).fillColor(INK)
      .text(latin(booking.targetName), left)
      .text(`Dates: ${dates}${booking.nights ? `  (${booking.nights} ${booking.nights === 1 ? 'night/day' : 'nights/days'})` : ''}`)
      .text(`Guests: ${booking.people}`)
      .text(`Reference: ${String(booking._id ?? booking.id).toUpperCase()}`);
    doc.moveDown(0.8);

    // Lines
    const colQty = right - 190;
    const colUnit = right - 120;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED);
    const headY = doc.y;
    doc.text('ITEM', left, headY).text('QTY', colQty, headY, { width: 40, align: 'right' })
      .text('UNIT PRICE', colUnit, headY, { width: 70, align: 'right' }).text('TOTAL', right - 50, headY, { width: 50, align: 'right' });
    doc.y = headY + 14;
    doc.x = left;
    rule();
    doc.font('Helvetica').fontSize(11).fillColor(INK);
    for (const line of bookingLines(booking)) {
      const y = doc.y;
      const name = latin(line.serviceName) + (line.plateNumbers?.length ? `\nPlate: ${line.plateNumbers.map(latin).join(', ')}` : '');
      doc.text(name, left, y, { width: colQty - left - 8 });
      const after = doc.y;
      doc.text(String(line.units), colQty, y, { width: 40, align: 'right' })
        .text(rwf(line.unitPriceRwf).replace('RWF ', ''), colUnit, y, { width: 70, align: 'right' })
        .text(rwf(line.lineTotalRwf).replace('RWF ', ''), right - 50, y, { width: 50, align: 'right' });
      doc.y = Math.max(after, y + 14) + 4;
      doc.x = left;
    }
    rule();
    doc.font('Helvetica-Bold').fontSize(13).fillColor(INK);
    const totalY = doc.y;
    doc.text('Total', left, totalY).text(rwf(booking.totalRwf), left, totalY, { width, align: 'right' });
    doc.moveDown(1.2);
    doc.x = left;

    // Payments
    const transfers = paymentTransfers(booking.payment);
    if (transfers.length) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('PAYMENTS', left);
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(10).fillColor(INK);
      for (const t of transfers) {
        const y = doc.y;
        doc.text(`${niceDateTime(t.paidAt)}`, left, y, { width: 170 })
          .text(`${METHOD[t.method] ?? t.method}  |  ${latin(t.reference)}`, left + 175, y, { width: 190 })
          .text(`${rwf(t.amountRwf)}  ${t.status === 'Paid' ? 'confirmed' : 'awaiting confirmation'}`, right - 140, y, { width: 140, align: 'right' });
        doc.y = y + 16;
        doc.x = left;
      }
      doc.moveDown(0.5);
      const confirmed = transfers.filter((t) => t.status === 'Paid').reduce((s, t) => s + t.amountRwf, 0);
      doc.font('Helvetica').fontSize(11).fillColor(INK);
      const row = (label: string, value: string, bold = false) => {
        const y = doc.y;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(label, left, y).text(value, left, y, { width, align: 'right' });
        doc.x = left;
      };
      row('Confirmed by the host', rwf(confirmed));
      row('Sent, awaiting confirmation', rwf(transfers.filter((t) => t.status === 'Pending').reduce((s, t) => s + t.amountRwf, 0)));
      if (state !== 'REFUNDED') row('Balance still due', rwf(remainingDue(booking)), true);
      if (booking.payment?.sentToLabel) {
        doc.moveDown(0.8).font('Helvetica').fontSize(10).fillColor(MUTED)
          .text(`Paid to: ${latin(booking.payment.sentToLabel)}${booking.payment.sentTo ? `  ${latin(booking.payment.sentTo)}` : ''}`, left);
      }
    }

    doc.fontSize(9).fillColor(MUTED).font('Helvetica')
      .text('This invoice is generated by Tourista Rwanda. Payments are made directly to the provider; Tourista Rwanda records and confirms them.',
        left, doc.page.height - 80, { width, align: 'center' });
    doc.end();
  });
}
