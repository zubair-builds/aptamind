import { pino, type DestinationStream, type Logger as PinoLogger, type LoggerOptions } from 'pino';
import { currentCorrelation } from './context';

export type Logger = PinoLogger;

export interface CreateLoggerOptions {
  service: string;
  level?: string;
  pretty?: boolean;
  destination?: NodeJS.WritableStream;
}

/** Keys that must never be logged in clear text. */
const REDACT_PATHS = [
  'password',
  '*.password',
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
  'authorization',
  '*.authorization',
  'headers.authorization',
  'headers.cookie',
  '*.headers.authorization',
  '*.headers.cookie',
  'accessKeyId',
  'secretAccessKey',
  '*.secretAccessKey',
  'token',
  '*.token',
];

export function createLogger(opts: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    name: opts.service,
    level: opts.level ?? 'info',
    base: { service: opts.service },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Correlation IDs (requestId, workflowRunId, nodeRunId, sourceId, ...) are attached
    // automatically from the async context.
    mixin: () => ({ ...currentCorrelation() }),
    formatters: {
      level: (label) => ({ level: label }),
    },
  };
  if (opts.destination) return pino(options, opts.destination as DestinationStream);
  return pino(options);
}

/** Silent logger for tests. */
export function createNullLogger(): Logger {
  return pino({ level: 'silent' });
}
