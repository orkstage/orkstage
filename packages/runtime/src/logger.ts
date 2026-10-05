import { pino, type LoggerOptions } from 'pino';

/** Paths that must never reach logs (spec §54). */
export const REDACT_PATHS = [
  'password',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'clientSecret',
  'credentials',
  'privateKey',
  '*.password',
  '*.secret',
  '*.token',
  '*.clientSecret',
  '*.credentials',
  '*.privateKey',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

export function loggerOptions(service: string, level: string): LoggerOptions {
  return {
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label.toUpperCase() }) },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  };
}

export function createLogger(service: string, level = 'info') {
  return pino(loggerOptions(service, level));
}
