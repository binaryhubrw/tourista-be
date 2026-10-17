// Every transactional email the platform sends. Senders never throw: a failed email is logged and must not
// fail the action that triggered it. Delivery itself is queued and retried by `providers/mail.ts`.
import path from 'node:path';
import { config, uploadDir } from '../config.js';
import { bookingLines } from '../domain/availability.js';
import { minDue, paymentTransfers, remainingDue } from '../domain/lifecycle.js';
import { payoutAccount } from '../domain/payout.js';
import { Business, User } from '../models/index.js';
import { logger } from '../logger.js';
import { buildInvoicePdf, invoiceNumber, invoiceState, type InvoiceHost } from '../providers/invoice.js';
import { sendMail, type MailAttachment } from '../providers/mail.js';
import { link, niceDate, niceDateTime, renderEmail, rwf, type EmailContent } from '../providers/emailTemplates.js';
import { hostRecipients } from './hosts.js';

const METHOD: Record<string, string> = { card: 'Bank transfer', mtn: 'MTN Mobile Money', airtel: 'Airtel Money' };
const ref = (b: { _id?: string; id?: string }) => String(b._id ?? b.id).toUpperCase();

/** Runs a sender, logging instead of throwing. */
async function safely(kind: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    logger.error({ err, kind }, 'could not prepare email');
  }
}

interface Contact { id: string; email: string; name: string; role: string; wantsBookingEmails: boolean }

async function contacts(ids: (string | undefined | null)[]): Promise<Contact[]> {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  if (!unique.length) return [];
  const users = await User.find({ _id: { $in: unique } }, { email: 1, name: 1, role: 1, preferences: 1, active: 1 }).lean<any[]>();
  return users
    .filter((u) => u.email && u.active !== false)
    .map((u) => ({ id: u._id, email: u.email, name: u.name, role: u.role, wantsBookingEmails: u.preferences?.bookingEmails !== false }));
}

async function adminContacts() {
  return contacts((await User.find({ role: 'admin' }, { _id: 1 }).lean<any[]>()).map((u) => u._id));
}

async function hostContacts(booking: any, respectPreference = true) {
  const list = await contacts(await hostRecipients(booking));
  return respectPreference ? list.filter((c) => c.wantsBookingEmails) : list;
}

async function guestWants(booking: any) {
  const [guest] = await contacts([booking.userId]);
  return guest ? guest.wantsBookingEmails : true; // a guest without an account row (admin-made) still gets mail
}

async function hostInfo(booking: any): Promise<InvoiceHost> {
  const business = booking.businessId ? await Business.findById(booking.businessId, { name: 1, phone: 1, email: 1, ownerId: 1 }).lean<any>() : null;
  const owner = (booking.ownerId ?? business?.ownerId) ? await User.findById(booking.ownerId ?? business?.ownerId, { name: 1, businessName: 1, email: 1, phone: 1 }).lean<any>() : null;
  return {
    businessName: owner?.businessName?.trim() || business?.name || booking.targetName,
    ownerName: owner?.name,
    email: business?.email || owner?.email,
    phone: business?.phone || owner?.phone,
  };
}

export async function invoiceAttachment(booking: any): Promise<MailAttachment> {
  const pdf = await buildInvoicePdf(booking, await hostInfo(booking));
  return { filename: `${invoiceNumber(booking)}.pdf`, content: pdf, contentType: 'application/pdf' };
}

/** A photo we stored ourselves can be attached; anything else is linked instead. */
function photoAttachment(url: string | undefined, filename: string): MailAttachment | null {
  if (!url) return null;
  const prefix = `${config.PUBLIC_MEDIA_URL.replace(/\/$/, '')}/`;
  const legacy = prefix.replace(/\/uploads\/$/, '/media/');
  const base = url.startsWith(prefix) ? url.slice(prefix.length) : url.startsWith(legacy) ? url.slice(legacy.length) : null;
  if (!base || !/^[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/i.test(base)) return null;
  const ext = path.extname(base).toLowerCase();
  return { filename: `${filename}${ext}`, path: path.join(uploadDir, base), contentType: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg' };
}

const guestLink = (b: any) => link(`/dashboard/bookings/${b._id ?? b.id}`);
const hostLink = (b: any) => link(`/business-dashboard/bookings/${b._id ?? b.id}`);
const when = (b: any) => (b.endDate ? `${niceDate(b.date)} to ${niceDate(b.endDate)}` : niceDate(b.date));

function bookingFacts(b: any): [string, string][] {
  return [
    ['Reference', ref(b)],
    ['Booking', b.targetName],
    ['Dates', when(b)],
    ['Guests', String(b.people)],
    ['Total', rwf(b.totalRwf)],
  ];
}

const bookingLinesOf = (b: any) =>
  bookingLines(b).map((l) => ({
    name: `${l.serviceName} × ${l.units}`,
    detail: l.plateNumbers?.length ? `Plate ${l.plateNumbers.join(', ')}` : undefined,
    total: l.lineTotalRwf,
  }));

function send(to: string | string[], content: EmailContent, kind: string, attachments?: MailAttachment[]) {
  const { subject, html, text } = renderEmail(content);
  sendMail({ to, subject, html, text, attachments, kind });
}

/** Where the guest sends money, per method the owner has set up. Approved guests need the full numbers. */
async function payoutLines(booking: any): Promise<[string, string][]> {
  const ownerId = booking.ownerId;
  if (!ownerId) return [];
  const owner = await User.findById(ownerId).lean<any>();
  if (!owner) return [];
  const name = owner.businessName?.trim() || owner.name;
  const target = { businessName: name, bankAccount: owner.bankAccount, mtnNumber: owner.mtnNumber, airtelNumber: owner.airtelNumber };
  return (['mtn', 'airtel', 'card'] as const)
    .map((m) => [METHOD[m], payoutAccount(target, m)] as [string, string])
    .filter(([, account]) => account)
    .map(([label, account]) => [`Send via ${label}`, `${account} (${name})`]);
}

// ============================================================ bookings ====

export const emailBookingRequested = (b: any) => safely('booking.requested', async () => {
  if (await guestWants(b)) {
    send(b.customerEmail, {
      subject: `We received your booking request (${ref(b)})`,
      preheader: `${b.targetName} will review your request shortly.`,
      heading: 'Your booking request is in',
      paragraphs: [
        `Hello ${b.customerName}, we sent your request to ${b.targetName}. They usually answer quickly.`,
        'Nothing is charged yet. If the host approves, you will get an email with how to pay and a two-hour window to send the first 30%.',
      ],
      facts: bookingFacts(b),
      lines: bookingLinesOf(b),
      cta: { label: 'View your booking', url: guestLink(b) },
    }, 'booking.requested');
  }
  const hosts = await hostContacts(b);
  if (hosts.length) {
    send(hosts.map((h) => h.email), {
      subject: `New booking request: ${b.targetName} (${ref(b)})`,
      preheader: `${b.customerName} wants to book ${b.targetName}.`,
      heading: 'New booking request',
      paragraphs: [`${b.customerName} asked to book ${b.targetName}. Approve or decline it so they can plan.`],
      facts: [...bookingFacts(b), ['Guest', `${b.customerName} · ${b.customerEmail}${b.customerPhone ? ` · ${b.customerPhone}` : ''}`], ...(b.notes ? [['Notes', b.notes] as [string, string]] : [])],
      lines: bookingLinesOf(b),
      cta: { label: 'Review the request', url: hostLink(b) },
    }, 'booking.requested.host');
  }
});

export const emailBookingApproved = (b: any) => safely('booking.approved', async () => {
  if (!(await guestWants(b))) return;
  const due = minDue(b.totalRwf);
  send(b.customerEmail, {
    subject: `Approved: pay to confirm ${b.targetName} (${ref(b)})`,
    preheader: `Send at least ${rwf(due)} within two hours to confirm.`,
    heading: 'The host approved your booking',
    paragraphs: [
      `Good news, ${b.customerName}. ${b.targetName} approved your request.`,
      `To confirm it, send at least 30% (${rwf(due)}) to the host and upload a screenshot of the transfer in your booking. You can pay the rest later.`,
    ],
    callout: `Pay before ${niceDateTime(b.paymentDueAt)}. After that the booking expires and the dates are released.`,
    facts: [...bookingFacts(b), ['Minimum to confirm', rwf(due)], ...(await payoutLines(b))],
    cta: { label: 'Upload your payment proof', url: guestLink(b) },
  }, 'booking.approved');
});

export const emailBookingDeclined = (b: any) => safely('booking.declined', async () => {
  if (!(await guestWants(b))) return;
  send(b.customerEmail, {
    subject: `Your booking request was declined (${ref(b)})`,
    preheader: `${b.targetName} could not take this booking.`,
    heading: 'Your booking was declined',
    paragraphs: [
      `Hello ${b.customerName}, unfortunately ${b.targetName} could not take your booking for ${when(b)}.`,
      ...(b.declinedReason ? [`Reason from the host: ${b.declinedReason}`] : []),
      'Nothing was charged. You can pick other dates or another place on Tourista Rwanda.',
    ],
    facts: bookingFacts(b),
    cta: { label: 'Find another place', url: link('/explore') },
  }, 'booking.declined');
});

export const emailPaymentReminder = (b: any) => safely('booking.reminder', async () => {
  if (!(await guestWants(b))) return;
  send(b.customerEmail, {
    subject: `Last chance to pay for ${b.targetName} (${ref(b)})`,
    preheader: 'Your approval expires soon.',
    heading: 'Your payment window is closing',
    paragraphs: [`Hello ${b.customerName}, send at least ${rwf(minDue(b.totalRwf))} to keep your booking.`],
    callout: `Pay before ${niceDateTime(b.paymentDueAt)} or the booking expires.`,
    facts: bookingFacts(b),
    cta: { label: 'Pay now', url: guestLink(b) },
  }, 'booking.reminder');
});

export const emailBookingExpired = (b: any) => safely('booking.expired', async () => {
  if (!(await guestWants(b))) return;
  send(b.customerEmail, {
    subject: `Your booking expired (${ref(b)})`,
    heading: 'The payment window closed',
    paragraphs: [`Hello ${b.customerName}, the two-hour window to pay for ${b.targetName} closed, so the dates were released. You can request them again at any time.`],
    facts: bookingFacts(b),
    cta: { label: 'Book again', url: link('/explore') },
  }, 'booking.expired');
});

/** The proof a guest uploaded: the guest gets a receipt with the invoice, the host gets the screenshot to check. */
export const emailPaymentProof = (b: any) => safely('payment.proof', async () => {
  const transfers = paymentTransfers(b.payment);
  const latest = transfers[transfers.length - 1];
  if (!latest) return;
  const invoice = await invoiceAttachment(b);
  const facts: [string, string][] = [
    ['Reference', ref(b)],
    ['Booking', b.targetName],
    ['Amount sent', rwf(latest.amountRwf)],
    ['Method', METHOD[latest.method] ?? latest.method],
    ['From', `${latest.senderName} · ${latest.senderAccount}`],
    ['Sent to', `${latest.sentToLabel ?? ''} ${latest.sentTo ?? ''}`.trim() || 'the host'],
    ['Payment reference', latest.reference],
    ['Sent at', niceDateTime(latest.paidAt)],
  ];
  const proofLink: [string, string][] = latest.screenshot && !photoAttachment(latest.screenshot, 'x') ? [['Screenshot', latest.screenshot]] : [];

  send(b.customerEmail, {
    subject: `Payment proof received (${ref(b)})`,
    preheader: `We told ${b.targetName} to check ${rwf(latest.amountRwf)}.`,
    heading: 'We received your payment proof',
    paragraphs: [
      `Hello ${b.customerName}, we passed your transfer details to ${b.targetName}. Your booking is confirmed as soon as they see the money in their account.`,
      'A copy of your payment record is attached as an invoice.',
    ],
    facts: [...facts, ...proofLink],
    cta: { label: 'Track your booking', url: guestLink(b) },
  }, 'payment.proof', [invoice]);

  const hosts = await hostContacts(b);
  if (hosts.length) {
    const screenshot = photoAttachment(latest.screenshot, `payment-proof-${ref(b)}`);
    send(hosts.map((h) => h.email), {
      subject: `Payment proof to check: ${b.customerName} sent ${rwf(latest.amountRwf)} (${ref(b)})`,
      preheader: 'Check your account, then confirm in Tourista.',
      heading: 'A guest sent payment proof',
      paragraphs: [
        `${b.customerName} says they sent ${rwf(latest.amountRwf)} for ${b.targetName}. Check your ${METHOD[latest.method] ?? 'account'}, then confirm that the money arrived.`,
        ...(screenshot ? ['Their screenshot is attached.'] : []),
      ],
      facts: [...facts, ['Booking total', rwf(b.totalRwf)], ['Still to come', rwf(remainingDue(b))], ...proofLink],
      cta: { label: 'Confirm the payment', url: hostLink(b) },
    }, 'payment.proof.host', [invoice, ...(screenshot ? [screenshot] : [])]);
  }
});

/** The host confirmed receipt: this is the invoice email. Always sent to the guest. */
export const emailPaymentConfirmed = (b: any) => safely('payment.confirmed', async () => {
  const invoice = await invoiceAttachment(b);
  const state = invoiceState(b);
  const left = remainingDue(b);
  send(b.customerEmail, {
    subject: `${state === 'PAID' ? 'Booking confirmed' : 'Payment received'}: ${b.targetName} (${ref(b)})`,
    preheader: `Invoice ${invoiceNumber(b)} is attached.`,
    heading: state === 'PAID' ? 'Your booking is confirmed' : 'Your payment was confirmed',
    paragraphs: [
      `Thank you, ${b.customerName}. ${b.targetName} confirmed your payment.`,
      left > 0 ? `Your dates are secured. ${rwf(left)} is still due, which you can send from your booking at any time.` : 'Your booking is paid in full.',
      `Your invoice ${invoiceNumber(b)} is attached to this email.`,
    ],
    facts: [
      ...bookingFacts(b),
      ['Paid so far', rwf(b.payment?.amountRwf ?? 0)],
      ['Balance due', rwf(left)],
      ...(b.payment?.sentToLabel ? [['Paid to', `${b.payment.sentToLabel} ${b.payment.sentTo ?? ''}`.trim()] as [string, string]] : []),
    ],
    lines: bookingLinesOf(b),
    total: { label: 'Total', value: rwf(b.totalRwf) },
    cta: { label: 'View your booking', url: guestLink(b) },
  }, 'payment.confirmed', [invoice]);

  const hosts = await hostContacts(b);
  if (hosts.length) {
    send(hosts.map((h) => h.email), {
      subject: `Payment confirmed: ${b.customerName} · ${b.targetName} (${ref(b)})`,
      heading: 'Payment confirmed',
      paragraphs: [`You confirmed ${rwf(b.payment?.amountRwf ?? 0)} from ${b.customerName}. The invoice is attached for your records.`],
      facts: [...bookingFacts(b), ['Balance due', rwf(left)]],
      cta: { label: 'Open the booking', url: hostLink(b) },
    }, 'payment.confirmed.host', [invoice]);
  }
});

export const emailBookingCanceled = (b: any, canceledByGuest: boolean) => safely('booking.canceled', async () => {
  if (canceledByGuest) {
    const hosts = await hostContacts(b);
    if (!hosts.length) return;
    send(hosts.map((h) => h.email), {
      subject: `Booking canceled by the guest (${ref(b)})`,
      heading: 'A guest canceled',
      paragraphs: [`${b.customerName} canceled their booking for ${b.targetName}. The dates are free again.`],
      facts: bookingFacts(b),
      cta: { label: 'Open bookings', url: hostLink(b) },
    }, 'booking.canceled.host');
    return;
  }
  if (!(await guestWants(b))) return;
  send(b.customerEmail, {
    subject: `Your booking was canceled (${ref(b)})`,
    heading: 'Your booking was canceled',
    paragraphs: [`Hello ${b.customerName}, your booking for ${b.targetName} on ${when(b)} was canceled. Nothing further is due.`],
    facts: bookingFacts(b),
    cta: { label: 'Find another place', url: link('/explore') },
  }, 'booking.canceled');
});

// ============================================================= refunds ====

const refundFacts = (r: any, b: any): [string, string][] => [
  ['Booking', `${b.targetName} (${ref(b)})`],
  ['Refund amount', rwf(r.amountRwf)],
  ['Refund to', `${METHOD[r.receiveMethod] ?? ''} ${r.receiveAccount ?? ''} (${r.receiveName ?? ''})`.trim()],
];

export const emailRefundRequested = (r: any, b: any) => safely('refund.requested', async () => {
  const proof = photoAttachment(r.travelerProof, `refund-evidence-${ref(b)}`);
  if (await guestWants(b)) {
    send(b.customerEmail, {
      subject: `Refund request received (${ref(b)})`,
      heading: 'We received your refund request',
      paragraphs: ['An admin reviews every refund first. If it is approved, the host sends the money back to the account you gave us.', `Your reason: ${r.reason}`],
      facts: refundFacts(r, b),
      cta: { label: 'Track your refund', url: link(`/dashboard/refunds/${r._id ?? r.id}`) },
    }, 'refund.requested');
  }
  const admins = await adminContacts();
  if (admins.length) {
    send(admins.map((a) => a.email), {
      subject: `Refund needs a decision: ${b.customerName} · ${b.targetName}`,
      heading: 'A refund is waiting for you',
      paragraphs: [`${b.customerName} asked for a refund.`, `Reason: ${r.reason}`, ...(proof ? ['Their evidence is attached.'] : [])],
      facts: refundFacts(r, b),
      cta: { label: 'Review the refund', url: link(`/admin/refunds/${r._id ?? r.id}`) },
    }, 'refund.requested.admin', proof ? [proof] : undefined);
  }
  const hosts = await hostContacts(b);
  if (hosts.length) {
    send(hosts.map((h) => h.email), {
      subject: `Refund requested on ${b.targetName} (${ref(b)})`,
      heading: 'A guest asked for a refund',
      paragraphs: [`${b.customerName} asked for a refund. Admin reviews it first; you only act if it is approved.`, `Reason: ${r.reason}`],
      facts: refundFacts(r, b),
      cta: { label: 'Open the refund', url: link(`/business-dashboard/refunds/${r._id ?? r.id}`) },
    }, 'refund.requested.host');
  }
});

export const emailRefundApproved = (r: any, b: any) => safely('refund.approved', async () => {
  const hosts = await hostContacts(b, false); // the host has to act on this one
  if (hosts.length) {
    send(hosts.map((h) => h.email), {
      subject: `Send the refund to ${b.customerName} (${ref(b)})`,
      heading: 'Admin approved a refund: please send it',
      paragraphs: [
        `Send ${rwf(r.amountRwf)} to the account below, then upload your receipt in the refund so the guest and admin can see it.`,
      ],
      facts: [...refundFacts(r, b), ...(r.steps?.length ? [['Admin note', r.steps[r.steps.length - 1].note ?? '—'] as [string, string]] : [])],
      cta: { label: 'Complete the refund', url: link(`/business-dashboard/refunds/${r._id ?? r.id}`) },
    }, 'refund.approved.host');
  }
  if (await guestWants(b)) {
    send(b.customerEmail, {
      subject: `Your refund was approved (${ref(b)})`,
      heading: 'Your refund was approved',
      paragraphs: [`${b.targetName} will now send ${rwf(r.amountRwf)} to the account you gave us. We will email you again once it is sent.`],
      facts: refundFacts(r, b),
      cta: { label: 'Track your refund', url: link(`/dashboard/refunds/${r._id ?? r.id}`) },
    }, 'refund.approved');
  }
});

export const emailRefundRejected = (r: any, b: any, note?: string) => safely('refund.rejected', async () => {
  if (!(await guestWants(b))) return;
  send(b.customerEmail, {
    subject: `Your refund request was not approved (${ref(b)})`,
    heading: 'Your refund was not approved',
    paragraphs: [`Hello ${b.customerName}, your refund request for ${b.targetName} was not approved.`, ...(note ? [`Note from admin: ${note}`] : []), 'Your booking stays confirmed.'],
    facts: refundFacts(r, b),
    cta: { label: 'View your booking', url: guestLink(b) },
  }, 'refund.rejected');
});

export const emailRefundCompleted = (r: any, b: any) => safely('refund.completed', async () => {
  const receipt = photoAttachment(r.returnTransfer?.proof ?? r.ownerReturnProof, `refund-receipt-${ref(b)}`);
  const invoice = await invoiceAttachment(b);
  send(b.customerEmail, {
    subject: `Your refund was sent (${ref(b)})`,
    preheader: `${rwf(r.amountRwf)} is on its way back to you.`,
    heading: 'Your refund was sent',
    paragraphs: [
      `${b.targetName} sent ${rwf(r.amountRwf)} to ${r.receiveAccount}. It should be in your account shortly.`,
      'The host’s transfer receipt and an updated invoice are attached.',
    ],
    facts: [
      ...refundFacts(r, b),
      ...(r.returnTransfer ? [['Sent from', `${r.returnTransfer.senderName} · ${r.returnTransfer.senderAccount}`] as [string, string], ['Reference', r.returnTransfer.reference] as [string, string], ['Sent at', niceDateTime(r.returnTransfer.sentAt)] as [string, string]] : []),
    ],
    cta: { label: 'View the refund', url: link(`/dashboard/refunds/${r._id ?? r.id}`) },
  }, 'refund.completed', [invoice, ...(receipt ? [receipt] : [])]);
});

// ============================================================ accounts ====

export const emailWelcome = (user: { name: string; email: string; role: string }) => safely('account.welcome', async () => {
  const host = user.role === 'business_owner';
  send(user.email, {
    subject: `Welcome to ${'Tourista Rwanda'}`,
    preheader: host ? 'Add your first listing.' : 'Start planning your trip.',
    heading: `Welcome, ${user.name}`,
    paragraphs: host
      ? ['Your business account is ready. Add your listings, set your rooms or vehicles, and start receiving booking requests.', 'Guests send money directly to the bank and mobile money numbers on your profile, so keep them up to date.']
      : ['Your account is ready. Explore places, save favourites, build an itinerary and book stays, guides and cars across Rwanda.'],
    cta: host ? { label: 'Open your dashboard', url: link('/business-dashboard') } : { label: 'Start exploring', url: link('/explore') },
  }, 'account.welcome');
});

export const emailPasswordReset = (user: { name: string; email: string }, url: string) => safely('account.reset', async () => {
  send(user.email, {
    subject: 'Reset your Tourista Rwanda password',
    preheader: 'This link works for one hour.',
    heading: 'Choose a new password',
    paragraphs: [`Hello ${user.name}, use the button below to choose a new password. The link works once and expires in one hour.`],
    cta: { label: 'Reset my password', url },
    notes: ['If you did not ask for this, you can ignore this email. Your password will not change.'],
  }, 'account.reset');
});

export const emailPasswordChanged = (user: { name: string; email: string }) => safely('account.password-changed', async () => {
  send(user.email, {
    subject: 'Your password was changed',
    heading: 'Your password was changed',
    paragraphs: [`Hello ${user.name}, the password on your Tourista Rwanda account was just changed.`, 'If this was not you, reset your password straight away and contact us.'],
    cta: { label: 'Reset my password', url: link('/forgot-password') },
  }, 'account.password-changed');
});

export const emailAccountInvite = (user: { name: string; email: string; role: string }, password?: string) => safely('account.invite', async () => {
  send(user.email, {
    subject: 'Your Tourista Rwanda account is ready',
    heading: `Welcome, ${user.name}`,
    paragraphs: [
      'An administrator created an account for you.',
      ...(password ? [`Sign in with this temporary password: ${password}`, 'Change it right away from your profile once you are in.'] : ['Choose your own password to get started.']),
    ],
    cta: password ? { label: 'Sign in', url: link('/login') } : { label: 'Choose a password', url: link('/forgot-password') },
  }, 'account.invite');
});

export const emailStaffAdded = (staff: { name: string; email: string }, ownerName: string, branches: string[], password?: string) => safely('staff.added', async () => {
  send(staff.email, {
    subject: `${ownerName} added you to their team on Tourista Rwanda`,
    heading: 'You were added as a manager',
    paragraphs: [
      `Hello ${staff.name}, ${ownerName} made you a manager on Tourista Rwanda.`,
      branches.length ? `Branches you manage: ${branches.join(', ')}.` : 'They have not assigned a branch yet.',
      password ? `Sign in with this temporary password: ${password}` : 'Sign in with your email and the password the owner gave you.',
      'You can approve bookings, confirm payments and keep offerings up to date.',
    ],
    cta: { label: 'Sign in', url: link('/login') },
  }, 'staff.added');
});

export const emailStaffStatus = (staff: { name: string; email: string }, active: boolean) => safely('staff.status', async () => {
  send(staff.email, {
    subject: active ? 'Your staff account is active again' : 'Your staff account was deactivated',
    heading: active ? 'Your account is active again' : 'Your account was deactivated',
    paragraphs: [active ? `Hello ${staff.name}, you can sign in and manage your branches again.` : `Hello ${staff.name}, the owner deactivated your staff account, so you can no longer sign in. Ask them if you think this is a mistake.`],
    ...(active ? { cta: { label: 'Sign in', url: link('/login') } } : {}),
  }, 'staff.status');
});

/** An admin deactivated an account, so the person can no longer sign in. */
export const emailAccountDeactivated = (user: { name: string; email: string }, reason?: string) => safely('account.deactivated', async () => {
  send(user.email, {
    subject: 'Your Tourista Rwanda account was deactivated',
    heading: 'Your account was deactivated',
    paragraphs: [
      `Hello ${user.name}, an administrator deactivated your account, so you can no longer sign in.`,
      ...(reason ? [`Reason from admin: ${reason}`] : []),
      'If you think this is a mistake, reply to this email and we will take another look.',
    ],
  }, 'account.deactivated');
});

// ============================================================= reviews ====

export const emailNewReview = (review: any, ownerId?: string, businessId?: string) => safely('review.new', async () => {
  const hosts = await hostContacts({ ownerId, businessId });
  if (!hosts.length) return;
  send(hosts.map((h) => h.email), {
    subject: `New ${review.rating}-star review for ${review.targetName}`,
    heading: 'You have a new review',
    paragraphs: [`${review.userName} rated ${review.targetName} ${review.rating} out of 5.`, `“${review.comment}”`],
    cta: { label: 'See your reviews', url: link('/business-dashboard/reviews') },
  }, 'review.new');
});

// ========================================================== listings ====

export const emailListingSubmitted = (business: any, ownerName: string) => safely('listing.submitted', async () => {
  const admins = await adminContacts();
  if (!admins.length) return;
  send(admins.map((a) => a.email), {
    subject: `Listing to review: ${business.name}`,
    preheader: `${ownerName} submitted a listing for approval.`,
    heading: 'A listing is waiting for approval',
    paragraphs: [`${ownerName} submitted ${business.name}. It stays hidden from travellers until you approve it.`],
    facts: [['Listing', business.name], ['Category', business.category], ['District', business.district || '—'], ['Submitted by', ownerName]],
    cta: { label: 'Review the listing', url: link(`/admin/businesses/${business._id ?? business.id}`) },
  }, 'listing.submitted');
});

export const emailListingDecision = (business: any, approved: boolean, reason?: string) => safely('listing.decision', async () => {
  const [owner] = await contacts([business.ownerId]);
  if (!owner) return;
  send(owner.email, approved ? {
    subject: `${business.name} is approved and live`,
    preheader: 'Travellers can now find and book it.',
    heading: 'Your listing is live',
    paragraphs: [`Good news, ${owner.name}. ${business.name} was approved. Travellers can now find it, and you will get booking requests by email.`],
    cta: { label: 'Open your listing', url: link('/business-dashboard/business') },
  } : {
    subject: `${business.name} needs changes before it can go live`,
    heading: 'Your listing was not approved',
    paragraphs: [`Hello ${owner.name}, ${business.name} was not approved yet.`, ...(reason ? [`Reason from admin: ${reason}`] : []), 'Update the listing and save it: it is sent back for review automatically.'],
    cta: { label: 'Edit your listing', url: link('/business-dashboard/business') },
  }, approved ? 'listing.approved' : 'listing.rejected');
});

/** A "your listing is hidden" notice. One email per owner, covering every branch that changed. */
export const emailListingsHidden = (businesses: any[], reason?: string) => safely('listing.hidden', async () => {
  const byOwner = new Map<string, any[]>();
  for (const business of businesses) {
    if (!business.ownerId) continue;
    byOwner.set(business.ownerId, [...(byOwner.get(business.ownerId) ?? []), business]);
  }
  for (const [ownerId, list] of byOwner) {
    const [owner] = await contacts([ownerId]);
    if (!owner) continue;
    const names = list.map((b) => b.name);
    const many = names.length > 1;
    send(owner.email, {
      subject: many ? `${names.length} of your listings were hidden` : `${names[0]} was hidden from travellers`,
      heading: 'A listing was hidden by an administrator',
      paragraphs: [
        `Hello ${owner.name}, ${many ? 'these listings were' : `${names[0]} was`} hidden from travellers: ${names.join(', ')}.`,
        ...(reason ? [`Reason from admin: ${reason}`] : []),
        'Existing bookings are not affected. Contact us if you think this is a mistake.',
      ],
      cta: { label: 'Open your dashboard', url: link('/business-dashboard') },
    }, 'listing.hidden');
  }
});

/** Re-sends the current invoice to the guest's address (the "email me my invoice again" button). */
export async function emailInvoice(b: any) {
  const invoice = await invoiceAttachment(b);
  const state = invoiceState(b);
  send(b.customerEmail, {
    subject: `Invoice ${invoiceNumber(b)} for ${b.targetName}`,
    preheader: `Status: ${state.toLowerCase()}.`,
    heading: 'Your invoice',
    paragraphs: [`Hello ${b.customerName}, your invoice for ${b.targetName} is attached. Status: ${state.toLowerCase()}.`],
    facts: [...bookingFacts(b), ['Paid so far', rwf(b.payment?.amountRwf ?? 0)], ['Balance due', rwf(remainingDue(b))]],
    cta: { label: 'View your booking', url: guestLink(b) },
  }, 'invoice.resend', [invoice]);
}

/** Used by the admin test-email endpoint. */
export function emailTest(to: string, requestedBy: string) {
  send(to, {
    subject: 'Tourista Rwanda email test',
    heading: 'Email is working',
    paragraphs: [`This is a test message requested by ${requestedBy}. If you can read it, bookings, invoices and password resets will reach you.`],
    facts: [['Sent from', config.MAIL_FROM], ['Time', niceDateTime(new Date().toISOString())]],
  }, 'mail.test');
}

