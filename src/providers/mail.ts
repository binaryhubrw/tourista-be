import nodemailer from 'nodemailer';
import { config, isProd } from '../config.js';
import { logger } from '../logger.js';

const transport = config.SMTP_URL ? nodemailer.createTransport(config.SMTP_URL) : nodemailer.createTransport({ jsonTransport: true });

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** Fire-and-forget: a failed email must never fail the request that triggered it. */
export async function sendMail(mail: Mail) {
  try {
    const info = await transport.sendMail({ from: config.MAIL_FROM, ...mail });
    // Without SMTP, dev logs the body so reset links can be copied. Production never logs bodies (they hold tokens).
    if (!config.SMTP_URL) logger.warn({ to: mail.to, subject: mail.subject, ...(isProd ? {} : { body: mail.text }) }, 'email not sent: SMTP_URL is empty');
    else logger.info({ to: mail.to, id: info.messageId }, 'email sent');
  } catch (err) {
    logger.error({ err, to: mail.to }, 'email failed');
  }
}
