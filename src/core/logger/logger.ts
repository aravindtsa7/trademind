import { createLogger, format, transports } from 'winston';
import { config } from '../config/env';

const maximumRedactionDepth = 6;
const maximumCollectionEntries = 100;
const secretKey = /authorization|bearer|(^|[_-])token$|access.?token|refresh.?token|api.?key|secret|password|cookie/i;
const unsafeObjectKey = /request|socket|connection|agent|stream|client/i;

function redactText(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)\S+/gi, '$1[REDACTED]')
    .replace(/bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/(access[_-]?token\s*[:=]\s*)\S+/gi, '$1[REDACTED]');
}

/**
 * Log sanitization must be safer than the objects it receives. Axios errors,
 * WebSockets, and Node requests commonly contain cycles; never hand those to
 * JSON formatting or recursively traverse them without a bound.
 */
export function redactLogValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= maximumRedactionDepth) return '[MAX_LOG_DEPTH]';
  if (seen.has(value)) return '[CIRCULAR_REFERENCE]';
  seen.add(value);

  if (value instanceof Error) {
    const candidate = value as Error & { code?: unknown; status?: unknown; response?: { status?: unknown }; cause?: unknown };
    const error: Record<string, unknown> = {
      name: redactText(candidate.name || 'Error'),
      message: redactText(candidate.message || ''),
    };
    if (candidate.code !== undefined) error.code = redactLogValue(candidate.code, seen, depth + 1);
    const status = candidate.status ?? candidate.response?.status;
    if (status !== undefined) error.status = status;
    if (candidate.stack) error.stack = redactText(candidate.stack);
    if (candidate.cause !== undefined) error.cause = redactLogValue(candidate.cause, seen, depth + 1);
    return error;
  }
  if (Array.isArray(value)) return value.slice(0, maximumCollectionEntries).map((entry) => redactLogValue(entry, seen, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, maximumCollectionEntries)) {
    if (secretKey.test(key)) output[key] = '[REDACTED]';
    else if (unsafeObjectKey.test(key)) output[key] = '[OMITTED_UNSAFE_OBJECT]';
    else output[key] = redactLogValue(child, seen, depth + 1);
  }
  return output;
}

const redactSecrets = format((info) => Object.assign(info, redactLogValue(info) as object));

const logger = createLogger({
  level: config.environment === 'production' ? 'info' : 'debug',
  defaultMeta: { service: 'trademind-backend' },
  format: format.combine(
    format.errors({ stack: true }),
    format.splat(),
    redactSecrets(),
    format.timestamp(),
    format.json()
  ),
  transports: [new transports.Console()],
});

export default logger;
