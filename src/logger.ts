import { pino } from 'pino';
import { config, isTest } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL ?? (isTest ? 'silent' : config.NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: ['req.headers.authorization', 'req.body.password', 'req.body.payment', 'req.body.bankAccount', 'req.body.mtnNumber', 'req.body.airtelNumber'],
});
