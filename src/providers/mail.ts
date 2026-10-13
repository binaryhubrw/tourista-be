import nodemailer, { type Transporter } from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer/index.js';
import { config, isProd, isTest } from '../config.js';
import { logger } from '../logger.js';

export interface MailAttachment {
  filename: string;
  /** In-memory content (generated PDFs). */
  content?: Buffer;
  /** A file on disk (stored photos). */
  path?: string;
  contentType?: string;
}

export interface OutgoingMail {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: MailAttachment[];
  replyTo?: string;
  /** Template name, for logs and tests (e.g. `booking.confirmed`). */
  kind?: string;
}

export type MailMode = 'smtp' | 'json';

function createTransport(): { transport: Transporter; mode: MailMode; label: string } {
  // Tests never reach a real mail server, whatever .env contains.
  if (!isTest && config.MAIL_HOST) {
    const secure = config.MAIL_SECURE ?? config.MAIL_PORT === 465;
    return {
      mode: 'smtp',
      label: `${config.MAIL_HOST}:${config.MAIL_PORT}${secure ? ' (TLS)' : ' (STARTTLS)'}`,
      transport: nodemailer.createTransport({
        host: config.MAIL_HOST,
        port: config.MAIL_PORT,
        secure,
        requireTLS: !secure,
        auth: config.MAIL_USER ? { user: config.MAIL_USER, pass: config.MAIL_PASS } : undefined,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
        pool: true,
        maxConnections: 2,
      }),
    };
  }
  if (!isTest && config.SMTP_URL) {
    return { mode: 'smtp', label: 'SMTP_URL', transport: nodemailer.createTransport(config.SMTP_URL) };
  }
  // No SMTP configured: messages are rendered but not delivered (development and tests).
  return { mode: 'json', label: 'not configured (messages are logged, not sent)', transport: nodemailer.createTransport({ jsonTransport: true }) };
}

const { transport, mode, label } = createTransport();

export interface MailStatus {
  mode: MailMode;
  transport: string;
  from: string;
  verified: boolean | null;
  queued: number;
  sent: number;
  failed: number;
  lastError?: string;
  lastSentAt?: string;
}

const stats = { verified: null as boolean | null, sent: 0, failed: 0, lastError: undefined as string | undefined, lastSentAt: undefined as string | undefined };

/** Recent messages (metadata only), kept outside production so tests and developers can inspect them. */
export interface SentRecord {
  kind?: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  attachments: { filename: string; contentType?: string; size?: number; path?: string }[];
  at: string;
  ok: boolean;
}
const recent: SentRecord[] = [];
export const recentMail = () => recent;
export const clearRecentMail = () => { recent.length = 0; };

const MAX_ATTEMPTS = 3;
const CONCURRENCY = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Job { mail: OutgoingMail; attempt: number }
const queue: Job[] = [];
let active = 0;

const toList = (to: string | string[]) => (Array.isArray(to) ? to : [to]).map((a) => a.trim()).filter(Boolean);

async function deliver(mail: OutgoingMail) {
  const recipients = toList(mail.to);
  await transport.sendMail({
    from: config.MAIL_FROM,
    to: recipients,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    replyTo: mail.replyTo ?? config.MAIL_REPLY_TO,
    // Fresh copies every attempt: nodemailer consumes `path`/`content` on the objects it is given.
    attachments: mail.attachments?.map((a) => ({ ...a })) as Mail.Attachment[] | undefined,
  });
}

async function run(job: Job) {
  const { mail } = job;
  const recipients = toList(mail.to);
  const attachments = (mail.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.content?.length, path: a.path }));
  try {
    await deliver(mail);
    stats.sent += 1;
    stats.lastSentAt = new Date().toISOString();
    logger.info({ kind: mail.kind, to: recipients, subject: mail.subject, mode }, mode === 'smtp' ? 'email sent' : 'email rendered (mail not configured)');
    if (!isProd) {
      recent.push({
        kind: mail.kind, to: recipients, subject: mail.subject, text: mail.text, html: mail.html, at: new Date().toISOString(), ok: true,
        attachments,
      });
      if (recent.length > 300) recent.shift();
    }
  } catch (err) {
    job.attempt += 1;
    const message = err instanceof Error ? err.message : String(err);
    if (job.attempt < MAX_ATTEMPTS) {
      logger.warn({ kind: mail.kind, to: recipients, attempt: job.attempt, err: message }, 'email failed, will retry');
      await sleep(isTest ? 0 : 2000 * job.attempt ** 2);
      queue.push(job);
    } else {
      stats.failed += 1;
      stats.lastError = message;
      logger.error({ kind: mail.kind, to: recipients, err: message }, 'email failed permanently');
      if (!isProd) recent.push({ kind: mail.kind, to: recipients, subject: mail.subject, text: mail.text, attachments: [], at: new Date().toISOString(), ok: false });
    }
  }
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift()!;
    active += 1;
    void run(job).finally(() => {
      active -= 1;
      pump();
    });
  }
}

/**
 * Queues a message and returns immediately. Delivery happens in the background with up to three
 * attempts, and a failure is logged but never reaches the request that triggered it.
 */
export function sendMail(mail: OutgoingMail) {
  const to = toList(mail.to);
  if (!to.length) return;
  queue.push({ mail: { ...mail, to }, attempt: 0 });
  pump();
}

/** Resolves once everything queued so far has been delivered or has given up. Used by tests and shutdown. */
export async function flushMail(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while ((queue.length || active) && Date.now() < deadline) await sleep(5);
}

/** Checks the SMTP login without sending anything. Safe to call at startup. */
export async function verifyMail(): Promise<boolean> {
  if (mode !== 'smtp') {
    stats.verified = null;
    return false;
  }
  try {
    await transport.verify();
    stats.verified = true;
    stats.lastError = undefined;
    return true;
  } catch (err) {
    stats.verified = false;
    stats.lastError = err instanceof Error ? err.message : String(err);
    return false;
  }
}

export const mailStatus = (): MailStatus => ({
  mode,
  transport: label,
  from: config.MAIL_FROM,
  verified: stats.verified,
  queued: queue.length + active,
  sent: stats.sent,
  failed: stats.failed,
  lastError: stats.lastError,
  lastSentAt: stats.lastSentAt,
});
